import { limits } from "./limits";
import { ruleApplies } from "./rules";
import { MORE_FILES } from "./select";
import type {
  Attestation,
  CheckStatus,
  CrossFileVerdict,
  FileCheck,
  FileVerdict,
  Finding,
  Intent,
  Rule,
  RuleStatus,
  Skipped,
  Verdict,
  Waiver
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
// in the file, so the part not shown is a gap. Under strict a failure on an
// unchanged line blocks, and one may sit outside the parts shown, so such a
// file is a gap for every rule.
export function covers(
  file: FileCheck,
  rule: Rule | null,
  strict = false
): boolean {
  if (file.state !== "checked" || file.coverage === "partial") return false;
  if (file.coverage === "full") return true;
  if (strict) return false;
  return (
    rule === null || rule.polarity === "must_not" || rule.scope === "cross_file"
  );
}

// Files a rule needed that the check did not cover for it. A rule scoped to
// one directory is not downgraded by gaps elsewhere.
export function ruleGaps(
  rule: Rule,
  files: FileCheck[],
  notChecked: Skipped[],
  strict = false
): string[] {
  const gaps: string[] = [];
  for (const n of notChecked) {
    if (n.coverage && (n.path === MORE_FILES || ruleApplies(rule, n.path))) {
      gaps.push(n.path);
    }
  }
  for (const f of files) {
    if (ruleApplies(rule, f.path) && !covers(f, rule, strict)) {
      gaps.push(f.path);
    }
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
// was not seen. A PASS stands only when no summary was cut short, since a
// change the rule applies to may sit in a fact that was not listed; a file
// not checked turns it into a question at the merge. Either way the verdict
// becomes a question that says what was missing.
export function gateCrossFile(
  rules: Rule[],
  crossFile: CrossFileVerdict[],
  files: FileCheck[],
  notChecked: Skipped[],
  factsCut: boolean,
  strict = false
): CrossFileVerdict[] {
  const capped = files
    .filter(
      (f) => f.state === "checked" && f.facts.length >= limits.factsPerFile
    )
    .map((f) => f.path);
  return crossFile.map((c) => {
    if (c.verdict !== "FAIL" && c.verdict !== "PASS") return c;
    const rule = rules.find((r) => r.id === c.rule);
    const gaps =
      c.verdict === "FAIL" && rule
        ? ruleGaps(rule, files, notChecked, strict)
        : [];
    const reasons = [
      gaps.length ? `not checked: ${listed(gaps)}` : null,
      capped.length
        ? `more facts than could be listed for ${listed(capped)}`
        : null,
      factsCut ? "the fact list was cut at its cap" : null
    ].filter((s): s is string => s !== null);
    if (!reasons.length) return c;
    const reason = c.reason.replace(/\.$/, "");
    const stands = c.verdict === "FAIL" ? "fail" : "pass";
    return {
      ...c,
      verdict: "UNSURE",
      note: [
        c.note,
        `a ${stands} across files stands only on complete facts; ${reasons.join("; ")}`
      ]
        .filter(Boolean)
        .join("; "),
      question:
        c.question ||
        (c.verdict === "FAIL"
          ? `On the facts seen rule ${c.rule} fails (${reason}). Is what it requires in a file or a fact the check did not see?`
          : `On the facts seen rule ${c.rule} passes (${reason}). Does this pull request make a change the rule applies to that the facts did not list?`)
    };
  });
}

type Hit = { path: string; v: FileVerdict };
type Where = { path: string; line: number | null };

// Where a rule fails, naming an added line first when there is one.
function failDetail(fails: Where[], introduced: Where[]): string {
  const first = introduced[0] ?? fails[0];
  const where = at(first.path, first.line);
  const detail =
    fails.length === 1
      ? `fails in ${where}`
      : `fails in ${fails.length} files, first ${where}`;
  if (introduced.length) return detail;
  return (
    detail +
    (fails.length === 1
      ? " on a line this pull request does not change"
      : ", all on lines this pull request does not change")
  );
}

// What the files left unsettled on a rule, if anything: a FAIL whose quote
// was not found, a question, or a PASS claimed without a line.
function openDetail(hits: Hit[]): string | null {
  const unverified = hits.find((h) => h.v.verdict === "FAIL" && !h.v.verified);
  if (unverified) {
    return `possible fail in ${unverified.path}, quote not verified`;
  }
  const unsure = hits.filter((h) => h.v.verdict === "UNSURE");
  if (unsure.length) {
    return `needs an answer for ${listed(unsure.map((h) => h.path))}`;
  }
  const claimed = hits.filter((h) => h.v.verdict === "PASS" && !h.v.verified);
  if (claimed.length) {
    return `pass claimed without a verified quote in ${listed(claimed.map((h) => h.path))}`;
  }
  return null;
}

// Per rule, across files. A rule one file can decide: a verified FAIL on an
// added line wins, then anything unsettled, then a verified FAIL on lines
// the pull request does not change, then PASS when nothing in scope was
// left unchecked. The unsettled outranks the unchanged failure because that
// failure does not block and the open point may. A rule that spans files
// takes the cross-file verdict; a file's own verdict on it was one of that
// step's inputs and never decides alone.
export function ruleStatuses(
  rules: Rule[],
  files: FileCheck[],
  notChecked: Skipped[],
  crossFile: CrossFileVerdict[] = [],
  strict = false
): RuleStatus[] {
  const checked = files.filter((f) => f.state === "checked");
  return rules.map((rule) => {
    const gaps = ruleGaps(rule, files, notChecked, strict);
    const complete = gaps.length === 0;
    const status = (
      s: Verdict,
      blocking: boolean,
      detail: string
    ): RuleStatus => ({
      rule: rule.id,
      status: s,
      blocking,
      complete,
      attested: false,
      waived: false,
      detail
    });
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
    const where = (h: Hit): Where => ({ path: h.path, line: h.v.line });
    const fails = hits
      .filter((h) => h.v.verdict === "FAIL" && h.v.verified)
      .map(where);
    const introduced = hits
      .filter(
        (h) =>
          h.v.verdict === "FAIL" &&
          h.v.verified &&
          h.v.origin !== "pre-existing"
      )
      .map(where);
    if (introduced.length || (strict && fails.length)) {
      return status("FAIL", true, failDetail(fails, introduced));
    }
    const open = openDetail(hits);
    if (open) {
      return status(
        "UNSURE",
        false,
        fails.length ? `${open}; also ${failDetail(fails, [])}` : open
      );
    }
    if (fails.length) return status("FAIL", false, failDetail(fails, []));
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
// its scope the check did not cover; pass only when neither holds. A waived
// rule is excused: it was already kept from blocking, and here it is kept
// from leaving the check unsure.
export function overallStatus(statuses: RuleStatus[]): CheckStatus {
  if (statuses.some((s) => s.blocking)) return "fail";
  if (
    statuses.some((s) => !s.waived && (s.status === "UNSURE" || !s.complete))
  ) {
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
    note: v.note,
    attestation: null,
    waiver: null,
    evidence: null
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
        note: null,
        attestation: null,
        waiver: null,
        evidence: null
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
          .join("; ") || null,
      attestation: null,
      waiver: null,
      // The file the settle step asked for; the next check reads it.
      evidence: blocks ? null : c.evidencePath
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
      note: null,
      attestation: null,
      waiver: null,
      evidence: null
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
      note: null,
      attestation: null,
      waiver: null,
      evidence: null
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

function preview(text: string): string {
  const max = limits.answerPreviewChars;
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// An answered question is the author's word that the rule is met where the
// check could not see. It settles that question: a rule that is UNSURE only
// because of answered questions passes by attestation, and says so. An
// answer never touches a FAIL, never fills a coverage gap, and counts for
// nothing under strict. Rule ids are positions in the rules file, so an
// answer given against another rule set is stale and does not count; nor
// does one given to a question that has since changed under the same key,
// since a key names where a question sits, not what it asks.
export function applyAttestations(
  statuses: RuleStatus[],
  findings: Finding[],
  attestations: Attestation[],
  rulesHash: string,
  strict: boolean
): { statuses: RuleStatus[]; findings: Finding[] } {
  const byKey = new Map(attestations.map((a) => [a.key, a]));
  const answered = findings.map((f): Finding => {
    const a = f.kind === "question" ? byKey.get(f.key) : undefined;
    if (!a) return { ...f, attestation: null };
    const note = strict
      ? "not counted: the check is strict"
      : a.rulesHash !== rulesHash
        ? "not counted: the rules changed since the answer"
        : normalise(a.question) !== normalise(f.question ?? f.summary)
          ? "not counted: the question changed since the answer"
          : null;
    return {
      ...f,
      attestation: {
        answer: a.answer,
        headSha: a.headSha,
        at: a.createdAt,
        counted: note === null,
        note
      }
    };
  });
  const out = statuses.map((s): RuleStatus => {
    if (s.status !== "UNSURE" || !s.complete) return s;
    const questions = answered.filter(
      (f) => f.kind === "question" && f.rule === s.rule
    );
    if (!questions.length || !questions.every((q) => q.attestation?.counted)) {
      return s;
    }
    // A failure on lines the pull request does not change is still there
    // once the questions are answered; the rule returns to that, not to PASS.
    const unchanged = findings.filter(
      (f) =>
        f.kind === "blocking" &&
        f.rule === s.rule &&
        f.origin === "pre-existing"
    );
    if (unchanged.length) {
      const fails = unchanged.map((f) => ({ path: f.path, line: f.line }));
      const settled =
        questions.length === 1
          ? "its question is answered"
          : `${questions.length} questions are answered`;
      return {
        ...s,
        status: "FAIL",
        blocking: false,
        detail: `${failDetail(fails, [])}; ${settled} by attestation`
      };
    }
    const answers = questions.map((q) => q.attestation?.answer ?? "");
    const detail =
      answers.length === 1
        ? `passes by attestation: "${preview(answers[0])}"`
        : `passes by attestation on ${answers.length} answers`;
    return { ...s, status: "PASS", attested: true, detail };
  });
  return { statuses: out, findings: answered };
}

// The active waiver on each rule: one per rule at most, since waiving a rule
// again replaces the earlier waiver.
export function activeWaivers(waivers: Waiver[]): Map<number, Waiver> {
  const byRule = new Map<number, Waiver>();
  for (const w of waivers) {
    if (w.revokedAt !== null) continue;
    const current = byRule.get(w.rule);
    if (!current || w.createdAt > current.createdAt) byRule.set(w.rule, w);
  }
  return byRule;
}

// A waiver excuses a rule for one pull request. The evidence stays in the
// report as found; the rule stops blocking and stops leaving the check
// unsure, and says why. Nothing is excused under strict. Rule ids are
// positions in the rules file, so a waiver given against another rule set
// names a different rule and does not count. A waiver given at an earlier
// commit still counts, and is marked, since the reason may no longer hold.
// A rule that passes needs no excuse and is left as it is.
export function applyWaivers(
  statuses: RuleStatus[],
  findings: Finding[],
  waivers: Waiver[],
  rulesHash: string,
  headSha: string,
  strict: boolean
): { statuses: RuleStatus[]; findings: Finding[] } {
  const byRule = activeWaivers(waivers);
  if (byRule.size === 0) {
    return {
      statuses,
      findings: findings.map((f) => ({ ...f, waiver: null }))
    };
  }
  const counts = (w: Waiver): string | null =>
    strict
      ? "not counted: the check is strict"
      : w.rulesHash !== rulesHash
        ? "not counted: the rules changed since the waiver"
        : null;
  const excused = (s: RuleStatus): Waiver | undefined => {
    if ((s.status === "PASS" || s.status === "NA") && s.complete) {
      return undefined;
    }
    return byRule.get(s.rule);
  };
  const excusedRules = new Set(
    statuses.filter((s) => excused(s) !== undefined).map((s) => s.rule)
  );
  const marked = findings.map((f): Finding => {
    const w =
      f.kind !== "warning" && f.rule !== null && excusedRules.has(f.rule)
        ? byRule.get(f.rule)
        : undefined;
    if (!w) return { ...f, waiver: null };
    const note = counts(w);
    return {
      ...f,
      waiver: {
        reason: w.reason,
        headSha: w.headSha,
        at: w.createdAt,
        counted: note === null,
        note:
          note ??
          (w.headSha !== headSha ? "waived on an earlier revision" : null)
      }
    };
  });
  const out = statuses.map((s): RuleStatus => {
    const w = excused(s);
    if (!w || counts(w) !== null) return s;
    const earlier = w.headSha !== headSha ? " on an earlier revision" : "";
    return {
      ...s,
      blocking: false,
      waived: true,
      detail: `${s.detail}; waived${earlier}: "${preview(w.reason)}"`
    };
  });
  return { statuses: out, findings: marked };
}
