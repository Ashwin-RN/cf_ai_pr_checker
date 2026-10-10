import { describe, expect, it } from "vitest";
import { machineReport, renderReport } from "../src/checker/report";
import type { Finding } from "../src/checker/types";
import { file, result, rule, verdict } from "./fixtures";

const finding: Finding = {
  id: "F1",
  key: "deadbeef",
  kind: "blocking",
  rule: 1,
  path: "src/a.ts",
  line: 3,
  quote: "console.log(x)",
  origin: "introduced",
  change: null,
  summary: "Logs a value.",
  why: "Logs leak data.",
  steps: ["Remove the call.", "Run the tests."],
  resolution: "No console.log in src/a.ts.",
  question: null,
  note: null,
  attestation: null,
  waiver: null,
  evidence: null
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
    expect(md).toContain("from the rules saved in this workspace (set `hash`)");
    expect(md).toContain("How to use this report");
    expect(md).toContain("## Intent\n\nThe pull request has no description");
    expect(md).not.toContain("Machine-readable");
  });

  it("renders a finding with quote, why, steps and resolution", () => {
    const md = renderReport(
      result({
        status: "fail",
        findings: [finding],
        ruleStatuses: [
          {
            rule: 1,
            status: "FAIL",
            blocking: true,
            complete: true,
            attested: false,
            waived: false,
            detail: "fails in src/a.ts:3"
          },
          {
            rule: 2,
            status: "PASS",
            blocking: false,
            complete: true,
            attested: false,
            waived: false,
            detail: "passes in 1 file"
          }
        ],
        notChecked: [
          {
            path: "big.ts",
            reason: "no diff available (binary or too large)",
            coverage: true
          }
        ],
        files: [
          file("src/a.ts", []),
          file("src/p.ts", [], {
            coverage: "partial",
            reason: "cut at the size cap"
          }),
          file("src/f.ts", [], { state: "failed", reason: "model error" })
        ]
      }),
      { json: true }
    );
    expect(md).toContain("### F1 · rule 1 · src/a.ts:3 · key deadbeef\n");
    expect(md).toContain("> `console.log(x)`");
    expect(md).toContain("**Why:** Logs leak data.");
    expect(md).toContain("1. Remove the call.\n2. Run the tests.");
    expect(md).toContain("**Resolved when:** No console.log in src/a.ts.");
    expect(md).toContain("- `big.ts`: no diff available");
    expect(md).toContain(
      "- `src/p.ts`: partially checked, cut at the size cap"
    );
    expect(md).toContain("- `src/f.ts`: not checked, model error");
    expect(md).toContain(
      "**FAIL.** 1 of 2 rules fail on lines this pull request adds."
    );
    const block = /```json\n([\s\S]*?)\n```/.exec(md);
    expect(block).not.toBeNull();
    const parsed = JSON.parse(block![1]);
    expect(parsed.schema_version).toBe(2);
    expect(parsed.findings[0].id).toBe("F1");
    expect(parsed.rules[0].blocking).toBe(true);
    expect(parsed.rerun.api.body.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("labels pre-existing failures and keeps the status honest", () => {
    const md = renderReport(
      result({
        status: "pass",
        findings: [{ ...finding, origin: "pre-existing" }],
        ruleStatuses: [
          {
            rule: 1,
            status: "FAIL",
            blocking: false,
            complete: true,
            attested: false,
            waived: false,
            detail:
              "fails in src/a.ts:3 on a line this pull request does not change"
          },
          {
            rule: 2,
            status: "PASS",
            blocking: false,
            complete: true,
            attested: false,
            waived: false,
            detail: "passes in 1 file"
          }
        ]
      }),
      { json: false }
    );
    expect(md).toContain("· key deadbeef · pre-existing\n");
    expect(md).toContain("**Origin:** pre-existing.");
    expect(md).toContain("| 1 | No console.log | FAIL (pre-existing) |");
    expect(md).toContain(
      "**PASS.** No rule fails on lines this pull request adds. 1 rule fails only on lines it does not change (see Blocking)."
    );
  });

  it("still counts an unchanged-line failure when its rule reads UNSURE", () => {
    const md = renderReport(
      result({
        status: "unsure",
        findings: [
          { ...finding, origin: "pre-existing" },
          {
            ...finding,
            id: "Q1",
            key: "cafebabe",
            kind: "question",
            path: "src/b.ts",
            origin: null,
            question: "Does src/b.ts contain this: console.log(y)?"
          }
        ],
        ruleStatuses: [
          {
            rule: 1,
            status: "UNSURE",
            blocking: false,
            complete: true,
            attested: false,
            waived: false,
            detail:
              "possible fail in src/b.ts, quote not verified; also fails in src/a.ts:3 on a line this pull request does not change"
          },
          {
            rule: 2,
            status: "PASS",
            blocking: false,
            complete: true,
            attested: false,
            waived: false,
            detail: ""
          }
        ]
      }),
      { json: false }
    );
    expect(md).toContain(
      "**UNSURE.** No rule fails on lines this pull request adds, but 1 of 2 needs an answer or more coverage. 1 rule fails only on lines it does not change (see Blocking)."
    );
    expect(md).toContain("| 1 | No console.log | UNSURE |");
    // A rule with a failure on an added line is not "only" unchanged lines.
    const mixed = renderReport(
      result({
        status: "fail",
        findings: [
          { ...finding, origin: "pre-existing" },
          { ...finding, id: "F2", key: "cafebabe", path: "src/b.ts" }
        ],
        ruleStatuses: [
          {
            rule: 1,
            status: "FAIL",
            blocking: true,
            complete: true,
            attested: false,
            waived: false,
            detail: ""
          }
        ]
      }),
      { json: false }
    );
    expect(mixed).not.toContain("only on lines it does not change");
  });

  it("says what changed since the last check", () => {
    const md = renderReport(
      result({
        status: "fail",
        findings: [
          { ...finding, change: "open" },
          { ...finding, id: "F2", key: "cafebabe", change: "new" }
        ],
        ruleStatuses: [
          {
            rule: 1,
            status: "FAIL",
            blocking: true,
            complete: true,
            attested: false,
            waived: false,
            detail: ""
          },
          {
            rule: 2,
            status: "PASS",
            blocking: false,
            complete: true,
            attested: false,
            waived: false,
            detail: ""
          }
        ],
        previous: {
          checkId: "check-0",
          headSha: "0123456789abcdef",
          rulesChanged: true,
          new: 1,
          open: 1,
          resolved: [
            {
              id: "Q1",
              key: "feedface",
              kind: "question",
              rule: 2,
              path: "src/b.ts",
              line: null,
              quote: null,
              summary: "s"
            }
          ],
          unassessed: [
            {
              id: "F3",
              key: "0badf00d",
              kind: "blocking",
              rule: 1,
              path: "src/c.ts",
              line: 9,
              quote: "console.log(z)",
              summary: "s"
            }
          ]
        }
      }),
      { json: false }
    );
    expect(md).toContain(
      "Since the last check at `0123456`: 1 new, 1 still open, 1 resolved (Q1 `feedface` src/b.ts), 1 not assessed (F3 `0badf00d` src/c.ts; not checked again this run). The rules changed since then."
    );
    expect(md).toContain("key deadbeef · still open\n");
    expect(md).toContain("key cafebabe · new\n");
  });

  it("renders the intent comparison", () => {
    const md = renderReport(
      result({
        intent: {
          compared: true,
          summary: "Mostly matches.",
          unmentioned: [
            { path: "src/a.ts", text: "src/a.ts: adds retry", note: "" }
          ],
          unsupported: ["bumps the version"]
        }
      }),
      { json: false }
    );
    expect(md).toContain(
      "## Intent\n\nMostly matches.\n- Not in the description: src/a.ts: adds retry\n- Described but not seen in the changed files: bumps the version\n"
    );
  });

  it("lists a windowed file and counts a coverage gap in the status line", () => {
    const md = renderReport(
      result({
        status: "unsure",
        findings: [{ ...finding, origin: "pre-existing" }],
        ruleStatuses: [
          {
            rule: 1,
            status: "FAIL",
            blocking: false,
            complete: false,
            attested: false,
            waived: false,
            detail:
              "fails in src/a.ts:3 on a line this pull request does not change"
          },
          {
            rule: 2,
            status: "PASS",
            blocking: false,
            complete: true,
            attested: false,
            waived: false,
            detail: ""
          }
        ],
        files: [file("src/w.ts", [], { coverage: "changes", chunks: 3 })]
      }),
      { json: true }
    );
    expect(md).toContain(
      "**UNSURE.** No rule fails on lines this pull request adds, but 1 of 2 needs an answer or more coverage. 1 rule fails only on lines it does not change (see Blocking)."
    );
    expect(md).toContain(
      "- `src/w.ts`: checked around its changes in 3 parts; the rest of the file was not shown"
    );
    const parsed = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(md)![1]);
    expect(parsed.rules.map((r: { complete: boolean }) => r.complete)).toEqual([
      false,
      true
    ]);
  });

  it("escapes pipes in rule text", () => {
    const r = result({
      rules: [rule(1, "a | b")],
      ruleStatuses: [
        {
          rule: 1,
          status: "NA",
          blocking: false,
          complete: true,
          attested: false,
          waived: false,
          detail: ""
        }
      ]
    });
    expect(renderReport(r, { json: false })).toContain("| 1 | a \\| b | NA |");
  });
});

describe("machineReport", () => {
  it("carries the handles an agent needs", () => {
    const m = machineReport(
      result({
        files: [file("a.ts", [verdict(1, "PASS")])],
        modelCalls: 3,
        strict: true
      })
    );
    expect(m).toMatchObject({
      schema_version: 2,
      check_id: "check-1",
      status: "pass",
      strict: true,
      pr: { head_sha: "abcdef1234567890" },
      rules_hash: "hash",
      rules_source: "the rules saved in this workspace",
      coverage_complete: true,
      model_calls: 3,
      cross_file: [],
      previous: null
    });
    expect(
      (m.rerun as { api: { body: { strict: boolean } } }).api.body.strict
    ).toBe(true);
  });
});
