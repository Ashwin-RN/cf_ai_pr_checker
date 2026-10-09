import { describe, expect, it } from "vitest";
import {
  type CheckDeps,
  type CheckInput,
  assemble,
  countCalls,
  fetchStage,
  fileStage,
  mapLimit,
  progressFor,
  resolveRuleSet,
  runCheck,
  settleStage
} from "../src/checker";
import type { JsonCaller } from "../src/checker/model";
import { fitFiles } from "../src/checker/select";
import type { PrFile, ProgressFile } from "../src/checker/types";
import { rule } from "./fixtures";

type Route = (req: Request) => Response;

function fakeFetch(routes: Record<string, Route>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const route = routes[url.pathname + url.search];
    return route ? route(req) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const prJson = {
  title: "Add greeting",
  body: "Adds a greeting.",
  html_url: "https://github.com/o/r/pull/7",
  head: { sha: "abc" },
  base: { ref: "main" }
};

const fileJson = (path: string) => ({
  filename: path,
  status: "modified",
  sha: "sha",
  additions: 1,
  deletions: 0,
  patch: "@@ -1,2 +1,3 @@\n const a = 1;\n+console.log(a);\n export { a };"
});

const content = "const a = 1;\nconsole.log(a);\nexport { a };\n";

const routes: Record<string, Route> = {
  "/repos/o/r/pulls/7": () => ok(prJson),
  "/repos/o/r/pulls/7/files?per_page=100&page=1": () =>
    ok([fileJson("src/a.ts"), fileJson("src/b.ts")]),
  "/o/r/abc/src/a.ts": () => new Response(content),
  "/o/r/abc/src/b.ts": () => new Response(content)
};

// Every model call fails, so the stages are driven without a model and the
// result still has every section.
const failing: JsonCaller = async () => ({
  ok: false,
  error: "model error: none today",
  raw: null
});

const ruleSet = { rules: [rule(1, "No console.log")], hash: "h1", source: "t" };

const deps: CheckDeps = {
  fetch: fakeFetch(routes),
  callJson: failing,
  now: () => 1_000,
  resolveRules: async () => ruleSet
};

const input: CheckInput = {
  id: "c1",
  workspace: "ws",
  prUrl: "https://github.com/o/r/pull/7",
  rules: null,
  strict: false,
  previous: null
};

describe("stages", () => {
  it("composed one by one, produce what runCheck produces", async () => {
    const fetched = await fetchStage(input.prUrl, deps);
    const rules = await resolveRuleSet(input, fetched.pr, deps);
    const counted = countCalls(deps.callJson);
    // The Workflow strips diffs from the file list; each file keeps its own.
    const pr = {
      ...fetched.pr,
      files: fetched.pr.files.map((f) => ({ ...f, patch: null }))
    };
    const results = await mapLimit(fetched.checked, 2, (file) =>
      fileStage(rules.rules, pr, file, counted.callJson, deps)
    );
    const settled = await settleStage(
      rules.rules,
      pr,
      results,
      counted.callJson
    );
    const composed = assemble({
      input,
      pr,
      ruleSet: rules,
      results,
      notChecked: fetched.notChecked,
      crossFile: settled.crossFile,
      intent: settled.intent,
      modelCalls: counted.calls(),
      startedAt: 1_000,
      finishedAt: 1_000
    });
    const direct = await runCheck(input, deps);
    expect(composed).toEqual(direct);
    expect(direct.files.map((f) => f.state)).toEqual(["failed", "failed"]);
    expect(direct.status).toBe("unsure");
    expect(direct.modelCalls).toBe(composed.modelCalls);
  });

  it("names the rules failure instead of guessing", async () => {
    await expect(
      resolveRuleSet(input, (await fetchStage(input.prUrl, deps)).pr, {
        ...deps,
        resolveRules: async () => null
      })
    ).rejects.toMatchObject({ kind: "no_rules" });
  });

  it("counts model calls per caller, retries included", async () => {
    const retried: JsonCaller = async () => ({
      ok: false,
      error: "twice",
      raw: null,
      calls: 2
    });
    const counted = countCalls(retried);
    await counted.callJson([], null as never);
    await counted.callJson([], null as never);
    expect(counted.calls()).toBe(4);
    const plain = countCalls(failing);
    await plain.callJson([], null as never);
    expect(plain.calls()).toBe(1);
  });

  it("adds the rules' own interpretation calls to the total", async () => {
    const plain = await runCheck(input, deps);
    const interpreted = await runCheck(input, {
      ...deps,
      resolveRules: async () => ({ ...ruleSet, calls: 1 })
    });
    expect(interpreted.modelCalls).toBe(plain.modelCalls + 1);
  });

  it("snapshots progress so later changes do not leak into it", () => {
    const files: ProgressFile[] = [{ path: "a", state: "queued" }];
    const snap = progressFor("c1", "checking", "m", files);
    files[0].state = "checked";
    expect(snap.files[0].state).toBe("queued");
  });
});

describe("fitFiles", () => {
  const big = (path: string): PrFile => ({
    path,
    previousPath: null,
    status: "modified",
    sha: "s",
    additions: 1,
    deletions: 0,
    patch: "+".repeat(400)
  });

  it("keeps the files that fit, in order, and names the rest as a gap", () => {
    const files = [big("a"), big("b"), big("c")];
    const fit = fitFiles(files, 1_100);
    expect(fit.checked.map((f) => f.path)).toEqual(["a", "b"]);
    expect(fit.dropped).toEqual([
      {
        path: "c",
        reason: "over the size budget of one Workflow step",
        coverage: true
      }
    ]);
  });

  it("drops nothing under the budget", () => {
    const fit = fitFiles([big("a")], 10_000);
    expect(fit.checked).toHaveLength(1);
    expect(fit.dropped).toEqual([]);
  });
});
