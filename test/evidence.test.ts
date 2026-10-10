import { describe, expect, it } from "vitest";
import {
  type CheckDeps,
  evidenceRequests,
  readEvidence,
  runCheck
} from "../src/checker";
import { limits } from "../src/checker/limits";
import { ACROSS_FILES, buildFindings, stableKey } from "../src/checker/merge";
import type { ChatMessage, JsonCaller } from "../src/checker/model";
import {
  evidenceSchema,
  fileOutputSchema,
  settleSchema
} from "../src/checker/prompts";
import { machineReport, renderReport } from "../src/checker/report";
import {
  collectFacts,
  evidencePathFrom,
  factsCut,
  settleCrossFile
} from "../src/checker/settle";
import type {
  CrossFileVerdict,
  EvidenceFile,
  Finding,
  Pr,
  PreviousRun,
  Progress,
  Rule,
  RuleSet
} from "../src/checker/types";
import { previousRunOf, readResult } from "../src/store";
import { file, result, rule, verdict } from "./fixtures";

const pr: Pr = {
  owner: "o",
  repo: "r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Add parseId",
  body: "",
  headSha: "abc",
  baseRef: "main",
  files: [
    {
      path: "src/parse.ts",
      previousPath: null,
      status: "added",
      sha: "1",
      additions: 3,
      deletions: 0,
      patch:
        "@@ -0,0 +1,3 @@\n+export function parseId(s: string) {\n+  return Number(s);\n+}"
    }
  ],
  fileListTruncated: false
};

const spanning: Rule = {
  ...rule(
    2,
    "Every new exported function under src/ has a test under test/",
    "must"
  ),
  scope: "cross_file"
};
const rules = [rule(1, "No console.log"), spanning];
const ruleSet: RuleSet = { rules, hash: "h1", source: "t" };

const read: EvidenceFile = {
  rule: 2,
  path: "test/parse.test.ts",
  state: "read",
  facts: ["tests parseId", "imports src/parse.ts"],
  reason: null
};
const missing: EvidenceFile = {
  rule: 2,
  path: "test/parse.test.ts",
  state: "missing",
  facts: [],
  reason: null
};

describe("evidencePathFrom", () => {
  it("keeps a relative path inside the repository, tidied", () => {
    expect(evidencePathFrom("test/parse.test.ts", pr)).toBe(
      "test/parse.test.ts"
    );
    expect(evidencePathFrom(" ./test/parse.test.ts ", pr)).toBe(
      "test/parse.test.ts"
    );
    expect(evidencePathFrom("`test/parse.test.ts`", pr)).toBe(
      "test/parse.test.ts"
    );
    expect(evidencePathFrom("package.json", pr)).toBe("package.json");
  });

  it("drops anything the next check could not or should not read", () => {
    for (const raw of [
      undefined,
      "",
      "/etc/passwd",
      "../secrets.env",
      "test/../../x.ts",
      "src/parse.ts",
      "a file.ts",
      "C:\\x.ts",
      "https://example.com/x.ts",
      "test/",
      "x".repeat(limits.evidencePathChars + 1)
    ]) {
      expect(evidencePathFrom(raw, pr)).toBeNull();
    }
    // A file this run already read did not settle the rule.
    expect(evidencePathFrom("test/parse.test.ts", pr, [read])).toBeNull();
  });
});

describe("facts from requested evidence", () => {
  const files = [
    file("src/parse.ts", [verdict(2, "UNSURE")], {
      facts: ["adds exported function parseId"]
    })
  ];

  it("lists what a requested file holds, or that it is missing or unreadable, after the file facts", () => {
    const texts = collectFacts(pr, files, [
      read,
      missing,
      { ...read, state: "read", facts: [] },
      { ...read, state: "unreadable", facts: [], reason: "binary" },
      { ...read, state: "failed", facts: [], reason: "model error: none" }
    ]).map((f) => f.text);
    expect(texts).toEqual([
      "added file src/parse.ts",
      "src/parse.ts: adds exported function parseId",
      "requested evidence for rule 2, test/parse.test.ts (not changed by this pull request): tests parseId",
      "requested evidence for rule 2, test/parse.test.ts (not changed by this pull request): imports src/parse.ts",
      "requested evidence for rule 2: test/parse.test.ts does not exist at the head commit",
      "requested evidence for rule 2: test/parse.test.ts exists but reported nothing that bears on the rule",
      "requested evidence for rule 2: test/parse.test.ts could not be read (binary)",
      "requested evidence for rule 2: test/parse.test.ts could not be read (model error: none)"
    ]);
    expect(factsCut(pr, files, [read])).toBe(false);
    const many: EvidenceFile = {
      ...read,
      facts: Array.from({ length: limits.factsPerSettle }, (_, i) => `f${i}`)
    };
    expect(factsCut(pr, files, [many])).toBe(true);
  });
});

function settleCaller(out: unknown) {
  const prompts: ChatMessage[][] = [];
  const call: JsonCaller = async (messages) => {
    prompts.push(messages);
    return { ok: true, value: out as never, raw: "" };
  };
  return { call, prompts };
}

const settled = (verdict: string, extra: Record<string, unknown> = {}) => ({
  verdicts: [
    {
      rule: 1,
      verdict,
      facts: [1],
      reason: "r",
      why: "w",
      steps: ["s"],
      resolution: "res",
      question: "Is parseId tested?",
      ...extra
    }
  ]
});

describe("settleCrossFile with evidence", () => {
  const files = [
    file("src/parse.ts", [verdict(2, "UNSURE")], {
      facts: ["adds exported function parseId"]
    })
  ];

  it("asks for the file that would settle an UNSURE verdict, and only then", async () => {
    const facts = collectFacts(pr, files);
    const asked = await settleCrossFile(
      rules,
      pr,
      files,
      facts,
      settleCaller(settled("UNSURE", { evidence_path: "test/parse.test.ts" }))
        .call
    );
    expect(asked[0]).toMatchObject({
      verdict: "UNSURE",
      evidencePath: "test/parse.test.ts"
    });
    const passed = await settleCrossFile(
      rules,
      pr,
      files,
      facts,
      settleCaller(settled("PASS", { evidence_path: "test/parse.test.ts" }))
        .call
    );
    expect(passed[0]).toMatchObject({ verdict: "PASS", evidencePath: null });
    const silent = await settleCrossFile(
      rules,
      pr,
      files,
      facts,
      settleCaller(settled("UNSURE")).call
    );
    expect(silent[0].evidencePath).toBeNull();
  });

  it("shows the settle step what the requested file gave, and does not ask for it again", async () => {
    const { call, prompts } = settleCaller(
      settled("UNSURE", { evidence_path: "test/parse.test.ts" })
    );
    const facts = collectFacts(pr, files, [read]);
    const out = await settleCrossFile(rules, pr, files, facts, call, [read]);
    expect(prompts[0][1].content).toContain(
      "[2] requested evidence for rule 2, test/parse.test.ts (not changed by this pull request): tests parseId"
    );
    expect(prompts[0][0].content).toContain('marked "requested evidence"');
    expect(out[0].evidencePath).toBeNull();
  });
});

describe("evidenceRequests", () => {
  const previous = (
    findings: Array<Partial<PreviousRun["findings"][number]>>,
    rulesHash = "h1"
  ): PreviousRun => ({
    checkId: "c0",
    headSha: "abc",
    rulesHash,
    findings: findings.map((f, i) => ({
      id: `Q${i + 1}`,
      key: `k${i}`,
      kind: "question",
      rule: 2,
      path: ACROSS_FILES,
      line: null,
      quote: null,
      summary: "s",
      ...f
    }))
  });

  it("reads what the last check asked for, once per path, up to the cap", () => {
    const out = evidenceRequests(
      previous([
        { evidence: "test/parse.test.ts" },
        { evidence: "test/parse.test.ts", rule: 2 },
        { evidence: "test/other.test.ts" },
        { evidence: null },
        { evidence: "src/parse.ts" },
        { evidence: "test/gone.test.ts", rule: 9 },
        { evidence: "test/a.ts" },
        { evidence: "test/b.ts" }
      ]),
      ruleSet,
      pr
    );
    expect(out).toEqual([
      { rule: 2, path: "test/parse.test.ts" },
      { rule: 2, path: "test/other.test.ts" },
      { rule: 2, path: "test/a.ts" }
    ]);
    expect(out).toHaveLength(limits.evidenceFilesPerCheck);
  });

  it("asks for nothing without a last run, or once the rules have changed", () => {
    expect(evidenceRequests(null, ruleSet, pr)).toEqual([]);
    expect(
      evidenceRequests(
        previous([{ evidence: "test/parse.test.ts" }], "older"),
        ruleSet,
        pr
      )
    ).toEqual([]);
  });
});

type Route = (req: Request) => Response;

function fakeFetch(routes: Record<string, Route>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const route = routes[url.pathname + url.search];
    return route ? route(req) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

const request = { rule: 2, path: "test/parse.test.ts" };

describe("readEvidence", () => {
  const facts = (out: unknown) => {
    const prompts: ChatMessage[][] = [];
    const call: JsonCaller = async (messages) => {
      prompts.push(messages);
      return out === null
        ? { ok: false, error: "model error: none", raw: null }
        : { ok: true, value: out as never, raw: "" };
    };
    return { call, prompts };
  };

  it("reads the file at the head commit and keeps its facts, trimmed and capped", async () => {
    const { call, prompts } = facts({
      facts: [
        " tests parseId ",
        "tests parseId",
        "",
        ...Array.from({ length: 10 }, (_, i) => `fact ${i}`)
      ]
    });
    const deps: CheckDeps = {
      fetch: fakeFetch({
        "/o/r/abc/test/parse.test.ts": () =>
          new Response("test('parseId', () => {});")
      }),
      callJson: call
    };
    const out = await readEvidence(rules, pr, request, call, deps);
    expect(out.state).toBe("read");
    expect(out.facts[0]).toBe("tests parseId");
    expect(out.facts).toHaveLength(limits.evidenceFacts);
    expect(out.reason).toBeNull();
    expect(prompts[0][1].content).toContain("File: test/parse.test.ts");
    expect(prompts[0][1].content).toContain("test('parseId'");
    expect(prompts[0][0].content).toContain("Do not judge the rule");
  });

  it("reports a missing file as missing, without a model call", async () => {
    const { call, prompts } = facts({ facts: [] });
    const out = await readEvidence(rules, pr, request, call, {
      fetch: fakeFetch({}),
      callJson: call
    });
    expect(out).toEqual({ ...missing });
    expect(prompts).toHaveLength(0);
  });

  it("tells a file it cannot read, a model that fails, and a cut file apart", async () => {
    const { call } = facts({ facts: ["x"] });
    const binary = await readEvidence(rules, pr, request, call, {
      fetch: fakeFetch({
        "/o/r/abc/test/parse.test.ts": () =>
          new Response(new Uint8Array([0, 1, 2]))
      }),
      callJson: call
    });
    expect(binary).toMatchObject({ state: "unreadable", reason: "binary" });
    const failing = facts(null);
    const failed = await readEvidence(rules, pr, request, failing.call, {
      fetch: fakeFetch({
        "/o/r/abc/test/parse.test.ts": () => new Response("x")
      }),
      callJson: failing.call
    });
    expect(failed).toMatchObject({
      state: "failed",
      reason: "model error: none"
    });
    const big = facts({ facts: ["x"] });
    const cut = await readEvidence(rules, pr, request, big.call, {
      fetch: fakeFetch({
        "/o/r/abc/test/parse.test.ts": () =>
          new Response("y".repeat(limits.charsPerModelCall + 10))
      }),
      callJson: big.call
    });
    expect(cut).toMatchObject({ state: "read", reason: "cut at the size cap" });
    expect(big.prompts[0][1].content).toContain("cut at the size cap");
    const gone = await readEvidence(rules, pr, { rule: 9, path: "x" }, call, {
      fetch: fakeFetch({}),
      callJson: call
    });
    expect(gone.state).toBe("failed");
  });
});

describe("the request on the finding, in the report and across runs", () => {
  const asked: CrossFileVerdict = {
    rule: 2,
    verdict: "UNSURE",
    facts: [{ index: 1, path: "src/parse.ts", text: "adds parseId" }],
    reason: "No fact shows a test for parseId.",
    why: "Tests catch regressions.",
    steps: ["Add a test."],
    resolution: "a test under test/ that calls parseId",
    question: "Is parseId tested?",
    note: null,
    evidencePath: "test/parse.test.ts"
  };

  it("puts the requested file on the question, never on a blocking item", () => {
    const files = [file("src/parse.ts", [verdict(2, "UNSURE")])];
    const q = buildFindings(rules, files, [asked]);
    expect(q[0]).toMatchObject({
      kind: "question",
      path: ACROSS_FILES,
      evidence: "test/parse.test.ts"
    });
    const f = buildFindings(rules, files, [{ ...asked, verdict: "FAIL" }]);
    expect(f[0]).toMatchObject({ kind: "blocking", evidence: null });
  });

  it("renders the request and what the last request gave", () => {
    const q: Finding = {
      ...buildFindings(
        rules,
        [file("src/parse.ts", [verdict(2, "UNSURE")])],
        [asked]
      )[0],
      change: "open"
    };
    const r = result({
      status: "unsure",
      rules,
      findings: [q],
      crossFile: [asked],
      evidence: [{ ...read, path: "test/old.test.ts" }, missing],
      pr: { ...result().pr, headSha: "abc1234567" }
    });
    const md = renderReport(r, { json: true });
    expect(md).toContain(
      "**Evidence read:** `test/old.test.ts` was read this run: tests parseId; imports src/parse.ts."
    );
    expect(md).toContain(
      "**Evidence read:** `test/parse.test.ts` does not exist at `abc1234`."
    );
    expect(md).toContain(
      "**Evidence requested:** `test/parse.test.ts`. The next check of this pull request reads it"
    );
    const m = machineReport(r) as {
      evidence: EvidenceFile[];
      cross_file: Array<{ evidence_path: string | null }>;
      findings: Finding[];
    };
    expect(m.evidence).toHaveLength(2);
    expect(m.cross_file[0].evidence_path).toBe("test/parse.test.ts");
    expect(m.findings[0].evidence).toBe("test/parse.test.ts");
    // The next run reads the request from the previous run's findings.
    expect(previousRunOf(r).findings[0].evidence).toBe("test/parse.test.ts");
    const old = JSON.stringify(r, (key, value) =>
      ["evidence", "evidencePath"].includes(key) ? undefined : value
    );
    const filled = readResult(old);
    expect(filled.evidence).toEqual([]);
    expect(filled.findings[0].evidence).toBeNull();
    expect(filled.crossFile[0].evidencePath).toBeNull();
  });
});

describe("runCheck reads what the last check asked for", () => {
  const prJson = {
    title: "Add parseId",
    body: "",
    html_url: pr.url,
    head: { sha: "abc" },
    base: { ref: "main" }
  };
  const fileJson = {
    filename: "src/parse.ts",
    status: "added",
    sha: "1",
    additions: 3,
    deletions: 0,
    patch: pr.files[0].patch
  };
  const content =
    "export function parseId(s: string) {\n  return Number(s);\n}\n";
  const previous: PreviousRun = {
    checkId: "c0",
    headSha: "abc",
    rulesHash: "h1",
    findings: [
      {
        id: "Q1",
        key: stableKey([2, ACROSS_FILES]),
        kind: "question",
        rule: 2,
        path: ACROSS_FILES,
        line: null,
        quote: null,
        summary: "No fact shows a test for parseId.",
        evidence: "test/parse.test.ts"
      }
    ]
  };

  // The model, by the schema it is asked for: the file check, the facts of
  // a requested file, and the settle step, which answers from what it sees.
  function model(verdictFor: (facts: string) => string) {
    const settlePrompts: string[] = [];
    let evidenceCalls = 0;
    const call: JsonCaller = async (messages, schema) => {
      const user = messages[1].content;
      if ((schema as unknown) === fileOutputSchema) {
        return {
          ok: true,
          raw: "",
          value: {
            purpose: "parses ids",
            verdicts: [
              {
                rule: 1,
                verdict: "PASS",
                quote: "",
                reason: "no log",
                why: "",
                steps: [],
                resolution: "",
                question: ""
              },
              {
                rule: 2,
                verdict: "UNSURE",
                quote: "",
                reason: "no test here",
                why: "w",
                steps: ["s"],
                resolution: "a test",
                question: "Is parseId tested?"
              }
            ],
            facts: ["adds exported function parseId"],
            warnings: []
          } as never
        };
      }
      if ((schema as unknown) === evidenceSchema) {
        evidenceCalls++;
        return {
          ok: true,
          raw: "",
          value: { facts: ["tests parseId"] } as never
        };
      }
      if ((schema as unknown) === settleSchema) {
        settlePrompts.push(user);
        const verdict = verdictFor(user);
        return {
          ok: true,
          raw: "",
          value: {
            verdicts: [
              {
                rule: 1,
                verdict,
                facts: [1, 2],
                reason:
                  verdict === "FAIL"
                    ? "parseId is new and its test file does not exist."
                    : "parseId is tested.",
                why: "w",
                steps: ["s"],
                resolution: "res",
                question: ""
              }
            ]
          } as never
        };
      }
      throw new Error("unexpected call");
    };
    return { call, settlePrompts, evidenceCalls: () => evidenceCalls };
  }

  const run = (
    rawFile: Route | null,
    m: ReturnType<typeof model>,
    progress: Progress[]
  ) =>
    runCheck(
      {
        id: "c1",
        workspace: "ws",
        prUrl: pr.url,
        rules: ruleSet,
        previous
      },
      {
        fetch: fakeFetch({
          "/repos/o/r/pulls/7": () =>
            new Response(JSON.stringify(prJson), { status: 200 }),
          "/repos/o/r/pulls/7/files?per_page=100&page=1": () =>
            new Response(JSON.stringify([fileJson]), { status: 200 }),
          "/o/r/abc/src/parse.ts": () => new Response(content),
          ...(rawFile ? { "/o/r/abc/test/parse.test.ts": rawFile } : {})
        }),
        callJson: m.call,
        now: () => 1,
        onProgress: (p) => progress.push(p)
      }
    );

  it("turns a missing requested file into the absence the settle step can fail on", async () => {
    const m = model((facts) =>
      facts.includes("does not exist") ? "FAIL" : "UNSURE"
    );
    const progress: Progress[] = [];
    const r = await run(null, m, progress);
    expect(m.evidenceCalls()).toBe(0);
    expect(m.settlePrompts[0]).toContain(
      "[2] requested evidence for rule 2: test/parse.test.ts does not exist at the head commit"
    );
    expect(r.evidence).toEqual([missing]);
    expect(r.status).toBe("fail");
    expect(r.ruleStatuses[1]).toMatchObject({ status: "FAIL", blocking: true });
    // The question became the blocking item under the same key.
    expect(r.findings[0]).toMatchObject({
      kind: "blocking",
      path: ACROSS_FILES,
      change: "open",
      evidence: null
    });
    expect(
      progress.some((p) =>
        p.files.some(
          (f) => f.path === "test/parse.test.ts" && f.role === "evidence"
        )
      )
    ).toBe(true);
    expect(renderReport(r, { json: false })).toContain(
      "**Evidence read:** `test/parse.test.ts` does not exist at `abc`."
    );
    expect(r.modelCalls).toBe(2);
  });

  it("reads a requested file that exists and lets the settle step pass on its facts", async () => {
    const m = model((facts) =>
      facts.includes("tests parseId") ? "PASS" : "UNSURE"
    );
    const progress: Progress[] = [];
    const r = await run(
      () => new Response("test('parseId', () => {});"),
      m,
      progress
    );
    expect(m.evidenceCalls()).toBe(1);
    expect(r.evidence[0]).toMatchObject({
      state: "read",
      facts: ["tests parseId"]
    });
    expect(r.status).toBe("pass");
    expect(r.previous).toMatchObject({ new: 0, open: 0 });
    expect(r.previous?.resolved.map((f) => f.id)).toEqual(["Q1"]);
    expect(r.modelCalls).toBe(3);
  });
});
