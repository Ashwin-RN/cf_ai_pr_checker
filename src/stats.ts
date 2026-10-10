import { limits } from "./checker/limits";
import { mechanicalKind } from "./checker/mechanical";
import type { CheckResult, RuleSet } from "./checker/types";
import { normalise } from "./checker/verify";

// How one rule has fared across the finished checks of a workspace. Rules
// are told apart by their text, not their number: a number is a position
// in a rules file and moves when the file changes.
export type RuleStat = {
  // The rule's number in the workspace's current rules, else the number it
  // last had.
  id: number | null;
  text: string;
  checkedBy: "pattern" | "model";
  checks: number;
  pass: number;
  fail: number;
  unsure: number;
  na: number;
  blocking: number;
  waived: number;
  attested: number;
  // UNSURE more than half the time over enough checks: the rule as written
  // is not one the check can settle. Rewrite or split it.
  ambiguous: boolean;
};

export type Stats = {
  checks: number;
  pullRequests: number;
  since: number | null;
  rules: RuleStat[];
};

export function ruleStats(
  results: CheckResult[],
  current: RuleSet | null
): Stats {
  type Running = RuleStat & { lastSeen: number };
  const byText = new Map<string, Running>();
  const pullRequests = new Set<string>();
  let since: number | null = null;
  for (const r of results) {
    pullRequests.add(r.pr.url);
    since = since === null ? r.startedAt : Math.min(since, r.startedAt);
    for (const s of r.ruleStatuses) {
      const rule = r.rules.find((x) => x.id === s.rule);
      if (!rule) continue;
      const key = normalise(rule.text);
      let stat = byText.get(key);
      if (!stat) {
        stat = {
          id: null,
          text: rule.text,
          checkedBy: mechanicalKind(rule.text) ? "pattern" : "model",
          checks: 0,
          pass: 0,
          fail: 0,
          unsure: 0,
          na: 0,
          blocking: 0,
          waived: 0,
          attested: 0,
          ambiguous: false,
          lastSeen: -1
        };
        byText.set(key, stat);
      }
      stat.checks++;
      if (s.status === "PASS") stat.pass++;
      else if (s.status === "FAIL") stat.fail++;
      else if (s.status === "UNSURE") stat.unsure++;
      else stat.na++;
      if (s.blocking) stat.blocking++;
      if (s.waived) stat.waived++;
      if (s.attested) stat.attested++;
      if (r.startedAt > stat.lastSeen) {
        stat.lastSeen = r.startedAt;
        stat.id = rule.id;
      }
    }
  }
  const currentIds = new Map(
    (current?.rules ?? []).map((r) => [normalise(r.text), r.id])
  );
  // The workspace's current rules come first in their own order; rules seen
  // only in other sets follow, by the number they last had.
  const rules = [...byText.entries()]
    .map(([key, { lastSeen: _seen, ...stat }]) => ({
      current: currentIds.has(key),
      stat: {
        ...stat,
        id: currentIds.get(key) ?? stat.id,
        ambiguous:
          stat.checks >= limits.statsMinChecks && stat.unsure * 2 > stat.checks
      } satisfies RuleStat
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (a.stat.id ?? Infinity) - (b.stat.id ?? Infinity) ||
        b.stat.checks - a.stat.checks ||
        a.stat.text.localeCompare(b.stat.text)
    )
    .map((x) => x.stat);
  return {
    checks: results.length,
    pullRequests: pullRequests.size,
    since,
    rules
  };
}

function note(s: RuleStat): string {
  const notes: string[] = [];
  if (s.ambiguous) notes.push("ambiguous: rewrite or split");
  if (s.attested) notes.push(`${s.attested} by attestation`);
  if (s.checkedBy === "pattern") notes.push("checked by pattern");
  return notes.join("; ");
}

// The statistics as a table, for the chat and the MCP tool.
export function statsMarkdown(stats: Stats): string {
  if (!stats.checks) return "No finished checks in this workspace yet.";
  const since = stats.since
    ? ` since ${new Date(stats.since).toISOString().slice(0, 10)}`
    : "";
  const head = `${stats.checks} check${stats.checks === 1 ? "" : "s"} of ${stats.pullRequests} pull request${stats.pullRequests === 1 ? "" : "s"}${since}. A rule that is UNSURE more than half the time over ${limits.statsMinChecks} or more checks is flagged ambiguous.`;
  const rows = stats.rules.map(
    (s) =>
      `| ${s.id ?? "–"} | ${s.text.replace(/\|/g, "\\|")} | ${s.checks} | ${s.pass} | ${s.fail} | ${s.unsure} | ${s.na} | ${s.waived} | ${note(s)} |`
  );
  return [
    head,
    "",
    "| # | Rule | Checks | PASS | FAIL | UNSURE | NA | Waived | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}
