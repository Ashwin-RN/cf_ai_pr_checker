import { limits } from "./limits";
import { ruleApplies } from "./rules";
import { MORE_FILES } from "./select";
import type {
  CheckStatus,
  CrossFileVerdict,
  FileCheck,
  Finding,
  FindingKind,
  Intent,
  Rule,
  RuleStatus,
  Skipped
} from "./types";
import { normalise } from "./verify";

// FNV-1a over the parts: short, deterministic, no async.
export function stableKey(parts: Array<string | number | null>): string {
  let h = 0x811c9dc5;
  for (const ch of parts.map(String).join("\u0000")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function at(path: string, line: number | null): string {
  return line === null ? path : `${path}:${line}`;
}

// Files a rule needed that the check did not fully cover. A rule scoped to
// one directory is not downgraded by gaps elsewhere.
export function ruleGaps(
  rule: Rule,
  files: FileCheck[],
  notChecked: Skipped[]
): string[] {
  const gaps: string[] = [];
  for (const n of notChecked) {
    if (n.coverage && (n.path === MORE_FILES || ruleApplies(rule, n.path))) {
      gaps.push(n.path);
    }
  }
  for (const f of files) {
    if (
      ruleApplies(rule, f.path) &&
      (f.state === "failed" || f.coverage === "partial")
    ) {
      gaps.push(f.path);
    }
  }
  return gaps;
}

function listed(paths: string[]): string {
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `${paths.slice(0, 3).join(", ")}${more}`;
}

// Per rule, across files: verified FAIL wins, then a cross-file FAIL, then
// anything unsettled, then PASS when nothing in scope was left unchecked.
export function ruleStatuses(
  rules: Rule[],
  files: FileCheck[],
  notChecked: Skipped[],
  crossFile: CrossFileVerdict[] = [],
  strict = false
): RuleStatus[] {
  const checked = files.filter((f) => f.state === "checked");
  return rules.map((rule) => {
    const gaps = ruleGaps(rule, files, notChecked);
    const complete = gaps.length === 0;
    const hits = checked.flatMap((f) =>
      f.verdicts
        .filter((v) => v.rule === rule.id)
        .map((v) => ({ path: f.path, v }))
    );
    const fails = hits.filter((h) => h.v.verdict === "FAIL" && h.v.verified);
    if (fails.length) {
      const introduced = fails.filter((h) => h.v.origin !== "pre-existing");
      const first = introduced[0] ?? fails[0];
      const where = at(first.path, first.v.line);
      let detail =
        fails.length === 1
          ? `fails in ${where}`
          : `fails in ${fails.length} files, first ${where}`;
      if (!introduced.length) {
        detail +=
          fails.length === 1
            ? " on a line this pull request does not change"
            : ", all on lines this pull request does not change";
      }
      return {
        rule: rule.id,
        status: "FAIL",
        blocking: strict || introduced.length > 0,
        detail
      };
    }
    const settle = crossFile.find((c) => c.rule === rule.id);
    if (settle?.verdict === "FAIL") {
      return {
        rule: rule.id,
        status: "FAIL",
        blocking: true,
        detail: `fails across files: ${settle.reason}`
      };
    }
    const unverified = hits.find(
      (h) => h.v.verdict === "FAIL" && !h.v.verified
    );
    if (unverified) {
      return {
        rule: rule.id,
        status: "UNSURE",
        blocking: false,
        detail: `possible fail in ${unverified.path}, quote not verified`
      };
    }
    if (settle?.verdict === "PASS") {
      return complete
        ? {
            rule: rule.id,
            status: "PASS",
            blocking: false,
            detail: `settled across files from ${settle.facts.length} fact${settle.facts.length === 1 ? "" : "s"}`
          }
        : {
            rule: rule.id,
            status: "UNSURE",
            blocking: false,
            detail: `passes across the checked files; not checked: ${listed(gaps)}`
          };
    }
    const unsure = hits.filter((h) => h.v.verdict === "UNSURE");
    if (unsure.length) {
      return {
        rule: rule.id,
        status: "UNSURE",
        blocking: false,
        detail: `needs an answer for ${listed(unsure.map((h) => h.path))}`
      };
    }
    const passes = hits.filter((h) => h.v.verdict === "PASS").length;
    if (passes) {
      return complete
        ? {
            rule: rule.id,
            status: "PASS",
            blocking: false,
            detail: `passes in ${passes} file${passes === 1 ? "" : "s"}`
          }
        : {
            rule: rule.id,
            status: "UNSURE",
            blocking: false,
            detail: `passes on the checked files; not checked: ${listed(gaps)}`
          };
    }
    if (settle?.verdict === "UNSURE") {
      return {
        rule: rule.id,
        status: "UNSURE",
        blocking: false,
        detail: `needs an answer across files: ${settle.question ?? settle.reason}`
      };
    }
    if (checked.length === 0) {
      return {
        rule: rule.id,
        status: "UNSURE",
        blocking: false,
        detail: "no file could be checked"
      };
    }
    if (!complete) {
      return {
        rule: rule.id,
        status: "UNSURE",
        blocking: false,
        detail: `not triggered by the checked files; not checked: ${listed(gaps)}`
      };
    }
    return {
      rule: rule.id,
      status: "NA",
      blocking: false,
      detail: "not triggered by this PR"
    };
  });
}

export function overallStatus(statuses: RuleStatus[]): CheckStatus {
  if (statuses.some((s) => s.blocking)) return "fail";
  if (statuses.some((s) => s.status === "UNSURE")) return "unsure";
  return "pass";
}

type Draft = Omit<Finding, "id" | "change">;

function byRuleThenPath(a: Draft, b: Draft): number {
  return (
    (a.rule ?? 0) - (b.rule ?? 0) ||
    a.path.localeCompare(b.path) ||
    (a.line ?? 0) - (b.line ?? 0)
  );
}

function byPathThenLine(a: Draft, b: Draft): number {
  return (
    Number(a.line === null) - Number(b.line === null) ||
    a.path.localeCompare(b.path) ||
    (a.line ?? 0) - (b.line ?? 0)
  );
}

function number(drafts: Draft[], prefix: string, max = Infinity): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const d of drafts) {
    if (seen.has(d.key) || out.length >= max) continue;
    seen.add(d.key);
    out.push({ id: `${prefix}${out.length + 1}`, change: null, ...d });
  }
  return out;
}

const DESCRIPTION = "(description)";

// Blocking from verified FAILs, questions from UNSURE and unverified FAILs,
// warnings from the per-file notes and intent drift. Keys are stable across runs.
export function buildFindings(
  rules: Rule[],
  files: FileCheck[],
  crossFile: CrossFileVerdict[] = [],
  intent: Intent | null = null
): Finding[] {
  const blocking: Draft[] = [];
  const questions: Draft[] = [];
  const warnings: Draft[] = [];
  const settled = new Set(
    crossFile
      .filter((c) => c.verdict === "PASS" || c.verdict === "FAIL")
      .map((c) => c.rule)
  );
  for (const f of files) {
    if (f.state !== "checked") continue;
    for (const v of f.verdicts) {
      if (v.verdict !== "FAIL" && v.verdict !== "UNSURE") continue;
      const rule = rules.find((r) => r.id === v.rule);
      const kind: FindingKind =
        v.verdict === "FAIL" && v.verified ? "blocking" : "question";
      if (kind === "question" && settled.has(v.rule)) continue;
      const unverifiedFail = v.verdict === "FAIL" && !v.verified;
      const fallbackQuestion = unverifiedFail
        ? `Does ${f.path} contain this: ${v.quote ?? v.reason}?`
        : `Confirm: ${v.reason}`;
      const draft: Draft = {
        key: stableKey([
          kind,
          v.rule,
          f.path,
          v.quote ? normalise(v.quote) : ""
        ]),
        kind,
        rule: v.rule,
        path: f.path,
        line: v.line,
        quote: v.quote,
        origin: kind === "blocking" ? v.origin : null,
        summary: v.reason,
        why: v.why || (rule ? `Rule ${rule.id}: ${rule.text}` : ""),
        steps: v.steps,
        resolution: v.resolution,
        question: kind === "question" ? v.question || fallbackQuestion : null,
        note: unverifiedFail
          ? `possible fail; ${v.note ?? "the quote was not found in the file"}`
          : v.note
      };
      (kind === "blocking" ? blocking : questions).push(draft);
    }
    for (const w of f.warnings) {
      const restates = [...blocking, ...questions].some(
        (d) => d.path === f.path && d.line !== null && d.line === w.line
      );
      if (restates) continue;
      warnings.push({
        key: stableKey(["warning", f.path, normalise(w.note)]),
        kind: "warning",
        rule: null,
        path: f.path,
        line: w.line,
        quote: null,
        origin: null,
        summary: w.note,
        why: w.why,
        steps: w.steps,
        resolution: null,
        question: null,
        note: null
      });
    }
  }
  for (const c of crossFile) {
    if (c.verdict !== "FAIL" && c.verdict !== "UNSURE") continue;
    if (c.verdict === "UNSURE" && questions.some((q) => q.rule === c.rule)) {
      continue;
    }
    const rule = rules.find((r) => r.id === c.rule);
    const kind: FindingKind = c.verdict === "FAIL" ? "blocking" : "question";
    const facts = c.facts.map((f) => f.text).join("; ");
    const draft: Draft = {
      key: stableKey([kind, c.rule, "cross-file"]),
      kind,
      rule: c.rule,
      path: c.facts[0]?.path ?? files[0]?.path ?? "",
      line: null,
      quote: null,
      origin: kind === "blocking" ? "introduced" : null,
      summary: c.reason,
      why: c.why || (rule ? `Rule ${rule.id}: ${rule.text}` : ""),
      steps: c.steps,
      resolution: c.resolution,
      question:
        kind === "question" ? c.question || `Confirm: ${c.reason}` : null,
      note:
        [c.note, facts ? `across files, from: ${facts}` : null]
          .filter(Boolean)
          .join("; ") || null
    };
    (kind === "blocking" ? blocking : questions).push(draft);
  }
  for (const u of intent?.unmentioned ?? []) {
    warnings.push({
      key: stableKey(["intent", "unmentioned", u.path, normalise(u.text)]),
      kind: "warning",
      rule: null,
      path: u.path,
      line: null,
      quote: null,
      origin: null,
      summary: `Not in the description: ${u.text}${u.note ? ` (${u.note})` : ""}`,
      why: "Reviewers read the description first; a change it does not name gets less attention.",
      steps: [
        "Add this change to the description, or move it to its own pull request."
      ],
      resolution: null,
      question: null,
      note: null
    });
  }
  for (const claim of intent?.unsupported ?? []) {
    warnings.push({
      key: stableKey(["intent", "unsupported", normalise(claim)]),
      kind: "warning",
      rule: null,
      path: DESCRIPTION,
      line: null,
      quote: null,
      origin: null,
      summary: `Described but not seen in the changed files: ${claim}`,
      why: "A description that promises more than the code does misleads the reviewer.",
      steps: [
        "Point to the file that makes this change, or take the claim out of the description."
      ],
      resolution: null,
      question: null,
      note: null
    });
  }
  blocking.sort(byRuleThenPath);
  questions.sort(byRuleThenPath);
  warnings.sort(byPathThenLine);
  return [
    ...number(blocking, "F"),
    ...number(questions, "Q"),
    ...number(warnings, "W", limits.warningsPerReport)
  ];
}
