import { describe, expect, it } from "vitest";
import { limits } from "../src/checker/limits";
import type { CheckResult, RuleStatus } from "../src/checker/types";
import { parseCommand } from "../src/commands";
import { ruleStats, statsMarkdown } from "../src/stats";
import { result, rule } from "./fixtures";

const PINNED =
  "Every workflow under .github/workflows/ pins each action to a major version tag";

const status = (
  ruleId: number,
  s: RuleStatus["status"],
  extra: Partial<RuleStatus> = {}
): RuleStatus => ({
  rule: ruleId,
  status: s,
  blocking: s === "FAIL",
  complete: true,
  attested: false,
  waived: false,
  detail: "",
  ...extra
});

// Two rule sets: the second inserts a rule at the front, so the test rule
// moves from 2 to 3 and the pinned rule from 1 to 2.
const older = [rule(1, PINNED, "must"), rule(2, "Has a test", "must")];
const newer = [
  rule(1, "No console.log"),
  rule(2, PINNED, "must"),
  rule(3, "Has a test", "must")
];

const check = (
  id: string,
  startedAt: number,
  prUrl: string,
  rules: typeof older,
  statuses: RuleStatus[]
): CheckResult =>
  result({
    id,
    startedAt,
    rules,
    rulesHash: rules === older ? "old" : "new",
    pr: { ...result().pr, url: prUrl },
    ruleStatuses: statuses
  });

const results = [
  check("c1", 1, "https://github.com/o/r/pull/1", older, [
    status(1, "PASS"),
    status(2, "UNSURE")
  ]),
  check("c2", 2, "https://github.com/o/r/pull/1", older, [
    status(1, "NA"),
    status(2, "UNSURE")
  ]),
  check("c3", 3, "https://github.com/o/r/pull/2", newer, [
    status(1, "FAIL"),
    status(2, "FAIL", { blocking: false, waived: true }),
    status(3, "UNSURE")
  ]),
  check("c4", 4, "https://github.com/o/r/pull/3", newer, [
    status(1, "PASS"),
    status(2, "PASS"),
    status(3, "PASS", { attested: true })
  ]),
  check("c5", 5, "https://github.com/o/r/pull/3", newer, [
    status(1, "PASS"),
    status(2, "PASS"),
    status(3, "UNSURE")
  ])
];

describe("ruleStats", () => {
  it("follows a rule by its text across rule sets and counts every outcome", () => {
    const stats = ruleStats(results, null);
    expect(stats).toMatchObject({ checks: 5, pullRequests: 3, since: 1 });
    expect(stats.rules.map((r) => [r.id, r.text])).toEqual([
      [1, "No console.log"],
      [2, PINNED],
      [3, "Has a test"]
    ]);
    expect(stats.rules[1]).toMatchObject({
      checkedBy: "pattern",
      checks: 5,
      pass: 3,
      fail: 1,
      unsure: 0,
      na: 1,
      blocking: 0,
      waived: 1,
      attested: 0,
      ambiguous: false
    });
    expect(stats.rules[2]).toMatchObject({
      checkedBy: "model",
      checks: 5,
      pass: 1,
      unsure: 4,
      attested: 1,
      ambiguous: true
    });
    expect(stats.rules[0]).toMatchObject({ checks: 3, fail: 1, blocking: 1 });
  });

  it("flags a rule ambiguous only past the minimum number of checks", () => {
    const few = ruleStats(results.slice(0, 4), null);
    const test = few.rules.find((r) => r.text === "Has a test")!;
    expect(test.checks).toBe(limits.statsMinChecks - 1);
    expect(test.unsure).toBe(3);
    expect(test.ambiguous).toBe(false);
  });

  it("numbers a rule by the workspace's current rules when it has them", () => {
    const current = {
      rules: [rule(1, "Has a test", "must"), rule(2, "No console.log")],
      hash: "cur",
      source: "s"
    };
    const stats = ruleStats(results, current);
    expect(stats.rules.map((r) => [r.id, r.text])).toEqual([
      [1, "Has a test"],
      [2, "No console.log"],
      [2, PINNED]
    ]);
  });

  it("is empty without finished checks", () => {
    expect(ruleStats([], null)).toEqual({
      checks: 0,
      pullRequests: 0,
      since: null,
      rules: []
    });
  });
});

describe("statsMarkdown", () => {
  it("prints one row per rule with the ambiguity flag in the note", () => {
    const md = statsMarkdown(ruleStats(results, null));
    expect(md).toContain(
      "5 checks of 3 pull requests since 1970-01-01. A rule that is UNSURE more than half the time over 5 or more checks is flagged ambiguous."
    );
    expect(md).toContain(
      "| # | Rule | Checks | PASS | FAIL | UNSURE | NA | Waived | Note |"
    );
    expect(md).toContain("| 1 | No console.log | 3 | 2 | 1 | 0 | 0 | 0 |  |");
    expect(md).toContain(
      `| 2 | ${PINNED} | 5 | 3 | 1 | 0 | 1 | 1 | checked by pattern |`
    );
    expect(md).toContain(
      "| 3 | Has a test | 5 | 1 | 0 | 4 | 0 | 0 | ambiguous: rewrite or split; 1 by attestation |"
    );
    expect(statsMarkdown(ruleStats([], null))).toBe(
      "No finished checks in this workspace yet."
    );
  });
});

describe("the stats command", () => {
  it("is a word on its own", () => {
    expect(parseCommand(" Stats ")).toEqual({ kind: "stats" });
    expect(parseCommand("stats please")).toEqual({ kind: "chat" });
  });
});
