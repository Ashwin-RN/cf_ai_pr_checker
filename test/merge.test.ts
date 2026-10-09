import { describe, expect, it } from "vitest";
import {
  buildFindings,
  overallStatus,
  ruleGaps,
  ruleStatuses,
  stableKey
} from "../src/checker/merge";
import { MORE_FILES } from "../src/checker/select";
import type { CrossFileVerdict, RuleStatus } from "../src/checker/types";
import { file, rule, verdict } from "./fixtures";

const rules = [rule(1, "No console.log"), rule(2, "Has a test", "must")];

const status = (
  ruleId: number,
  s: RuleStatus["status"],
  blocking = s === "FAIL"
): RuleStatus => ({ rule: ruleId, status: s, blocking, detail: "" });

describe("ruleStatuses", () => {
  it("lets a verified FAIL win over everything and block when introduced", () => {
    const files = [
      file("a.ts", [verdict(1, "PASS")]),
      file("b.ts", [verdict(1, "FAIL", { quote: "console.log(x)", line: 3 })])
    ];
    expect(ruleStatuses(rules, files, [])[0]).toEqual({
      rule: 1,
      status: "FAIL",
      blocking: true,
      detail: "fails in b.ts:3"
    });
  });

  it("keeps a pre-existing FAIL as FAIL but not blocking unless strict", () => {
    const files = [
      file("b.ts", [
        verdict(1, "FAIL", {
          quote: "console.log(x)",
          line: 3,
          origin: "pre-existing"
        })
      ])
    ];
    expect(ruleStatuses(rules, files, [])[0]).toEqual({
      rule: 1,
      status: "FAIL",
      blocking: false,
      detail: "fails in b.ts:3 on a line this pull request does not change"
    });
    expect(ruleStatuses(rules, files, [], [], true)[0].blocking).toBe(true);
  });

  it("names the introduced failure first when both kinds exist", () => {
    const files = [
      file("a.ts", [verdict(1, "FAIL", { line: 1, origin: "pre-existing" })]),
      file("b.ts", [verdict(1, "FAIL", { line: 2 })])
    ];
    expect(ruleStatuses(rules, files, [])[0]).toMatchObject({
      blocking: true,
      detail: "fails in 2 files, first b.ts:2"
    });
  });

  it("turns an unverified FAIL into UNSURE with the reason", () => {
    const files = [file("a.ts", [verdict(1, "FAIL", { verified: false })])];
    expect(ruleStatuses(rules, files, [])[0]).toMatchObject({
      status: "UNSURE",
      blocking: false,
      detail: "possible fail in a.ts, quote not verified"
    });
  });

  it("passes only when every file in the rule's scope was fully checked", () => {
    const files = [file("src/a.ts", [verdict(2, "PASS")])];
    expect(ruleStatuses(rules, files, [])[1].status).toBe("PASS");
    const gap = [{ path: "src/big.ts", reason: "no diff", coverage: true }];
    expect(ruleStatuses(rules, files, gap)[1]).toMatchObject({
      status: "UNSURE",
      detail: "passes on the checked files; not checked: src/big.ts"
    });
    const noise = [{ path: "x.lock", reason: "lockfile", coverage: false }];
    expect(ruleStatuses(rules, files, noise)[1].status).toBe("PASS");
    const withFailure = [
      ...files,
      file("src/b.ts", [], { state: "failed", reason: "model error" })
    ];
    expect(ruleStatuses(rules, withFailure, [])[1].status).toBe("UNSURE");
    const partial = [
      ...files,
      file("src/c.ts", [verdict(2, "PASS")], { coverage: "partial" })
    ];
    expect(ruleStatuses(rules, partial, [])[1].status).toBe("UNSURE");
  });

  it("scopes the coverage gap to the rule's directories", () => {
    const scoped = [{ ...rule(1, "No logs in src"), appliesTo: ["src/"] }];
    const files = [file("src/a.ts", [verdict(1, "PASS")])];
    const docsGap = [
      { path: "docs/big.md", reason: "no diff", coverage: true }
    ];
    expect(ruleStatuses(scoped, files, docsGap)[0].status).toBe("PASS");
    const more = [{ path: MORE_FILES, reason: "cut", coverage: true }];
    expect(ruleStatuses(scoped, files, more)[0].status).toBe("UNSURE");
    expect(ruleGaps(scoped[0], files, [...docsGap, ...more])).toEqual([
      MORE_FILES
    ]);
  });

  it("reports NA when no file triggered the rule and UNSURE when nothing was checked", () => {
    expect(
      ruleStatuses(rules, [file("a.ts", [verdict(1, "NA")])], [])[0].status
    ).toBe("NA");
    expect(
      ruleStatuses(
        rules,
        [file("a.ts", [verdict(1, "NA")])],
        [{ path: "b.ts", reason: "cap", coverage: true }]
      )[0]
    ).toMatchObject({
      status: "UNSURE",
      detail: "not triggered by the checked files; not checked: b.ts"
    });
    expect(ruleStatuses(rules, [], [])[0]).toMatchObject({
      status: "UNSURE",
      detail: "no file could be checked"
    });
  });

  describe("with a cross-file settle", () => {
    const settle = (
      verdict: CrossFileVerdict["verdict"],
      extra: Partial<CrossFileVerdict> = {}
    ): CrossFileVerdict => ({
      rule: 2,
      verdict,
      facts: [{ index: 0, path: "src/a.ts", text: "src/a.ts: adds f" }],
      reason: "settled",
      why: "",
      steps: [],
      resolution: null,
      question: null,
      note: null,
      ...extra
    });
    const files = [file("src/a.ts", [verdict(2, "UNSURE")])];

    it("lets a settle PASS replace per-file UNSUREs when coverage is complete", () => {
      expect(ruleStatuses(rules, files, [], [settle("PASS")])[1]).toMatchObject(
        {
          status: "PASS",
          detail: "settled across files from 1 fact"
        }
      );
      const gap = [{ path: "src/b.ts", reason: "cap", coverage: true }];
      expect(
        ruleStatuses(rules, files, gap, [settle("PASS")])[1]
      ).toMatchObject({
        status: "UNSURE",
        detail: "passes across the checked files; not checked: src/b.ts"
      });
    });

    it("lets a settle FAIL block, but never override a verified per-file FAIL", () => {
      expect(ruleStatuses(rules, files, [], [settle("FAIL")])[1]).toEqual({
        rule: 2,
        status: "FAIL",
        blocking: true,
        detail: "fails across files: settled"
      });
      const failed = [file("src/a.ts", [verdict(2, "FAIL", { line: 1 })])];
      expect(ruleStatuses(rules, failed, [], [settle("PASS")])[1].status).toBe(
        "FAIL"
      );
    });

    it("keeps an unverified per-file FAIL above a settle PASS", () => {
      const possible = [
        file("src/a.ts", [verdict(2, "FAIL", { verified: false })])
      ];
      expect(
        ruleStatuses(rules, possible, [], [settle("PASS")])[1].status
      ).toBe("UNSURE");
    });

    it("asks the settle question when the files had nothing to say", () => {
      const quiet = [file("src/a.ts", [verdict(2, "NA")])];
      expect(
        ruleStatuses(
          rules,
          quiet,
          [],
          [settle("UNSURE", { question: "Is f tested?" })]
        )[1]
      ).toMatchObject({
        status: "UNSURE",
        detail: "needs an answer across files: Is f tested?"
      });
      expect(ruleStatuses(rules, quiet, [], [settle("NA")])[1].status).toBe(
        "NA"
      );
    });
  });
});

describe("overallStatus", () => {
  it("is fail on a blocking rule, then unsure, then pass", () => {
    expect(overallStatus([status(1, "FAIL"), status(2, "UNSURE")])).toBe(
      "fail"
    );
    expect(overallStatus([status(1, "FAIL", false), status(2, "UNSURE")])).toBe(
      "unsure"
    );
    expect(overallStatus([status(1, "FAIL", false), status(2, "PASS")])).toBe(
      "pass"
    );
    expect(overallStatus([status(1, "PASS"), status(2, "NA")])).toBe("pass");
  });
});

describe("buildFindings", () => {
  const files = [
    file(
      "src/b.ts",
      [
        verdict(1, "FAIL", {
          quote: "console.log(x)",
          line: 3,
          why: "logs leak data",
          steps: ["remove it"]
        }),
        verdict(2, "UNSURE", { question: "Is b covered elsewhere?" })
      ],
      {
        warnings: [
          {
            line: 9,
            note: "unused import",
            why: "dead code",
            steps: ["delete it"]
          }
        ]
      }
    ),
    file("src/a.ts", [
      verdict(1, "FAIL", { quote: "console.log(y)", verified: false }),
      verdict(2, "PASS")
    ])
  ];

  it("numbers blocking, questions and warnings in a fixed order", () => {
    const findings = buildFindings(rules, files);
    expect(findings.map((f) => [f.id, f.kind, f.path])).toEqual([
      ["F1", "blocking", "src/b.ts"],
      ["Q1", "question", "src/a.ts"],
      ["Q2", "question", "src/b.ts"],
      ["W1", "warning", "src/b.ts"]
    ]);
    expect(findings[0].origin).toBe("introduced");
    expect(findings[1].note).toBe(
      "possible fail; the quote was not found in the file"
    );
    expect(findings[1].question).toBe(
      "Does src/a.ts contain this: console.log(y)?"
    );
    expect(findings[2].question).toBe("Is b covered elsewhere?");
    expect(findings[0].why).toBe("logs leak data");
    expect(findings.every((f) => f.change === null)).toBe(true);
  });

  it("keeps keys stable across runs, file order and line numbers", () => {
    const a = buildFindings(rules, files);
    const b = buildFindings(rules, [...files].reverse());
    expect(a.map((f) => f.key)).toEqual(b.map((f) => f.key));
    expect(a[0].key).toMatch(/^[0-9a-f]{8}$/);
    const moved = buildFindings(rules, [
      file(
        "src/b.ts",
        [verdict(1, "FAIL", { quote: "console.log(x)", line: 30 })],
        {
          warnings: [{ line: 19, note: "unused import", why: "", steps: [] }]
        }
      )
    ]);
    expect(moved[0].key).toBe(a[0].key);
    expect(moved[1].key).toBe(a[3].key);
  });

  it("caps warnings and prefers ones with a line", () => {
    const many = file("w.ts", [], {
      warnings: Array.from({ length: 8 }, (_, i) => ({
        line: i % 2 ? null : i + 1,
        note: `w${i}`,
        why: "",
        steps: []
      }))
    });
    const warnings = buildFindings(rules, [many]).filter(
      (f) => f.kind === "warning"
    );
    expect(warnings).toHaveLength(5);
    expect(warnings.slice(0, 4).every((w) => w.line !== null)).toBe(true);
  });

  it("falls back to the rule text for why", () => {
    const findings = buildFindings(rules, [
      file("a.ts", [verdict(2, "UNSURE")])
    ]);
    expect(findings[0].why).toBe("Rule 2: Has a test");
    expect(findings[0].question).toBe("Confirm: because");
  });

  it("drops a warning that sits on a finding's line", () => {
    const f = file("a.ts", [verdict(1, "FAIL", { quote: "xxxx", line: 5 })], {
      warnings: [
        { line: 5, note: "same spot", why: "", steps: [] },
        { line: 6, note: "other", why: "", steps: [] }
      ]
    });
    const w = buildFindings(rules, [f]).filter((x) => x.kind === "warning");
    expect(w.map((x) => x.line)).toEqual([6]);
  });

  it("passes the verdict note through", () => {
    const f = file("a.ts", [
      verdict(1, "FAIL", {
        verified: false,
        note: "the quoted line is removed by this PR"
      })
    ]);
    expect(buildFindings(rules, [f])[0].note).toBe(
      "possible fail; the quoted line is removed by this PR"
    );
  });

  it("replaces per-file questions with the cross-file verdict for a settled rule", () => {
    const crossFile: CrossFileVerdict[] = [
      {
        rule: 2,
        verdict: "FAIL",
        facts: [{ index: 3, path: "src/b.ts", text: "src/b.ts: adds f" }],
        reason: "f has no test",
        why: "untested code",
        steps: ["add a test"],
        resolution: "a test for f",
        question: null,
        note: null
      }
    ];
    const findings = buildFindings(rules, files, crossFile);
    expect(findings.map((f) => [f.id, f.rule, f.path])).toEqual([
      ["F1", 1, "src/b.ts"],
      ["F2", 2, "src/b.ts"],
      ["Q1", 1, "src/a.ts"],
      ["W1", null, "src/b.ts"]
    ]);
    expect(findings[1]).toMatchObject({
      origin: "introduced",
      quote: null,
      note: "across files, from: src/b.ts: adds f"
    });
    const passed = buildFindings(rules, files, [
      { ...crossFile[0], verdict: "PASS" }
    ]);
    expect(passed.some((f) => f.rule === 2)).toBe(false);
    const unsure = buildFindings(rules, files, [
      { ...crossFile[0], verdict: "UNSURE", question: "Tested?" }
    ]);
    expect(unsure.filter((f) => f.rule === 2).map((f) => f.question)).toEqual([
      "Is b covered elsewhere?"
    ]);
  });

  it("turns intent drift into warnings", () => {
    const findings = buildFindings(rules, [file("src/a.ts", [])], [], {
      compared: true,
      summary: "Differs.",
      unmentioned: [
        { path: "src/a.ts", text: "src/a.ts: adds a retry loop", note: "" }
      ],
      unsupported: ["bumps the version"]
    });
    expect(findings.map((f) => [f.id, f.path, f.summary])).toEqual([
      [
        "W1",
        "(description)",
        "Described but not seen in the changed files: bumps the version"
      ],
      ["W2", "src/a.ts", "Not in the description: src/a.ts: adds a retry loop"]
    ]);
  });
});

describe("stableKey", () => {
  it("is deterministic and distinguishes inputs", () => {
    expect(stableKey(["a", 1, null])).toBe(stableKey(["a", 1, null]));
    expect(stableKey(["a", 1, null])).not.toBe(stableKey(["a", 2, null]));
  });
});
