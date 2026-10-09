import { limits } from "./limits";
import { ruleApplies } from "./rules";
import { MORE_FILES } from "./select";
import type {
  CheckStatus,
  CrossFileVerdict,
  FileCheck,
  FileVerdict,
  Finding,
  Intent,
  Rule,
  RuleStatus,
  Skipped,
  Verdict
} from "./types";
import { normalise } from "./verify";

// Where a finding sits when it is not in one file.
export const ACROSS_FILES = "(across files)";
export const DESCRIPTION = "(description)";

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

// Whether a checked file settles a rule for its own path. A file checked
// around its changes settles a prohibition and a rule that spans files, both
// of which are about the change; a per-file requirement may be met anywhere
// in the file, so the part not shown is a gap.
export function covers(file: FileCheck, rule: Rule | null): boolean {
  if (file.state !== "checked" || file.coverage === "partial") return false;
  if (file.coverage === "full") return true;
  return (
    rule === null || rule.polarity === "must_not" || rule.scope === "cross_file"
  );
}

// Files a rule needed that the check did not cover for it. A rule scoped to
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
    if (ruleApplies(rule, f.path) && !covers(f, rule)) gaps.push(f.path);
  }
  return gaps;
}

function listed(paths: string[]): string {
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `${paths.slice(0, 3).join(", ")}${more}`;
}

// A cross-file verdict rests on each file's summary of itself, not on code.
// A FAIL from it stands only when every file the rule needed was checked and
// no summary was cut short; otherwise what the rule requires may sit in what
// was not seen, and the fail is a question.
export function gateCrossFile(
  rules: Rule[],
  crossFile: CrossFileVerdict[],
  files: FileCheck[],
  notChecked: Skipped[],
  factsCut: boolean
): CrossFileVerdict[] {
  const capped = files
    .filter(
      (f) => f.state === "checked" && f.facts.length >= limits.factsPerFile
    )
    .map((f) => f.path);
  return crossFile.map((c) => {
    if (c.verdict !== "FAIL") return c;
    const rule = rules.find((r) => r.id === c.rule);
    const gaps = rule ? ruleGaps(rule, files, notChecked) : [];
    const reasons = [
      gaps.length ? `not checked: ${listed(gaps)}` : null,
      capped.length
        ? `more facts than could be listed for ${listed(capped)}`
        : null,
      factsCut ? "the fact list was cut at its cap" : null
    ].filter((s): s is string => s !== null);
    if (!reasons.length) return c;
    const reason = c.reason.replace(/\.$/, "");
    return {
      ...c,
      verdict: "UNSURE",
      note: [
        c.note,
        `a fail across files stands only on complete facts; ${reasons.join("; ")}`
      ]
        .filter(Boolean)
        .join("; "),
      question:
        c.question ||
        `On the facts seen rule ${c.rule} fails (${reason}). Is what it requires in a file or a fact the check did not see?`
    };
  });
}

// Per rule, across files. A rule one file can decide: verified FAIL wins,
// then anything unsettled, then PASS when nothing in scope was left
// unchecked. A rule that spans files takes the cross-file verdict; a file's
// own verdict on it was one of that step's inputs and never decides alone.
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
    const status = (
      s: Verdict,
      blocking: boolean,
      detail: string
    ): RuleStatus => ({ rule: rule.id, status: s, blocking, complete, detail });
    const hits = checked.flatMap((f) =>
      f.verdicts
        .filter((v) => v.rule === rule.id)
        .map((v) => ({ path: f.path, v }))
    );
    if (rule.scope === "cross_file") {
      const settle = crossFile.find((c) => c.rule === rule.id);
      if (settle?.verdict === "FAIL") {
        return status("FAIL", true, `fails across files: ${settle.reason}`);
      }
      if (settle?.verdict === "PASS") {
        return complete
          ? status(
              "PASS",
              false,
              `settled across files from ${settle.facts.length} fact${settle.facts.length === 1 ? "" : "s"}`
            )
          : status(
              "UNSURE",
              false,
              `passes across the checked files; not checked: ${listed(gaps)}`
            );
      }
      if (settle?.verdict === "UNSURE") {
        return status(
          "UNSURE",
          false,
          `needs an answer across files: ${settle.question ?? settle.reason}`
        );
      }
      if (settle?.verdict === "NA") {
        return complete
          ? status("NA", false, "not triggered by this PR")
          : status(
              "UNSURE",
              false,
              `not triggered by the checked files; not checked: ${listed(gaps)}`
            );
      }
      if (checked.length === 0) {
        return status("UNSURE", false, "no file could be checked");
      }
      const fail = hits.find((h) => h.v.verdict === "FAIL");
      return status(
        "UNSURE",
        false,
        fail
          ? `possible fail in ${fail.path}; needs the cross-file step, which did not run`
          : "needs the cross-file step, which did not run"
      );
    }
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
      return status("FAIL", strict || introduced.length > 0, detail);
    }
    const unverified = hits.find(
      (h) => h.v.verdict === "FAIL" && !h.v.verified
    );
    if (unverified) {
      return status(
        "UNSURE",
        false,
        `possible fail in ${unverified.path}, quote not verified`
      );
    }
    const unsure = hits.filter((h) => h.v.verdict === "UNSURE");
    if (unsure.length) {
      return status(
        "UNSURE",
        false,
        `needs an answer for ${listed(unsure.map((h) => h.path))}`
      );
    }
    const claimed = hits.filter((h) => h.v.verdict === "PASS" && !h.v.verified);
    if (claimed.length) {
      return status(
        "UNSURE",
        false,
        `pass claimed without a verified quote in ${listed(claimed.map((h) => h.path))}`
      );
    }
    const passes = hits.filter((h) => h.v.verdict === "PASS").length;
    if (passes) {
      return complete
        ? status(
            "PASS",
            false,
            `passes in ${passes} file${passes === 1 ? "" : "s"}`
          )
        : status(
            "UNSURE",
            false,
            `passes on the checked files; not checked: ${listed(gaps)}`
          );
    }
    if (checked.length === 0) {
      return status("UNSURE", false, "no file could be checked");
    }
    if (!complete) {
      return status(
        "UNSURE",
        false,
        `not triggered by the checked files; not checked: ${listed(gaps)}`
      );
    }
    return status("NA", false, "not triggered by this PR");
  });
}

// Fail on a blocking rule; unsure when any rule is unsettled or has a file in
// its scope the check did not cover; pass only when neither holds.
export function overallStatus(statuses: RuleStatus[]): CheckStatus {
  if (statuses.some((s) => s.blocking)) return "fail";
  if (statuses.some((s) => s.status === "UNSURE" || !s.complete)) {
    return "unsure";
  }
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

// What one file's verdict raises: a block for a verified FAIL on a rule the
// file can decide, a question for anything claimed but not shown, nothing
// for NA and a verified PASS. One verdict per rule per file, so the key
// needs no kind: a FAIL that becomes a question keeps its key.
function fileDraft(
  rule: Rule | undefined,
  file: FileCheck,
  v: FileVerdict
): Draft | null {
  if (v.verdict === "NA" || (v.verdict === "PASS" && v.verified)) return null;
  const spans = rule?.scope === "cross_file";
  const blocks = v.verdict === "FAIL" && v.verified && !spans;
  const draft: Draft = {
    key: stableKey([v.rule, file.path, v.quote ? normalise(v.quote) : ""]),
    kind: blocks ? "blocking" : "question",
    rule: v.rule,
    path: file.path,
    line: v.line,
    quote: v.quote,
    origin: blocks ? v.origin : null,
    summary: v.reason,
    why: v.why || (rule ? `Rule ${rule.id}: ${rule.text}` : ""),
    steps: v.steps,
    resolution: v.resolution,
    question: null,
    note: v.note
  };
  if (blocks) return draft;
  if (v.verdict === "FAIL" && v.verified) {
    draft.note =
      "possible fail; the rule spans files and the cross-file step did not run";
    draft.question =
      v.question ||
      `Does another file in this pull request supply what rule ${v.rule} requires for ${file.path}?`;
  } else if (v.verdict === "FAIL") {
    draft.note = `possible fail; ${v.note ?? "the quote was not found in the file"}`;
    draft.question =
      v.question || `Does ${file.path} contain this: ${v.quote ?? v.reason}?`;
  } else if (v.verdict === "PASS") {
    draft.note = `possible pass; ${v.note ?? "no line was quoted"}`;
    draft.question = v.quote
      ? `Does ${file.path} contain this: ${v.quote}?`
      : `Where does ${file.path} meet rule ${v.rule}? The check claimed a pass without quoting a line.`;
  } else {
    draft.question = v.question || `Confirm: ${v.reason}`;
  }
  return draft;
}

// Blocking from verified FAILs, questions from everything claimed but not
// shown, warnings from the per-file notes and intent drift. Keys are stable
// across runs.
export function buildFindings(
  rules: Rule[],
  files: FileCheck[],
  crossFile: CrossFileVerdict[] = [],
  intent: Intent | null = null
): Finding[] {
  const blocking: Draft[] = [];
  const questions: Draft[] = [];
  const warnings: Draft[] = [];
  // The cross-file step answers for the rules it settled; a file's own
  // verdict on such a rule was one of its inputs.
  const settled = new Set(crossFile.map((c) => c.rule));
  for (const f of files) {
    if (f.state !== "checked") continue;
    for (const v of f.verdicts) {
      if (settled.has(v.rule)) continue;
      const draft = fileDraft(
        rules.find((r) => r.id === v.rule),
        f,
        v
      );
      if (!draft) continue;
      (draft.kind === "blocking" ? blocking : questions).push(draft);
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
    const rule = rules.find((r) => r.id === c.rule);
    const blocks = c.verdict === "FAIL";
    const facts = c.facts.map((f) => f.text).join("; ");
    const draft: Draft = {
      key: stableKey([c.rule, ACROSS_FILES]),
      kind: blocks ? "blocking" : "question",
      rule: c.rule,
      path: ACROSS_FILES,
      line: null,
      quote: null,
      origin: blocks ? "introduced" : null,
      summary: c.reason,
      why: c.why || (rule ? `Rule ${rule.id}: ${rule.text}` : ""),
      steps: c.steps,
      resolution: c.resolution,
      question: blocks ? null : c.question || `Confirm: ${c.reason}`,
      note:
        [c.note, facts ? `across files, from: ${facts}` : null]
          .filter(Boolean)
          .join("; ") || null
    };
    (blocks ? blocking : questions).push(draft);
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
