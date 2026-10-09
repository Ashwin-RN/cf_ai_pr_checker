import { describe, expect, it } from "vitest";
import { assessedBy, diffRun } from "../src/checker/diff";
import { ACROSS_FILES, DESCRIPTION } from "../src/checker/merge";
import type {
  CrossFileVerdict,
  FileCheck,
  Finding,
  Intent,
  PreviousRun
} from "../src/checker/types";
import { file, rule } from "./fixtures";

const finding = (id: string, key: string): Finding => ({
  id,
  key,
  kind: id.startsWith("F") ? "blocking" : "question",
  rule: 1,
  path: "src/a.ts",
  line: null,
  quote: null,
  origin: null,
  change: null,
  summary: "s",
  why: "",
  steps: [],
  resolution: null,
  question: null,
  note: null,
  attestation: null
});

const previous: PreviousRun = {
  checkId: "c0",
  headSha: "0000000",
  rulesHash: "h1",
  findings: [
    {
      id: "F1",
      key: "aaaa",
      kind: "blocking",
      rule: 1,
      path: "src/a.ts",
      line: 3,
      quote: "console.log(x)",
      summary: "s"
    },
    {
      id: "Q1",
      key: "bbbb",
      kind: "question",
      rule: 2,
      path: "src/b.ts",
      line: null,
      quote: null,
      summary: "s"
    },
    {
      id: "Q2",
      key: "cccc",
      kind: "question",
      rule: 2,
      path: "src/c.ts",
      line: null,
      quote: null,
      summary: "s"
    }
  ]
};

describe("diffRun", () => {
  it("marks findings new or open, and lists the resolved and the not assessed", () => {
    const { findings, previous: diff } = diffRun(
      previous,
      [finding("F1", "aaaa"), finding("F2", "dddd")],
      "h2",
      (f) => f.path !== "src/c.ts"
    );
    expect(findings.map((f) => [f.id, f.change])).toEqual([
      ["F1", "open"],
      ["F2", "new"]
    ]);
    expect(diff).toEqual({
      checkId: "c0",
      headSha: "0000000",
      rulesChanged: true,
      new: 1,
      open: 1,
      resolved: [previous.findings[1]],
      unassessed: [previous.findings[2]]
    });
  });

  it("leaves change unset without a previous run", () => {
    const { findings, previous: diff } = diffRun(
      null,
      [finding("F1", "aaaa")],
      "h1",
      () => true
    );
    expect(findings[0].change).toBeNull();
    expect(diff).toBeNull();
  });
});

describe("assessedBy", () => {
  const rules = [rule(1, "No console.log"), rule(2, "Has a test", "must")];
  const intent: Intent = {
    compared: false,
    summary: "",
    unmentioned: [],
    unsupported: []
  };
  const settle: CrossFileVerdict = {
    rule: 2,
    verdict: "PASS",
    facts: [],
    reason: "",
    why: "",
    steps: [],
    resolution: null,
    question: null,
    note: null
  };
  const was = (
    path: string,
    ruleId: number | null,
    files: FileCheck[],
    crossFile: CrossFileVerdict[] = [],
    compared = intent,
    key = "k",
    strict = false
  ) =>
    assessedBy(
      rules,
      files,
      crossFile,
      compared,
      strict
    )({
      id: "x",
      key,
      kind: "question",
      rule: ruleId,
      path,
      line: null,
      quote: null,
      summary: ""
    });

  it("trusts the file's own record of which earlier lines it reached", () => {
    const windowed = [
      file("src/a.ts", [], {
        coverage: "changes",
        seen: { reached: true, missed: false }
      })
    ];
    expect(was("src/a.ts", 1, windowed, [], intent, "missed")).toBe(false);
    expect(was("src/a.ts", 1, windowed, [], intent, "reached")).toBe(true);
    // Without a record the rule decides, and under strict a windowed file
    // settles nothing it did not reach.
    expect(was("src/a.ts", 1, windowed, [], intent, "other")).toBe(true);
    expect(was("src/a.ts", 1, windowed, [], intent, "other", true)).toBe(false);
    expect(was("src/a.ts", 1, windowed, [], intent, "reached", true)).toBe(
      true
    );
    const failed = [
      file("src/a.ts", [], { state: "failed", seen: { k: true } })
    ];
    expect(was("src/a.ts", 1, failed)).toBe(false);
  });

  it("needs the file checked fully enough for the finding's rule", () => {
    expect(was("src/a.ts", 1, [file("src/a.ts", [])])).toBe(true);
    expect(was("src/a.ts", 1, [])).toBe(false);
    expect(
      was("src/a.ts", 1, [file("src/a.ts", [], { state: "failed" })])
    ).toBe(false);
    expect(
      was("src/a.ts", 1, [file("src/a.ts", [], { coverage: "partial" })])
    ).toBe(false);
    const windowed = [file("src/a.ts", [], { coverage: "changes" })];
    expect(was("src/a.ts", 1, windowed)).toBe(true);
    expect(was("src/a.ts", 2, windowed)).toBe(false);
    expect(was("src/a.ts", null, windowed)).toBe(true);
  });

  it("needs the cross-file step for a cross-file finding and the comparison for a description one", () => {
    expect(was(ACROSS_FILES, 2, [])).toBe(false);
    expect(was(ACROSS_FILES, 2, [], [settle])).toBe(true);
    expect(was(ACROSS_FILES, 1, [], [settle])).toBe(false);
    expect(was(DESCRIPTION, null, [])).toBe(false);
    expect(was(DESCRIPTION, null, [], [], { ...intent, compared: true })).toBe(
      true
    );
  });
});
