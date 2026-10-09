import { describe, expect, it } from "vitest";
import { diffRun } from "../src/checker/diff";
import type { Finding, PreviousRun } from "../src/checker/types";

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
  note: null
});

const previous: PreviousRun = {
  checkId: "c0",
  headSha: "0000000",
  rulesHash: "h1",
  findings: [
    { id: "F1", key: "aaaa", kind: "blocking", path: "src/a.ts", summary: "s" },
    { id: "Q1", key: "bbbb", kind: "question", path: "src/b.ts", summary: "s" }
  ]
};

describe("diffRun", () => {
  it("marks findings new or open and lists the resolved ones", () => {
    const { findings, previous: diff } = diffRun(
      previous,
      [finding("F1", "aaaa"), finding("F2", "cccc")],
      "h2"
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
      resolved: [previous.findings[1]]
    });
  });

  it("leaves change unset without a previous run", () => {
    const { findings, previous: diff } = diffRun(
      null,
      [finding("F1", "aaaa")],
      "h1"
    );
    expect(findings[0].change).toBeNull();
    expect(diff).toBeNull();
  });
});
