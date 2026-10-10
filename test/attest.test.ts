import { describe, expect, it } from "vitest";
import { assemble } from "../src/checker";
import {
  ACROSS_FILES,
  applyAttestations,
  stableKey
} from "../src/checker/merge";
import { machineReport, renderReport } from "../src/checker/report";
import type {
  Attestation,
  Finding,
  Pr,
  RuleStatus
} from "../src/checker/types";
import { file, result, rule, verdict } from "./fixtures";

const RULES_HASH = "h1";

const question = (
  id: string,
  ruleId: number,
  path: string,
  extra: Partial<Finding> = {}
): Finding => ({
  id,
  key: stableKey([ruleId, path, ""]),
  kind: "question",
  rule: ruleId,
  path,
  line: null,
  quote: null,
  origin: null,
  change: null,
  summary: "the file does not show it",
  why: "Tests catch regressions.",
  steps: ["Find the test.", "Run it."],
  resolution: "a test that calls it",
  question: "Is parseDate covered by a test outside this PR?",
  note: null,
  attestation: null,
  waiver: null,
  evidence: null,
  ...extra
});

const unsure = (ruleId: number, complete = true): RuleStatus => ({
  rule: ruleId,
  status: "UNSURE",
  blocking: false,
  complete,
  attested: false,
  waived: false,
  detail: "needs an answer for src/a.ts"
});

const answer = (
  key: string,
  extra: Partial<Attestation> = {}
): Attestation => ({
  key,
  rule: 1,
  path: "src/a.ts",
  question: "Is parseDate covered by a test outside this PR?",
  answer: "Yes, test/dates.test.ts calls it.",
  checkId: "check-0",
  headSha: "0123456789abcdef",
  rulesHash: RULES_HASH,
  createdAt: 5,
  ...extra
});

describe("applyAttestations", () => {
  it("settles a rule that is unsure only because of an answered question", () => {
    const q = question("Q1", 1, "src/a.ts");
    const out = applyAttestations(
      [unsure(1)],
      [q],
      [answer(q.key)],
      RULES_HASH,
      false
    );
    expect(out.statuses[0]).toMatchObject({
      status: "PASS",
      attested: true,
      waived: false,
      blocking: false,
      complete: true,
      detail: 'passes by attestation: "Yes, test/dates.test.ts calls it."'
    });
    expect(out.findings[0].attestation).toEqual({
      answer: "Yes, test/dates.test.ts calls it.",
      headSha: "0123456789abcdef",
      at: 5,
      counted: true,
      note: null
    });
  });

  it("leaves the rule unsure while any of its questions is open", () => {
    const a = question("Q1", 1, "src/a.ts");
    const b = question("Q2", 1, "src/b.ts");
    const out = applyAttestations(
      [unsure(1)],
      [a, b],
      [answer(a.key)],
      RULES_HASH,
      false
    );
    expect(out.statuses[0].status).toBe("UNSURE");
    expect(out.statuses[0].attested).toBe(false);
    expect(out.findings[0].attestation?.counted).toBe(true);
    expect(out.findings[1].attestation).toBeNull();
  });

  it("never fills a coverage gap", () => {
    const q = question("Q1", 1, "src/a.ts");
    const out = applyAttestations(
      [unsure(1, false)],
      [q],
      [answer(q.key)],
      RULES_HASH,
      false
    );
    expect(out.statuses[0]).toMatchObject({
      status: "UNSURE",
      complete: false,
      attested: false
    });
  });

  it("counts for nothing under strict, and says so on the item", () => {
    const q = question("Q1", 1, "src/a.ts");
    const out = applyAttestations(
      [unsure(1)],
      [q],
      [answer(q.key)],
      RULES_HASH,
      true
    );
    expect(out.statuses[0].status).toBe("UNSURE");
    expect(out.findings[0].attestation).toMatchObject({
      counted: false,
      note: "not counted: the check is strict"
    });
  });

  it("treats an answer given against other rules as stale", () => {
    const q = question("Q1", 1, "src/a.ts");
    const out = applyAttestations(
      [unsure(1)],
      [q],
      [answer(q.key, { rulesHash: "older" })],
      RULES_HASH,
      false
    );
    expect(out.statuses[0].status).toBe("UNSURE");
    expect(out.findings[0].attestation).toMatchObject({
      counted: false,
      note: "not counted: the rules changed since the answer"
    });
  });

  it("never touches a FAIL, a blocking item or a warning", () => {
    const fail: RuleStatus = {
      ...unsure(1),
      status: "FAIL",
      blocking: true,
      detail: "fails in src/b.ts:3"
    };
    const blocking = question("F1", 1, "src/b.ts", { kind: "blocking" });
    const warning = question("W1", null as never, "src/c.ts", {
      kind: "warning",
      rule: null,
      key: "warn"
    });
    const q = question("Q1", 1, "src/a.ts");
    const out = applyAttestations(
      [fail],
      [blocking, q, warning],
      [answer(blocking.key), answer(q.key), answer("warn")],
      RULES_HASH,
      false
    );
    expect(out.statuses[0]).toEqual(fail);
    expect(out.findings.map((f) => f.attestation !== null)).toEqual([
      false,
      true,
      false
    ]);
  });

  it("settles a rule that spans files from its one question", () => {
    const q = question("Q1", 2, ACROSS_FILES, {
      key: stableKey([2, ACROSS_FILES])
    });
    const out = applyAttestations(
      [{ ...unsure(2), detail: "needs an answer across files" }],
      [q],
      [answer(q.key, { rule: 2, path: ACROSS_FILES })],
      RULES_HASH,
      false
    );
    expect(out.statuses[0]).toMatchObject({ status: "PASS", attested: true });
  });

  it("does not count an answer once the question changed under the same key", () => {
    const key = stableKey([2, ACROSS_FILES]);
    const given = answer(key, {
      rule: 2,
      path: ACROSS_FILES,
      question: "Is /login tested?"
    });
    const login = question("Q1", 2, ACROSS_FILES, {
      key,
      question: "Is /login tested?"
    });
    const first = applyAttestations(
      [unsure(2)],
      [login],
      [given],
      RULES_HASH,
      false
    );
    expect(first.statuses[0]).toMatchObject({ status: "PASS", attested: true });
    // A later push asks a different question at the same place.
    const admin = { ...login, question: "Is /admin/delete tested?" };
    const second = applyAttestations(
      [unsure(2)],
      [admin],
      [given],
      RULES_HASH,
      false
    );
    expect(second.statuses[0]).toMatchObject({
      status: "UNSURE",
      attested: false
    });
    expect(second.findings[0].attestation).toMatchObject({
      counted: false,
      note: "not counted: the question changed since the answer"
    });
  });

  it("returns a rule with a failure on an unchanged line to FAIL (pre-existing) once its question is answered", () => {
    const old = question("F1", 1, "src/b.ts", {
      kind: "blocking",
      key: "old",
      line: 3,
      quote: "console.log(x)",
      origin: "pre-existing",
      question: null
    });
    const q = question("Q1", 1, "src/a.ts");
    const out = applyAttestations(
      [
        {
          ...unsure(1),
          detail:
            "needs an answer for src/a.ts; also fails in src/b.ts:3 on a line this pull request does not change"
        }
      ],
      [old, q],
      [answer(q.key)],
      RULES_HASH,
      false
    );
    expect(out.statuses[0]).toMatchObject({
      status: "FAIL",
      blocking: false,
      attested: false,
      waived: false,
      complete: true,
      detail:
        "fails in src/b.ts:3 on a line this pull request does not change; its question is answered by attestation"
    });
    expect(out.findings[1].attestation?.counted).toBe(true);
  });

  it("cuts a long answer in the rule table and keeps it whole on the item", () => {
    const q = question("Q1", 1, "src/a.ts");
    const long = "x".repeat(200);
    const out = applyAttestations(
      [unsure(1)],
      [q],
      [answer(q.key, { answer: long })],
      RULES_HASH,
      false
    );
    expect(out.statuses[0].detail.length).toBeLessThan(120);
    expect(out.statuses[0].detail.endsWith('…"')).toBe(true);
    expect(out.findings[0].attestation?.answer).toBe(long);
  });
});

describe("assemble with attestations", () => {
  const pr: Pr = {
    owner: "o",
    repo: "r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "T",
    body: "",
    headSha: "abcdef1234567890",
    baseRef: "main",
    files: [],
    fileListTruncated: false
  };
  const rules = [rule(1, "Every new function has a test", "must")];
  const results = [
    file("src/a.ts", [
      verdict(1, "UNSURE", {
        question: "Is parseDate covered by a test outside this PR?"
      })
    ])
  ];
  const build = (attestations: Attestation[], previous = null as never) =>
    assemble({
      input: {
        id: "c2",
        workspace: "ws",
        prUrl: pr.url,
        rules: null,
        strict: false,
        attestations,
        previous
      },
      pr,
      ruleSet: { rules, hash: RULES_HASH, source: "t" },
      results,
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

  it("passes on the answer and keeps the answered item in the diff as open", () => {
    const first = build([]);
    expect(first.status).toBe("unsure");
    const key = first.findings[0].key;
    const second = assemble({
      ...{
        input: {
          id: "c3",
          workspace: "ws",
          prUrl: pr.url,
          rules: null,
          strict: false,
          attestations: [answer(key)],
          previous: {
            checkId: first.id,
            headSha: pr.headSha,
            rulesHash: RULES_HASH,
            findings: first.findings
          }
        },
        pr,
        ruleSet: { rules, hash: RULES_HASH, source: "t" },
        results,
        notChecked: [],
        crossFile: [],
        intent: first.intent,
        modelCalls: 1,
        startedAt: 0,
        finishedAt: 1
      }
    });
    expect(second.status).toBe("pass");
    expect(second.ruleStatuses[0].attested).toBe(true);
    expect(second.coverageComplete).toBe(true);
    expect(second.findings[0]).toMatchObject({
      key,
      change: "open",
      attestation: { counted: true }
    });
    expect(second.previous).toMatchObject({ new: 0, open: 1, resolved: [] });
  });
});

describe("the report with an answered question", () => {
  const q = question("Q1", 2, "src/a.ts", {
    attestation: {
      answer: "Yes, test/dates.test.ts calls it.",
      headSha: "0123456789abcdef",
      at: 5,
      counted: true,
      note: null
    },
    change: "open"
  });
  const open = question("Q2", 2, "src/b.ts");
  const attested = result({
    status: "pass",
    findings: [q, open],
    ruleStatuses: [
      {
        rule: 1,
        status: "PASS",
        blocking: false,
        complete: true,
        attested: false,
        waived: false,
        detail: "passes in 1 file"
      },
      {
        rule: 2,
        status: "PASS",
        blocking: false,
        complete: true,
        attested: true,
        waived: false,
        detail: 'passes by attestation: "Yes, test/dates.test.ts calls it."'
      }
    ]
  });

  it("shows the answer, drops the steps, and lists open questions first", () => {
    const md = renderReport(attested, { json: false });
    const answered = md.indexOf("### Q1 · rule 2 · src/a.ts · key");
    const unanswered = md.indexOf("### Q2 · rule 2 · src/b.ts · key");
    expect(unanswered).toBeGreaterThan(-1);
    expect(answered).toBeGreaterThan(unanswered);
    expect(md).toContain("· still open · answered\n");
    expect(md).toContain(
      "**Answer:** Yes, test/dates.test.ts calls it. (given at `0123456`; counts as a pass by attestation)"
    );
    const item = md.slice(answered, md.indexOf("## Warnings"));
    expect(item).not.toContain("**Steps:**");
    expect(md.slice(unanswered, answered)).toContain("**Steps:**");
    expect(md).toContain("| 2 | Has a test | PASS (attested) |");
    expect(md).toContain(
      "**PASS.** All 2 rules pass on every checked file. 1 passes by attestation (see Questions)."
    );
    expect(md).toContain("an item marked answered is settled by that answer");
  });

  it("keeps the steps when the answer did not count", () => {
    const md = renderReport(
      result({
        status: "unsure",
        strict: true,
        findings: [
          {
            ...q,
            attestation: {
              ...q.attestation!,
              counted: false,
              note: "not counted: the check is strict"
            }
          }
        ]
      }),
      { json: false }
    );
    expect(md).toContain(
      "(given at `0123456`; not counted: the check is strict)"
    );
    expect(md).toContain("**Steps:**");
  });

  it("carries attestation and the answer handles in the JSON", () => {
    const m = machineReport(attested) as {
      rules: Array<{ attested: boolean }>;
      findings: Finding[];
      rerun: { mcp: { tool: string; arguments: { pr_url: string } } };
      answer: {
        api: { path: string; body: { checkId: string } };
        mcp: { tool: string; arguments: { check_id: string } };
      };
    };
    expect(m.rules.map((r) => r.attested)).toEqual([false, true]);
    expect(m.findings[0].attestation?.counted).toBe(true);
    expect(m.rerun.mcp).toEqual({
      tool: "check_pr",
      arguments: { pr_url: "https://github.com/o/r/pull/1", strict: false }
    });
    expect(m.answer.api.path).toBe("/api/answer");
    expect(m.answer.api.body.checkId).toBe("check-1");
    expect(m.answer.mcp.tool).toBe("answer_question");
    expect(m.answer.mcp.arguments.check_id).toBe("check-1");
  });
});
