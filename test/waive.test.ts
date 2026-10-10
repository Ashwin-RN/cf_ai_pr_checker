import { describe, expect, it } from "vitest";
import { assemble } from "../src/checker";
import {
  ACROSS_FILES,
  activeWaivers,
  applyWaivers,
  overallStatus,
  stableKey
} from "../src/checker/merge";
import { machineReport, renderReport } from "../src/checker/report";
import type {
  Attestation,
  Finding,
  Pr,
  RuleStatus,
  Waiver
} from "../src/checker/types";
import { parseCommand } from "../src/commands";
import { readResult } from "../src/store";
import { file, result, rule, verdict } from "./fixtures";

const RULES_HASH = "h1";
const HEAD = "abcdef1234567890";

const finding = (
  id: string,
  ruleId: number,
  path: string,
  extra: Partial<Finding> = {}
): Finding => ({
  id,
  key: stableKey([ruleId, path, "console.log(x)"]),
  kind: "blocking",
  rule: ruleId,
  path,
  line: 3,
  quote: "console.log(x)",
  origin: "introduced",
  change: null,
  summary: "Logs a value.",
  why: "Logs leak data.",
  steps: ["Remove the call.", "Run the tests."],
  resolution: "No console.log in the file.",
  question: null,
  note: null,
  attestation: null,
  waiver: null,
  ...extra
});

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
  waived: false,
  detail: s === "FAIL" ? "fails in src/a.ts:3" : "needs an answer for src/a.ts"
});

const waiver = (ruleId: number, extra: Partial<Waiver> = {}): Waiver => ({
  rule: ruleId,
  reason: "The log is behind a debug flag.",
  checkId: "check-0",
  headSha: HEAD,
  rulesHash: RULES_HASH,
  createdAt: 5,
  revokedAt: null,
  ...extra
});

describe("applyWaivers", () => {
  it("excuses a failing rule: the evidence and status stand, the rule stops blocking, the check passes", () => {
    const out = applyWaivers(
      [status(1, "FAIL")],
      [finding("F1", 1, "src/a.ts")],
      [waiver(1)],
      RULES_HASH,
      HEAD,
      false
    );
    expect(out.statuses[0]).toEqual({
      rule: 1,
      status: "FAIL",
      blocking: false,
      complete: true,
      attested: false,
      waived: true,
      detail: 'fails in src/a.ts:3; waived: "The log is behind a debug flag."'
    });
    expect(out.findings[0].waiver).toEqual({
      reason: "The log is behind a debug flag.",
      headSha: HEAD,
      at: 5,
      counted: true,
      note: null
    });
    expect(out.findings[0].quote).toBe("console.log(x)");
    expect(overallStatus(out.statuses)).toBe("pass");
  });

  it("excuses an unsettled rule and a coverage gap for the status, never for coverage", () => {
    const out = applyWaivers(
      [status(1, "UNSURE", false, false)],
      [finding("Q1", 1, "src/a.ts", { kind: "question", origin: null })],
      [waiver(1)],
      RULES_HASH,
      HEAD,
      false
    );
    expect(out.statuses[0]).toMatchObject({
      status: "UNSURE",
      waived: true,
      complete: false
    });
    expect(overallStatus(out.statuses)).toBe("pass");
  });

  it("counts for nothing under strict, and says so on the item", () => {
    const out = applyWaivers(
      [status(1, "FAIL")],
      [finding("F1", 1, "src/a.ts")],
      [waiver(1)],
      RULES_HASH,
      HEAD,
      true
    );
    expect(out.statuses[0]).toMatchObject({ blocking: true, waived: false });
    expect(out.findings[0].waiver).toMatchObject({
      counted: false,
      note: "not counted: the check is strict"
    });
    expect(overallStatus(out.statuses)).toBe("fail");
  });

  it("is stale once the rules change, since rule numbers are positions", () => {
    const out = applyWaivers(
      [status(1, "FAIL")],
      [finding("F1", 1, "src/a.ts")],
      [waiver(1, { rulesHash: "older" })],
      RULES_HASH,
      HEAD,
      false
    );
    expect(out.statuses[0]).toMatchObject({ blocking: true, waived: false });
    expect(out.findings[0].waiver).toMatchObject({
      counted: false,
      note: "not counted: the rules changed since the waiver"
    });
  });

  it("still counts at a later commit, and says so", () => {
    const out = applyWaivers(
      [status(1, "FAIL")],
      [finding("F1", 1, "src/a.ts")],
      [waiver(1, { headSha: "0000000000000000" })],
      RULES_HASH,
      HEAD,
      false
    );
    expect(out.statuses[0]).toMatchObject({
      blocking: false,
      waived: true,
      detail:
        'fails in src/a.ts:3; waived on an earlier revision: "The log is behind a debug flag."'
    });
    expect(out.findings[0].waiver).toMatchObject({
      counted: true,
      note: "waived on an earlier revision"
    });
  });

  it("ignores a revoked waiver and takes the latest active one", () => {
    const revoked = waiver(1, { revokedAt: 9 });
    expect(activeWaivers([revoked]).size).toBe(0);
    const out = applyWaivers(
      [status(1, "FAIL")],
      [finding("F1", 1, "src/a.ts")],
      [revoked],
      RULES_HASH,
      HEAD,
      false
    );
    expect(out.statuses[0]).toMatchObject({ blocking: true, waived: false });
    expect(out.findings[0].waiver).toBeNull();
    const later = waiver(1, { reason: "Generated file.", createdAt: 7 });
    const active = activeWaivers([later, waiver(1), revoked]);
    expect(active.get(1)?.reason).toBe("Generated file.");
  });

  it("leaves a passing rule, a rule not triggered and a warning alone", () => {
    const warning = finding("W1", 1, "src/c.ts", {
      kind: "warning",
      rule: null,
      key: "warn"
    });
    const out = applyWaivers(
      [
        { ...status(1, "PASS", false), detail: "passes in 1 file" },
        { ...status(2, "NA", false), detail: "not triggered by this PR" }
      ],
      [warning],
      [waiver(1), waiver(2)],
      RULES_HASH,
      HEAD,
      false
    );
    expect(out.statuses.map((s) => s.waived)).toEqual([false, false]);
    expect(out.statuses[0].detail).toBe("passes in 1 file");
    expect(out.findings[0].waiver).toBeNull();
  });

  it("excuses a rule that spans files through its question", () => {
    const q = finding("Q1", 2, ACROSS_FILES, {
      kind: "question",
      key: stableKey([2, ACROSS_FILES]),
      line: null,
      quote: null,
      origin: null,
      question: "Is parseId tested?"
    });
    const out = applyWaivers(
      [
        {
          ...status(2, "UNSURE", false),
          detail: "needs an answer across files"
        }
      ],
      [q],
      [waiver(2, { reason: "parseId is covered by the e2e suite." })],
      RULES_HASH,
      HEAD,
      false
    );
    expect(out.statuses[0]).toMatchObject({ status: "UNSURE", waived: true });
    expect(out.findings[0].waiver?.counted).toBe(true);
  });
});

describe("assemble with waivers", () => {
  const pr: Pr = {
    owner: "o",
    repo: "r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "T",
    body: "",
    headSha: HEAD,
    baseRef: "main",
    files: [],
    fileListTruncated: false
  };
  const rules = [
    rule(1, "No console.log"),
    rule(2, "Every new function has a test", "must")
  ];
  const build = (
    waivers: Waiver[],
    strict = false,
    attestations: Attestation[] = []
  ) =>
    assemble({
      input: {
        id: "c2",
        workspace: "ws",
        prUrl: pr.url,
        rules: null,
        strict,
        waivers,
        attestations
      },
      pr,
      ruleSet: { rules, hash: RULES_HASH, source: "t" },
      results: [
        file("src/a.ts", [
          verdict(1, "FAIL", { quote: "console.log(x)", line: 3 }),
          verdict(2, "UNSURE", { question: "Is f tested elsewhere?" })
        ])
      ],
      notChecked: [],
      crossFile: [],
      intent: {
        compared: false,
        summary: "none",
        unmentioned: [],
        unsupported: []
      },
      modelCalls: 1,
      startedAt: 0,
      finishedAt: 1
    });

  it("passes once every open rule is waived, and carries the waivers on record", () => {
    const plain = build([]);
    expect(plain.status).toBe("fail");
    const waived = build([waiver(1), waiver(2)]);
    expect(waived.status).toBe("pass");
    expect(waived.ruleStatuses.map((s) => [s.status, s.waived])).toEqual([
      ["FAIL", true],
      ["UNSURE", true]
    ]);
    expect(waived.findings.map((f) => f.waiver?.counted)).toEqual([true, true]);
    expect(waived.coverageComplete).toBe(true);
    expect(waived.waivers).toEqual([waiver(1), waiver(2)]);
    expect(build([waiver(1)]).status).toBe("unsure");
    expect(build([waiver(1), waiver(2)], true).status).toBe("fail");
  });

  it("applies answers before waivers, so an answered rule passes by attestation, not by waiver", () => {
    const plain = build([]);
    const q = plain.findings.find((f) => f.kind === "question")!;
    const out = build([waiver(1), waiver(2)], false, [
      {
        key: q.key,
        rule: 2,
        path: "src/a.ts",
        question: q.question ?? q.summary,
        answer: "test/f.test.ts calls it.",
        checkId: "c1",
        headSha: HEAD,
        rulesHash: RULES_HASH,
        createdAt: 3
      }
    ]);
    expect(out.ruleStatuses[1]).toMatchObject({
      status: "PASS",
      attested: true,
      waived: false
    });
    expect(out.findings.find((f) => f.kind === "question")?.waiver).toBeNull();
  });
});

describe("the report with a waived rule", () => {
  const waived = result({
    status: "pass",
    findings: [
      finding("F1", 1, "src/a.ts", {
        waiver: {
          reason: "The log is behind a debug flag.",
          headSha: HEAD,
          at: 5,
          counted: true,
          note: null
        }
      })
    ],
    ruleStatuses: [
      {
        ...status(1, "FAIL", false),
        waived: true,
        detail: 'fails in src/a.ts:3; waived: "The log is behind a debug flag."'
      },
      { ...status(2, "PASS", false), detail: "passes in 1 file" }
    ],
    waivers: [waiver(1), waiver(2, { revokedAt: 9 })]
  });

  it("marks the item and the rule, shows the reason, and drops the steps", () => {
    const md = renderReport(waived, { json: false });
    expect(md).toContain("### F1 · rule 1 · src/a.ts:3 · key ");
    expect(md).toContain(" · waived\n");
    expect(md).toContain("> `console.log(x)`");
    expect(md).toContain(
      "**Waived:** The log is behind a debug flag. (given at `abcdef1`; the rule does not block)"
    );
    expect(md).not.toContain("**Steps:**");
    expect(md).toContain("| 1 | No console.log | FAIL (waived) |");
    expect(md).toContain(
      "**PASS.** No rule blocks. 1 is waived for this pull request (see the rule table)."
    );
    expect(md).toContain("An item marked waived is on a rule excused");
  });

  it("keeps the steps when the waiver did not count", () => {
    const md = renderReport(
      result({
        status: "fail",
        strict: true,
        findings: [
          finding("F1", 1, "src/a.ts", {
            waiver: {
              reason: "The log is behind a debug flag.",
              headSha: HEAD,
              at: 5,
              counted: false,
              note: "not counted: the check is strict"
            }
          })
        ],
        ruleStatuses: [status(1, "FAIL"), status(2, "PASS", false)]
      }),
      { json: false }
    );
    expect(md).toContain(
      "(given at `abcdef1`; not counted: the check is strict)"
    );
    expect(md).toContain("**Steps:**");
    expect(md).toContain("| 1 | No console.log | FAIL |");
    expect(md).toContain("**FAIL.** 1 of 2 rules fail.");
  });

  it("carries the waivers, active and revoked, and the waive handles in the JSON", () => {
    const m = machineReport(waived) as {
      rules: Array<{ waived: boolean }>;
      findings: Finding[];
      waivers: Array<{ rule: number; revoked_at: number | null }>;
      waive: {
        api: { path: string; body: { checkId: string } };
        mcp: { tool: string; arguments: { check_id: string } };
      };
    };
    expect(m.rules.map((r) => r.waived)).toEqual([true, false]);
    expect(m.findings[0].waiver?.counted).toBe(true);
    expect(m.waivers).toEqual([
      expect.objectContaining({ rule: 1, revoked_at: null }),
      expect.objectContaining({ rule: 2, revoked_at: 9 })
    ]);
    expect(m.waive.api.path).toBe("/api/waive");
    expect(m.waive.api.body.checkId).toBe("check-1");
    expect(m.waive.mcp.tool).toBe("waive_rule");
  });

  it("fills a result stored before waivers existed", () => {
    const json = JSON.stringify(result(), (key, value) =>
      ["waived", "waiver", "waivers"].includes(key) ? undefined : value
    );
    expect(json).not.toContain("waiv");
    const r = readResult(json);
    expect(r.waivers).toEqual([]);
    expect(r.ruleStatuses.every((s) => s.waived === false)).toBe(true);
    expect(renderReport(r, { json: true })).toContain("**PASS.**");
  });
});

describe("parseCommand for waivers", () => {
  it("reads a waiver with its reason, on the latest check or a named one", () => {
    expect(parseCommand("waive rule 3: the file is generated")).toEqual({
      kind: "waive",
      rule: 3,
      ref: null,
      reason: "the file is generated"
    });
    expect(
      parseCommand(
        "waive rule 3 on 1234abcd: generated, see https://github.com/o/r/pull/5"
      )
    ).toEqual({
      kind: "waive",
      rule: 3,
      ref: "1234abcd",
      reason: "generated, see https://github.com/o/r/pull/5"
    });
    expect(
      parseCommand("waive rule 2 on https://github.com/o/r/pull/5: legacy")
    ).toEqual({
      kind: "waive",
      rule: 2,
      ref: "https://github.com/o/r/pull/5",
      reason: "legacy"
    });
  });

  it("reads a revocation, and leaves anything else to the other commands", () => {
    expect(parseCommand("revoke rule 3")).toEqual({
      kind: "revoke",
      rule: 3,
      ref: null
    });
    expect(
      parseCommand("Revoke rule 3 on https://github.com/o/r/pull/5")
    ).toEqual({
      kind: "revoke",
      rule: 3,
      ref: "https://github.com/o/r/pull/5"
    });
    expect(parseCommand("waive rule three: x")).toEqual({ kind: "chat" });
    expect(parseCommand("waive rule 3")).toEqual({ kind: "chat" });
  });
});
