import { describe, expect, it } from "vitest";
import { limits } from "../src/checker/limits";
import {
  ACROSS_FILES,
  buildFindings,
  covers,
  gateCrossFile,
  overallStatus,
  ruleGaps,
  ruleStatuses,
  stableKey
} from "../src/checker/merge";
import { MORE_FILES } from "../src/checker/select";
import type { CrossFileVerdict, Rule, RuleStatus } from "../src/checker/types";
import { file, rule, verdict } from "./fixtures";

const rules = [rule(1, "No console.log"), rule(2, "Has a test", "must")];
const spanning: Rule = {
  ...rule(2, "Every new route has a test", "must"),
  scope: "cross_file"
};
const crossRules = [rules[0], spanning];

const status = (
  ruleId: number,
  s: RuleStatus["status"],
  blocking = s === "FAIL",
  complete = true
): RuleStatus => ({
  rule: ruleId,
  status: s,
  blocking,
  complete,
  attested: false,
  detail: ""
});

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
      complete: true,
      attested: false,
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
      complete: true,
      attested: false,
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

  it("turns a PASS claimed without a verified quote into UNSURE", () => {
    const files = [file("src/a.ts", [verdict(2, "PASS", { verified: false })])];
    expect(ruleStatuses(rules, files, [])[1]).toMatchObject({
      status: "UNSURE",
      blocking: false,
      detail: "pass claimed without a verified quote in src/a.ts"
    });
    const mixed = [
      ...files,
      file("src/b.ts", [verdict(2, "PASS", { quote: "it()", line: 1 })])
    ];
    expect(ruleStatuses(rules, mixed, [])[1].status).toBe("UNSURE");
  });

  it("passes only when every file in the rule's scope was fully checked", () => {
    const files = [file("src/a.ts", [verdict(2, "PASS")])];
    expect(ruleStatuses(rules, files, [])[1]).toMatchObject({
      status: "PASS",
      complete: true
    });
    const gap = [{ path: "src/big.ts", reason: "no diff", coverage: true }];
    expect(ruleStatuses(rules, files, gap)[1]).toMatchObject({
      status: "UNSURE",
      complete: false,
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

  it("counts a file checked around its changes as covered for a prohibition, not for a per-file requirement", () => {
    const windowed = file(
      "src/a.ts",
      [verdict(1, "PASS"), verdict(2, "PASS", { quote: "it()", line: 1 })],
      { coverage: "changes", chunks: 2 }
    );
    const [logs, test] = ruleStatuses(rules, [windowed], []);
    expect(logs).toMatchObject({ status: "PASS", complete: true });
    expect(test).toMatchObject({
      status: "UNSURE",
      complete: false,
      detail: "passes on the checked files; not checked: src/a.ts"
    });
    expect(covers(windowed, spanning)).toBe(true);
    expect(covers(windowed, null)).toBe(true);
    expect(covers(file("x", [], { coverage: "partial" }), rules[0])).toBe(
      false
    );
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

  describe("on a rule that spans files", () => {
    const files = [file("src/a.ts", [verdict(2, "UNSURE")])];

    it("takes the cross-file PASS when coverage is complete", () => {
      expect(
        ruleStatuses(crossRules, files, [], [settle("PASS")])[1]
      ).toMatchObject({
        status: "PASS",
        complete: true,
        detail: "settled across files from 1 fact"
      });
      const gap = [{ path: "src/b.ts", reason: "cap", coverage: true }];
      expect(
        ruleStatuses(crossRules, files, gap, [settle("PASS")])[1]
      ).toMatchObject({
        status: "UNSURE",
        complete: false,
        detail: "passes across the checked files; not checked: src/b.ts"
      });
    });

    it("takes the cross-file FAIL, and lets a cross-file PASS answer a file's own FAIL", () => {
      expect(ruleStatuses(crossRules, files, [], [settle("FAIL")])[1]).toEqual({
        rule: 2,
        status: "FAIL",
        blocking: true,
        complete: true,
        attested: false,
        detail: "fails across files: settled"
      });
      const failed = [file("src/a.ts", [verdict(2, "FAIL", { line: 1 })])];
      expect(
        ruleStatuses(crossRules, failed, [], [settle("PASS")])[1].status
      ).toBe("PASS");
    });

    it("never settles on the files' own verdicts alone", () => {
      const passed = [
        file("src/a.ts", [verdict(2, "PASS", { quote: "it()", line: 1 })])
      ];
      expect(ruleStatuses(crossRules, passed, [])[1]).toMatchObject({
        status: "UNSURE",
        detail: "needs the cross-file step, which did not run"
      });
      const failed = [file("src/a.ts", [verdict(2, "FAIL", { line: 1 })])];
      expect(ruleStatuses(crossRules, failed, [])[1]).toMatchObject({
        status: "UNSURE",
        blocking: false,
        detail:
          "possible fail in src/a.ts; needs the cross-file step, which did not run"
      });
      expect(ruleStatuses(crossRules, [], [])[1].detail).toBe(
        "no file could be checked"
      );
    });

    it("asks the settle question, and reads NA from the settle", () => {
      const quiet = [file("src/a.ts", [verdict(2, "NA")])];
      expect(
        ruleStatuses(
          crossRules,
          quiet,
          [],
          [settle("UNSURE", { question: "Is f tested?" })]
        )[1]
      ).toMatchObject({
        status: "UNSURE",
        detail: "needs an answer across files: Is f tested?"
      });
      expect(
        ruleStatuses(crossRules, quiet, [], [settle("NA")])[1].status
      ).toBe("NA");
      const gap = [{ path: "src/b.ts", reason: "cap", coverage: true }];
      expect(
        ruleStatuses(crossRules, quiet, gap, [settle("NA")])[1]
      ).toMatchObject({ status: "UNSURE", complete: false });
    });
  });
});

describe("gateCrossFile", () => {
  const files = [
    file("src/a.ts", [verdict(2, "UNSURE")], { facts: ["adds f"] })
  ];

  it("lets a cross-file FAIL stand on complete coverage and uncut facts", () => {
    expect(
      gateCrossFile(crossRules, [settle("FAIL")], files, [], false)
    ).toEqual([settle("FAIL")]);
  });

  it("turns it into a question when a file in scope was not checked", () => {
    const gap = [{ path: "src/b.ts", reason: "cap", coverage: true }];
    const [gated] = gateCrossFile(
      crossRules,
      [settle("FAIL")],
      files,
      gap,
      false
    );
    expect(gated).toMatchObject({
      verdict: "UNSURE",
      reason: "settled",
      note: "a fail across files stands only on complete facts; not checked: src/b.ts",
      question:
        "On the facts seen rule 2 fails (settled). Is what it requires in a file or a fact the check did not see?"
    });
  });

  it("turns it into a question when a file's facts hit the cap or the fact list was cut", () => {
    const capped = [
      file("src/a.ts", [], {
        facts: Array.from({ length: limits.factsPerFile }, (_, i) => `f${i}`)
      })
    ];
    expect(
      gateCrossFile(crossRules, [settle("FAIL")], capped, [], false)[0]
    ).toMatchObject({
      verdict: "UNSURE",
      note: "a fail across files stands only on complete facts; more facts than could be listed for src/a.ts"
    });
    expect(
      gateCrossFile(crossRules, [settle("FAIL")], files, [], true)[0]
    ).toMatchObject({
      verdict: "UNSURE",
      note: "a fail across files stands only on complete facts; the fact list was cut at its cap"
    });
  });

  it("leaves the other verdicts alone", () => {
    const gap = [{ path: "x", reason: "", coverage: true }];
    const others = [settle("PASS"), settle("UNSURE"), settle("NA")];
    expect(gateCrossFile(crossRules, others, files, gap, true)).toEqual(others);
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

  it("is unsure on a coverage gap even without an UNSURE verdict", () => {
    expect(
      overallStatus([status(1, "FAIL", false, false), status(2, "PASS")])
    ).toBe("unsure");
    expect(overallStatus([status(1, "NA", false, false)])).toBe("unsure");
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

  it("keeps a finding's key when a FAIL becomes a question", () => {
    const block = buildFindings(rules, [
      file("src/b.ts", [
        verdict(1, "FAIL", { quote: "console.log(x)", line: 3 })
      ])
    ]);
    const asked = buildFindings(rules, [
      file("src/b.ts", [
        verdict(1, "FAIL", { quote: "console.log(x)", verified: false })
      ])
    ]);
    expect(block[0].kind).toBe("blocking");
    expect(asked[0].kind).toBe("question");
    expect(asked[0].key).toBe(block[0].key);
  });

  it("asks about a PASS claimed without a verified quote", () => {
    const bare = file("src/a.ts", [
      verdict(2, "PASS", { verified: false, note: "no line was quoted" })
    ]);
    expect(buildFindings(rules, [bare])[0]).toMatchObject({
      id: "Q1",
      kind: "question",
      rule: 2,
      origin: null,
      note: "possible pass; no line was quoted",
      question:
        "Where does src/a.ts meet rule 2? The check claimed a pass without quoting a line."
    });
    const quoted = file("src/a.ts", [
      verdict(2, "PASS", {
        verified: false,
        quote: "it('x')",
        note: "the quote was not found in the file"
      })
    ]);
    expect(buildFindings(rules, [quoted])[0]).toMatchObject({
      note: "possible pass; the quote was not found in the file",
      question: "Does src/a.ts contain this: it('x')?"
    });
  });

  it("makes a file's own FAIL on a rule that spans files a question, never a block", () => {
    const f = file("src/a.ts", [verdict(2, "FAIL", { line: 1 })]);
    expect(buildFindings(crossRules, [f])[0]).toMatchObject({
      id: "Q1",
      kind: "question",
      origin: null,
      note: "possible fail; the rule spans files and the cross-file step did not run",
      question:
        "Does another file in this pull request supply what rule 2 requires for src/a.ts?"
    });
    expect(buildFindings(crossRules, [f], [settle("PASS")])).toEqual([]);
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

  it("replaces per-file findings with the cross-file verdict for a rule it settled", () => {
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
    const findings = buildFindings(crossRules, files, crossFile);
    expect(findings.map((f) => [f.id, f.rule, f.path])).toEqual([
      ["F1", 1, "src/b.ts"],
      ["F2", 2, ACROSS_FILES],
      ["Q1", 1, "src/a.ts"],
      ["W1", null, "src/b.ts"]
    ]);
    expect(findings[1]).toMatchObject({
      origin: "introduced",
      quote: null,
      note: "across files, from: src/b.ts: adds f"
    });
    const passed = buildFindings(crossRules, files, [
      { ...crossFile[0], verdict: "PASS" }
    ]);
    expect(passed.some((f) => f.rule === 2)).toBe(false);
    const unsure = buildFindings(crossRules, files, [
      { ...crossFile[0], verdict: "UNSURE", question: "Tested?" }
    ]);
    expect(
      unsure.filter((f) => f.rule === 2).map((f) => [f.path, f.question])
    ).toEqual([[ACROSS_FILES, "Tested?"]]);
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
