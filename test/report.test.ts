import { describe, expect, it } from "vitest";
import { machineReport, renderReport } from "../src/checker/report";
import type { Finding } from "../src/checker/types";
import { result, rule } from "./fixtures";

const finding: Finding = {
  id: "F1",
  key: "deadbeef",
  kind: "blocking",
  rule: 1,
  path: "src/a.ts",
  line: 3,
  quote: "console.log(x)",
  summary: "Logs a value.",
  why: "Logs leak data.",
  steps: ["Remove the call.", "Run the tests."],
  resolution: "No console.log in src/a.ts.",
  question: null,
  note: null
};

describe("renderReport", () => {
  it("always has the same sections in the same order", () => {
    const md = renderReport(result(), { json: false });
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## Status",
      "## Blocking",
      "## Questions",
      "## Warnings",
      "## Not checked",
      "## Intent"
    ]);
    expect(md).toContain("## Blocking\n\nnone\n");
    expect(md).toContain("**PASS.** All 2 rules pass");
    expect(md).toContain("How to use this report");
    expect(md).not.toContain("Machine-readable");
  });

  it("renders a finding with quote, why, steps and resolution", () => {
    const md = renderReport(
      result({
        status: "fail",
        findings: [finding],
        ruleStatuses: [
          { rule: 1, status: "FAIL", detail: "fails in src/a.ts:3" },
          { rule: 2, status: "PASS", detail: "passes in 1 file" }
        ],
        notChecked: [
          { path: "big.ts", reason: "no diff available (binary or too large)" }
        ]
      }),
      { json: true }
    );
    expect(md).toContain("### F1 · rule 1 · src/a.ts:3 · key deadbeef");
    expect(md).toContain("> `console.log(x)`");
    expect(md).toContain("**Why:** Logs leak data.");
    expect(md).toContain("1. Remove the call.\n2. Run the tests.");
    expect(md).toContain("**Resolved when:** No console.log in src/a.ts.");
    expect(md).toContain("- `big.ts`: no diff available");
    expect(md).toContain("**FAIL.** 1 of 2 rules fail.");
    const block = /```json\n([\s\S]*?)\n```/.exec(md);
    expect(block).not.toBeNull();
    const parsed = JSON.parse(block![1]);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.findings[0].id).toBe("F1");
    expect(parsed.rerun.api.body.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("escapes pipes in rule text", () => {
    const r = result({
      rules: [rule(1, "a | b")],
      ruleStatuses: [{ rule: 1, status: "NA", detail: "" }]
    });
    expect(renderReport(r, { json: false })).toContain("| 1 | a \\| b | NA |");
  });
});

describe("machineReport", () => {
  it("carries the handles an agent needs", () => {
    const m = machineReport(result());
    expect(m).toMatchObject({
      schema_version: 1,
      check_id: "check-1",
      status: "pass",
      pr: { head_sha: "abcdef1234567890" },
      rules_hash: "hash",
      coverage_complete: true
    });
  });
});
