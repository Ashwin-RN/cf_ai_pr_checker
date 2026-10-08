import { limits } from "./limits";
import type {
  CheckStatus,
  FileCheck,
  Finding,
  FindingKind,
  Rule,
  RuleStatus
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

// Per rule, across files: verified FAIL wins, then anything unsettled, then PASS.
export function ruleStatuses(
  rules: Rule[],
  files: FileCheck[],
  coverageComplete: boolean
): RuleStatus[] {
  const checked = files.filter((f) => f.state === "checked");
  const allChecked = coverageComplete && checked.length === files.length;
  return rules.map((rule) => {
    const hits = checked.flatMap((f) =>
      f.verdicts
        .filter((v) => v.rule === rule.id)
        .map((v) => ({ path: f.path, v }))
    );
    const fails = hits.filter((h) => h.v.verdict === "FAIL" && h.v.verified);
    if (fails.length) {
      const where = at(fails[0].path, fails[0].v.line);
      const detail =
        fails.length === 1
          ? `fails in ${where}`
          : `fails in ${fails.length} files, first ${where}`;
      return { rule: rule.id, status: "FAIL", detail };
    }
    const unverified = hits.find(
      (h) => h.v.verdict === "FAIL" && !h.v.verified
    );
    if (unverified) {
      return {
        rule: rule.id,
        status: "UNSURE",
        detail: `possible fail in ${unverified.path}, quote not verified`
      };
    }
    const unsure = hits.filter((h) => h.v.verdict === "UNSURE");
    if (unsure.length) {
      const names = unsure.map((h) => h.path);
      const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
      return {
        rule: rule.id,
        status: "UNSURE",
        detail: `needs an answer for ${names.slice(0, 3).join(", ")}${more}`
      };
    }
    const passes = hits.filter((h) => h.v.verdict === "PASS").length;
    if (passes) {
      if (allChecked) {
        return {
          rule: rule.id,
          status: "PASS",
          detail: `passes in ${passes} file${passes === 1 ? "" : "s"}`
        };
      }
      return {
        rule: rule.id,
        status: "UNSURE",
        detail: "passes on the checked files; some files were not checked"
      };
    }
    if (checked.length === 0) {
      return {
        rule: rule.id,
        status: "UNSURE",
        detail: "no file could be checked"
      };
    }
    return { rule: rule.id, status: "NA", detail: "not triggered by this PR" };
  });
}

export function overallStatus(statuses: RuleStatus[]): CheckStatus {
  if (statuses.some((s) => s.status === "FAIL")) return "fail";
  if (statuses.some((s) => s.status === "UNSURE")) return "unsure";
  return "pass";
}

type Draft = Omit<Finding, "id">;

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
    out.push({ id: `${prefix}${out.length + 1}`, ...d });
  }
  return out;
}

// Blocking from verified FAILs, questions from UNSURE and unverified FAILs,
// warnings from the per-file notes. Keys are stable across runs.
export function buildFindings(rules: Rule[], files: FileCheck[]): Finding[] {
  const blocking: Draft[] = [];
  const questions: Draft[] = [];
  const warnings: Draft[] = [];
  for (const f of files) {
    if (f.state !== "checked") continue;
    for (const v of f.verdicts) {
      if (v.verdict !== "FAIL" && v.verdict !== "UNSURE") continue;
      const rule = rules.find((r) => r.id === v.rule);
      const kind: FindingKind =
        v.verdict === "FAIL" && v.verified ? "blocking" : "question";
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
        summary: v.reason,
        why: v.why || (rule ? `Rule ${rule.id}: ${rule.text}` : ""),
        steps: v.steps,
        resolution: v.resolution,
        question: kind === "question" ? v.question || fallbackQuestion : null,
        note: unverifiedFail
          ? `possible fail; ${v.note ?? "the quote was not found in the diff"}`
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
        key: stableKey(["warning", f.path, w.line]),
        kind: "warning",
        rule: null,
        path: f.path,
        line: w.line,
        quote: null,
        summary: w.note,
        why: w.why,
        steps: w.steps,
        resolution: null,
        question: null,
        note: null
      });
    }
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
