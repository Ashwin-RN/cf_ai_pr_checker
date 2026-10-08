import { describe, expect, it } from "vitest";
import { parsePrUrl } from "../src/checker/github";

describe("parsePrUrl", () => {
  it("parses a plain pull request link", () => {
    expect(parsePrUrl("https://github.com/cloudflare/agents/pull/123")).toEqual(
      { owner: "cloudflare", repo: "agents", number: 123 }
    );
  });

  it("ignores the tab, trailing slash, query and fragment", () => {
    const expected = { owner: "o", repo: "r", number: 7 };
    expect(parsePrUrl("https://github.com/o/r/pull/7/files")).toEqual(expected);
    expect(parsePrUrl("https://github.com/o/r/pull/7/")).toEqual(expected);
    expect(parsePrUrl("https://github.com/o/r/pull/7?diff=split")).toEqual(
      expected
    );
    expect(parsePrUrl("https://github.com/o/r/pull/7#issuecomment-1")).toEqual(
      expected
    );
  });

  it("accepts www, http and surrounding whitespace", () => {
    expect(parsePrUrl("  http://www.github.com/o/r.js/pull/1  ")).toEqual({
      owner: "o",
      repo: "r.js",
      number: 1
    });
  });

  it("drops a .git suffix on the repository", () => {
    expect(parsePrUrl("https://github.com/o/r.git/pull/2")).toEqual({
      owner: "o",
      repo: "r",
      number: 2
    });
  });

  it("rejects anything that is not a GitHub pull request", () => {
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl("not a url")).toBeNull();
    expect(parsePrUrl("https://gitlab.com/o/r/-/merge_requests/1")).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/issues/1")).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/pull/abc")).toBeNull();
    expect(parsePrUrl("https://github.com/o/r/pull/0")).toBeNull();
    expect(parsePrUrl("https://github.com/o/pull/1")).toBeNull();
    expect(parsePrUrl("ftp://github.com/o/r/pull/1")).toBeNull();
  });
});
