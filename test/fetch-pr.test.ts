import { describe, expect, it } from "vitest";
import {
  GithubError,
  fetchPr,
  fetchRawFile,
  findPrUrl
} from "../src/checker/github";

type Route = (req: Request) => Response;

function fakeFetch(routes: Record<string, Route>, seen: Request[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    const url = new URL(req.url);
    const route = routes[url.pathname + url.search];
    return route ? route(req) : new Response("missing", { status: 500 });
  }) as typeof fetch;
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });

const pr = {
  title: "Add login",
  body: null,
  html_url: "https://github.com/o/r/pull/7",
  head: { sha: "abc" },
  base: { ref: "main" }
};

const fileJson = (i: number) => ({
  filename: `src/f${i}.ts`,
  status: "modified",
  sha: `sha${i}`,
  additions: 1,
  deletions: 0,
  patch: "@@ -1 +1 @@\n-a\n+b"
});

const ref = { owner: "o", repo: "r", number: 7 };

describe("fetchPr", () => {
  it("reads metadata and pages through the file list", async () => {
    const seen: Request[] = [];
    const fetch = fakeFetch(
      {
        "/repos/o/r/pulls/7": () => ok(pr),
        "/repos/o/r/pulls/7/files?per_page=100&page=1": () =>
          ok(Array.from({ length: 100 }, (_, i) => fileJson(i))),
        "/repos/o/r/pulls/7/files?per_page=100&page=2": () =>
          ok([
            fileJson(100),
            { ...fileJson(101), patch: undefined, previous_filename: "old.ts" }
          ])
      },
      seen
    );
    const result = await fetchPr(ref, { fetch, token: "t" });
    expect(result).toMatchObject({
      title: "Add login",
      body: "",
      headSha: "abc",
      baseRef: "main",
      fileListTruncated: false
    });
    expect(result.files).toHaveLength(102);
    expect(result.files[101]).toMatchObject({
      patch: null,
      previousPath: "old.ts"
    });
    expect(seen[0].headers.get("authorization")).toBe("Bearer t");
    expect(seen[0].headers.get("accept")).toBe("application/vnd.github+json");
  });

  it("flags a file list cut at the page cap", async () => {
    const page = () => ok(Array.from({ length: 100 }, (_, i) => fileJson(i)));
    const fetch = fakeFetch({
      "/repos/o/r/pulls/7": () => ok(pr),
      "/repos/o/r/pulls/7/files?per_page=100&page=1": page,
      "/repos/o/r/pulls/7/files?per_page=100&page=2": page,
      "/repos/o/r/pulls/7/files?per_page=100&page=3": page
    });
    const result = await fetchPr(ref, { fetch });
    expect(result.files).toHaveLength(300);
    expect(result.fileListTruncated).toBe(true);
  });

  it("maps 404 and the rate limit to typed errors", async () => {
    const missing = fakeFetch({
      "/repos/o/r/pulls/7": () => new Response("", { status: 404 })
    });
    await expect(fetchPr(ref, { fetch: missing })).rejects.toMatchObject({
      kind: "not_found"
    });

    const limited = fakeFetch({
      "/repos/o/r/pulls/7": () =>
        new Response("", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000"
          }
        })
    });
    const error = await fetchPr(ref, { fetch: limited }).catch((e) => e);
    expect(error).toBeInstanceOf(GithubError);
    expect(error.kind).toBe("rate_limited");
    expect(error.resetAt?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(error.message).toContain("GITHUB_TOKEN");
  });
});

describe("findPrUrl", () => {
  it("finds the first pull request link in a message", () => {
    expect(findPrUrl("check https://github.com/o/r/pull/3) please")).toBe(
      "https://github.com/o/r/pull/3"
    );
    expect(
      findPrUrl(
        "see https://github.com/o/r/issues/3 and https://github.com/o/r/pull/4"
      )
    ).toBe("https://github.com/o/r/pull/4");
    expect(findPrUrl("no link")).toBeNull();
  });
});

describe("fetchRawFile", () => {
  const at = "/o/r/abc/src/a%20b.ts";
  it("reads a text file at the head commit with the path encoded", async () => {
    const seen: Request[] = [];
    const fetch = fakeFetch(
      { [at]: () => new Response("const a = 1;\n") },
      seen
    );
    const out = await fetchRawFile(ref, "abc", "src/a b.ts", {
      fetch,
      token: "t"
    });
    expect(out).toEqual({ ok: true, text: "const a = 1;\n" });
    expect(seen[0].url).toBe(
      "https://raw.githubusercontent.com/o/r/abc/src/a%20b.ts"
    );
    expect(seen[0].headers.get("authorization")).toBe("Bearer t");
  });

  it("reports missing, binary and oversized files instead of throwing", async () => {
    const missing = fakeFetch({
      [at]: () => new Response("", { status: 404 })
    });
    expect(
      await fetchRawFile(ref, "abc", "src/a b.ts", { fetch: missing })
    ).toEqual({
      ok: false,
      reason: "not found"
    });
    const binary = fakeFetch({
      [at]: () => new Response(new Uint8Array([0x89, 0x50, 0x00, 0x47]))
    });
    expect(
      await fetchRawFile(ref, "abc", "src/a b.ts", { fetch: binary })
    ).toEqual({
      ok: false,
      reason: "binary"
    });
    const big = fakeFetch({
      [at]: () =>
        new Response("x", { headers: { "content-length": "2000000" } })
    });
    expect(
      await fetchRawFile(ref, "abc", "src/a b.ts", { fetch: big })
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^over /)
    });
  });

  it("maps a rate limit on the raw host to the same typed error", async () => {
    const limited = fakeFetch({
      [at]: () =>
        new Response("", {
          status: 429,
          headers: { "x-ratelimit-remaining": "0" }
        })
    });
    await expect(
      fetchRawFile(ref, "abc", "src/a b.ts", { fetch: limited })
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });
});
