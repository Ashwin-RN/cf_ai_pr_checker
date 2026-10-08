import { describe, expect, it } from "vitest";
import {
  buildFindings,
  overallStatus,
  ruleStatuses,
  stableKey
} from "../src/checker/merge";
import { file, rule, verdict } from "./fixtures";

const rules = [rule(1, "No console.log"), rule(2, "Has a test", "must")];

describe("ruleStatuses", () => {
  it("lets a verified FAIL win over everything", () => {
    const files = [
      file("a.ts", [verdict(1, "PASS")]),
      file("b.ts", [verdict(1, "FAIL", { quote: "console.log(x)", line: 3 })])
    ];
    expect(ruleStatuses(rules, files, true)[0]).toEqual({
      rule: 1,
      status: "FAIL",
      detail: "fails in b.ts:3"
    });
  });

  it("turns an unverified FAIL into UNSURE with the reason", () => {
    const files = [file("a.ts", [verdict(1, "FAIL", { verified: false })])];
    expect(ruleStatuses(rules, files, true)[0]).toMatchObject({
      status: "UNSURE",
      detail: "possible fail in a.ts, quote not verified"
    });
  });

  it("passes only when every file was checked", () => {
    const files = [file("a.ts", [verdict(2, "PASS")])];
    expect(ruleStatuses(rules, files, true)[1].status).toBe("PASS");
    expect(ruleStatuses(rules, files, false)[1].status).toBe("UNSURE");
    const withFailure = [
      ...files,
      file("b.ts", [], { state: "failed", reason: "model error" })
    ];
    expect(ruleStatuses(rules, withFailure, true)[1].status).toBe("UNSURE");
  });

  it("reports NA when no file triggered the rule and UNSURE when nothing was checked", () => {
    expect(
      ruleStatuses(rules, [file("a.ts", [verdict(1, "NA")])], true)[0].status
    ).toBe("NA");
    expect(ruleStatuses(rules, [], true)[0]).toMatchObject({
      status: "UNSURE",
      detail: "no file could be checked"
    });
  });
});

describe("overallStatus", () => {
  it("is fail, then unsure, then pass", () => {
    expect(
      overallStatus([
        { rule: 1, status: "FAIL", detail: "" },
        { rule: 2, status: "UNSURE", detail: "" }
      ])
    ).toBe("fail");
    expect(
      overallStatus([
        { rule: 1, status: "NA", detail: "" },
        { rule: 2, status: "UNSURE", detail: "" }
      ])
    ).toBe("unsure");
    expect(
      overallStatus([
        { rule: 1, status: "PASS", detail: "" },
        { rule: 2, status: "NA", detail: "" }
      ])
    ).toBe("pass");
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
    expect(findings[1].note).toBe(
      "possible fail; the quote was not found in the diff"
    );
    expect(findings[1].question).toBe(
      "Does src/a.ts contain this: console.log(y)?"
    );
    expect(findings[2].question).toBe("Is b covered elsewhere?");
    expect(findings[0].why).toBe("logs leak data");
  });

  it("keeps keys stable across runs and file order", () => {
    const a = buildFindings(rules, files);
    const b = buildFindings(rules, [...files].reverse());
    expect(a.map((f) => f.key)).toEqual(b.map((f) => f.key));
    expect(a[0].key).toMatch(/^[0-9a-f]{8}$/);
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
});

describe("stableKey", () => {
  it("is deterministic and distinguishes inputs", () => {
    expect(stableKey(["a", 1, null])).toBe(stableKey(["a", 1, null]));
    expect(stableKey(["a", 1, null])).not.toBe(stableKey(["a", 2, null]));
  });
});

describe("buildFindings warnings", () => {
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
});

describe("buildFindings notes", () => {
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
});
