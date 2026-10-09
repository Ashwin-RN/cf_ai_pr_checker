import { describe, expect, it } from "vitest";
import {
  type Case,
  type Out,
  failed,
  score,
  summarise
} from "../eval/score.ts";

const c: Case = {
  name: "no-test",
  prUrl: "https://github.com/o/r/pull/8",
  headSha: "dc71718ef3cc063d31fc0bf9381774843b37b18c",
  status: "fail",
  rules: { "1": "PASS", "4": "FAIL" }
};

function answer(extra: Partial<Out> = {}): Out {
  return {
    status: "fail",
    pr: { head_sha: c.headSha },
    rules: [
      { id: 1, status: "PASS", blocking: false },
      { id: 4, status: "FAIL", blocking: true }
    ],
    model_calls: 3,
    findings: [],
    ...extra
  };
}

const ok = { ok: true, status: 200 };

describe("score", () => {
  it("scores a case that came back as expected", () => {
    const row = score(c, ok, answer(), 1.5);
    expect(row).toMatchObject({
      status: "fail",
      wrong: [],
      broken: [],
      falsePass: 0,
      calls: 3,
      seconds: 1.5
    });
    expect(failed([row])).toBe(false);
  });

  it("counts a false PASS once and fails the run on it", () => {
    const row = score(
      c,
      ok,
      answer({
        status: "pass",
        rules: [
          { id: 1, status: "PASS", blocking: false },
          { id: 4, status: "PASS", blocking: false }
        ]
      }),
      1
    );
    expect(row.wrong).toEqual(["4: PASS not FAIL", "status: pass not fail"]);
    expect(row.falsePass).toBe(1);
    expect(failed([row])).toBe(true);
  });

  it("fails the run when the rules are right but the status lets the pull request through", () => {
    const row = score(
      c,
      ok,
      answer({
        status: "pass",
        rules: [
          { id: 1, status: "PASS", blocking: false },
          { id: 4, status: "FAIL", blocking: false }
        ]
      }),
      1
    );
    expect(row.wrong).toEqual(["status: pass not fail"]);
    expect(row.falsePass).toBe(1);
    expect(failed([row])).toBe(true);
  });

  it("counts a rule that should block and does not as a false PASS", () => {
    const strict: Case = { ...c, blocking: { "4": true } };
    const row = score(
      strict,
      ok,
      answer({
        status: "pass",
        rules: [
          { id: 1, status: "PASS", blocking: false },
          { id: 4, status: "FAIL", blocking: false }
        ]
      }),
      1
    );
    expect(row.wrong).toEqual([
      "4: does not block but should",
      "status: pass not fail"
    ]);
    expect(row.falsePass).toBe(1);
    expect(failed([row])).toBe(true);
  });

  it("fails the run when a rule that should block comes back UNSURE while another rule keeps the status at fail", () => {
    const expected: Case = {
      ...c,
      rules: { "1": "FAIL", "4": "FAIL" },
      blocking: { "4": true }
    };
    const row = score(
      expected,
      ok,
      answer({
        status: "fail",
        rules: [
          { id: 1, status: "FAIL", blocking: true },
          { id: 4, status: "UNSURE", blocking: false }
        ]
      }),
      1
    );
    expect(row.wrong).toEqual([
      "4: UNSURE not FAIL",
      "4: does not block but should"
    ]);
    expect(row.missed).toBe(1);
    expect(row.falsePass).toBe(1);
    expect(failed([row])).toBe(true);
  });

  it("counts a rule that blocks and should not as a false FAIL, which does not fail the run", () => {
    const preExisting: Case = {
      ...c,
      status: "pass",
      rules: { "1": "FAIL" },
      blocking: { "1": false }
    };
    const row = score(
      preExisting,
      ok,
      answer({
        status: "fail",
        rules: [{ id: 1, status: "FAIL", blocking: true }]
      }),
      1
    );
    expect(row.wrong).toEqual([
      "1: blocks but should not",
      "status: fail not pass"
    ]);
    expect(row.falseFail).toBe(1);
    expect(row.falsePass).toBe(0);
    expect(failed([row])).toBe(false);
  });

  it("marks an HTTP error as broken, not as a clean row", () => {
    const row = score(
      c,
      { ok: false, status: 502 },
      { error: "gone" } as Out,
      1
    );
    expect(row.status).toBe("error 502");
    expect(row.broken).toEqual(["the checker answered 502: gone"]);
    expect(failed([row])).toBe(true);
  });

  it("marks a missing expected rule as broken instead of skipping it", () => {
    const row = score(c, ok, answer({ status: "pass", rules: [] }), 1);
    expect(row.broken).toEqual([
      "rule 1 is missing from the answer",
      "rule 4 is missing from the answer"
    ]);
    expect(failed([row])).toBe(true);
  });

  it("marks a moved head as broken", () => {
    const row = score(c, ok, answer({ pr: { head_sha: "0000000abcdef" } }), 1);
    expect(row.broken).toEqual(["head is 0000000, the case expects dc71718"]);
    expect(failed([row])).toBe(true);
  });

  it("treats PASS and NA as the same answer, and counts a missed FAIL", () => {
    const row = score(
      c,
      ok,
      answer({
        status: "unsure",
        rules: [
          { id: 1, status: "NA", blocking: false },
          { id: 4, status: "UNSURE", blocking: false }
        ]
      }),
      1
    );
    expect(row.wrong).toEqual(["4: UNSURE not FAIL"]);
    expect(row.missed).toBe(1);
    expect(row.unsure).toBe(1);
    expect(failed([row])).toBe(false);
  });

  it("summarises the rows in one line", () => {
    const rows = [
      score(c, ok, answer(), 1.2),
      score(c, { ok: false, status: 502 }, null, 0.3)
    ];
    expect(summarise(rows)).toBe(
      "2 cases, 1 with the wrong status, 1 broken. False PASS 0, false FAIL 0, missed 0, UNSURE rules 0, model calls 3, 1.5s."
    );
  });
});
