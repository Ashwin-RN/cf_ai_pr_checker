import { describe, expect, it } from "vitest";
import { limits } from "../src/checker/limits";
import type { ChatMessage, JsonCaller } from "../src/checker/model";
import { collectFacts, factsCut, settleCrossFile } from "../src/checker/settle";
import type { Pr, Rule } from "../src/checker/types";
import { file, rule, verdict } from "./fixtures";

const pr: Pr = {
  owner: "o",
  repo: "r",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title: "Add login",
  body: "",
  headSha: "abc",
  baseRef: "main",
  files: [
    {
      path: "src/login.ts",
      previousPath: null,
      status: "added",
      sha: "1",
      additions: 10,
      deletions: 0,
      patch: "@@"
    },
    {
      path: "test/login.test.ts",
      previousPath: "test/old.test.ts",
      status: "renamed",
      sha: "2",
      additions: 5,
      deletions: 0,
      patch: "@@"
    }
  ],
  fileListTruncated: false
};

const files = [
  file(
    "src/login.ts",
    [verdict(2, "UNSURE", { question: "Is login tested?" })],
    {
      facts: ["adds route POST /login", "adds function login"]
    }
  ),
  file("test/login.test.ts", [verdict(2, "UNSURE")], {
    facts: ["adds a test for POST /login"]
  }),
  file("src/broken.ts", [], { state: "failed", facts: ["ignored"] }),
  file("src/x.ts", [verdict(2, "FAIL", { reason: "no test here" })])
];

const crossRule: Rule = {
  ...rule(2, "Every new route has a test", "must"),
  scope: "cross_file"
};
const rules = [rule(1, "No console.log"), crossRule];

describe("collectFacts", () => {
  it("numbers the file list and the facts of checked files", () => {
    expect(
      collectFacts(pr, files).map((f) => [f.index, f.path, f.text])
    ).toEqual([
      [0, "src/login.ts", "added file src/login.ts"],
      [
        1,
        "test/login.test.ts",
        "renamed file test/login.test.ts (renamed from test/old.test.ts)"
      ],
      [2, "src/login.ts", "src/login.ts: adds route POST /login"],
      [3, "src/login.ts", "src/login.ts: adds function login"],
      [
        4,
        "test/login.test.ts",
        "test/login.test.ts: adds a test for POST /login"
      ]
    ]);
  });
});

describe("factsCut", () => {
  it("is true when the files reported more than the settle step can see", () => {
    expect(factsCut(pr, files)).toBe(false);
    const many = [
      file("src/big.ts", [], {
        facts: Array.from(
          { length: limits.factsPerSettle },
          (_, i) => `fact ${i}`
        )
      })
    ];
    expect(factsCut(pr, many)).toBe(true);
  });
});

function caller(out: unknown) {
  const prompts: ChatMessage[][] = [];
  const call: JsonCaller = async (messages) => {
    prompts.push(messages);
    return { ok: true, value: out as never, raw: "" };
  };
  return { call, prompts };
}

const settled = (
  verdict: string,
  facts: number[],
  extra: Record<string, unknown> = {}
) => ({
  verdicts: [
    {
      rule: 2,
      verdict,
      facts,
      reason: "r",
      why: "w",
      steps: ["check test/login.test.ts", "check src/missing.ts"],
      resolution: "res",
      question: "q",
      ...extra
    }
  ]
});

describe("settleCrossFile", () => {
  const facts = collectFacts(pr, files);

  it("asks only about cross-file rules, with the facts and open questions", async () => {
    const { call, prompts } = caller(settled("PASS", [2, 4]));
    const out = await settleCrossFile(rules, pr, files, facts, call);
    expect(prompts).toHaveLength(1);
    const user = prompts[0][1].content;
    expect(user).toContain("2. Every new route has a test");
    expect(user).not.toContain("No console.log");
    expect(user).toContain("[2] src/login.ts: adds route POST /login");
    expect(user).toContain("- rule 2, src/login.ts: Is login tested?");
    expect(user).toContain("- rule 2, test/login.test.ts: because");
    expect(user).toContain("- rule 2, src/x.ts: possible fail: no test here");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 2,
      verdict: "PASS",
      why: "",
      steps: [],
      resolution: null,
      question: null,
      note: null
    });
    expect(out[0].facts.map((f) => f.index)).toEqual([2, 4]);
  });

  it("keeps steps and resolution for a FAIL and marks unknown paths", async () => {
    const { call } = caller(settled("FAIL", [2, 2, 99]));
    const out = await settleCrossFile(rules, pr, files, facts, call);
    expect(out[0]).toMatchObject({
      verdict: "FAIL",
      why: "w",
      resolution: "res",
      question: null,
      steps: [
        "check test/login.test.ts",
        "check src/missing.ts (not in this PR)"
      ]
    });
    expect(out[0].facts.map((f) => f.index)).toEqual([2]);
  });

  it("does not accept a verdict that cites no fact", async () => {
    const { call } = caller(settled("PASS", [99]));
    const out = await settleCrossFile(rules, pr, files, facts, call);
    expect(out[0]).toMatchObject({
      verdict: "UNSURE",
      question: "q",
      note: "the verdict cited no fact, so it is not accepted"
    });
    const na = await settleCrossFile(
      rules,
      pr,
      files,
      facts,
      caller(settled("NA", [])).call
    );
    expect(na[0]).toMatchObject({ verdict: "NA", note: null });
  });

  it("skips the call without cross-file rules or checked files, and survives a failed call", async () => {
    const { call, prompts } = caller(settled("PASS", [0]));
    expect(await settleCrossFile([rules[0]], pr, files, facts, call)).toEqual(
      []
    );
    expect(await settleCrossFile(rules, pr, [files[2]], facts, call)).toEqual(
      []
    );
    expect(prompts).toHaveLength(0);
    const failing: JsonCaller = async () => ({
      ok: false,
      error: "x",
      raw: null
    });
    expect(await settleCrossFile(rules, pr, files, facts, failing)).toEqual([]);
  });
});
