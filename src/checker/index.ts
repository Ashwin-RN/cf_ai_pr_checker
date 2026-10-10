import { assessedBy, diffRun } from "./diff";
import { GithubError, fetchPr, fetchRawFile, parsePrUrl } from "./github";
import { checkIntent } from "./intent";
import { limits } from "./limits";
import {
  applyAttestations,
  buildFindings,
  gateCrossFile,
  overallStatus,
  ruleStatuses
} from "./merge";
import type { JsonCaller } from "./model";
import {
  confirmPrompt,
  confirmSchema,
  filePrompt,
  fileOutputSchema,
  type FileOutput
} from "./prompts";
import { ruleApplies } from "./rules";
import { MORE_FILES, selectFiles } from "./select";
import { collectFacts, factsCut, settleCrossFile } from "./settle";
import type {
  Attestation,
  CheckResult,
  CrossFileVerdict,
  FileCheck,
  FileVerdict,
  Intent,
  Pr,
  PrFile,
  PreviousRun,
  Progress,
  ProgressFile,
  Rule,
  RuleSet,
  Runner,
  Skipped
} from "./types";
import {
  annotateSteps,
  assertsPresence,
  chunkLines,
  fileLines,
  findQuote,
  type HunkLine,
  parseHunks,
  renderContext,
  renderHunks
} from "./verify";

export type CheckInput = {
  id: string;
  workspace: string;
  prUrl: string;
  // Rules given with the request. When null, `deps.resolveRules` decides.
  rules: RuleSet | null;
  strict?: boolean;
  runner?: Runner;
  previous?: PreviousRun | null;
  // Questions answered on earlier checks of the same pull request.
  attestations?: Attestation[] | null;
};

export type CheckDeps = {
  fetch: typeof fetch;
  callJson: JsonCaller;
  githubToken?: string;
  now?: () => number;
  onProgress?: (progress: Progress) => void;
  onFile?: (file: FileCheck) => void;
  resolveRules?: (pr: Pr) => Promise<RuleSet | null>;
};

export class CheckError extends Error {
  constructor(
    public kind: "bad_url" | "no_rules" | GithubError["kind"],
    message: string
  ) {
    super(message);
  }
}

// A verified FAIL gets one more look with only the quoted line and its
// neighbours in view. If that look disagrees, the FAIL becomes a question.
async function secondLook(
  rules: Rule[],
  file: PrFile,
  lines: HunkLine[],
  verdicts: FileVerdict[],
  callJson: JsonCaller
): Promise<void> {
  for (const v of verdicts) {
    if (v.verdict !== "FAIL" || !v.verified || v.line === null) continue;
    const rule = rules.find((r) => r.id === v.rule);
    if (!rule || !assertsPresence("FAIL", rule.polarity)) continue;
    const second = await callJson(
      confirmPrompt(rule, file.path, renderContext(lines, v.line)),
      confirmSchema
    );
    if (!second.ok || second.value.breaks_rule) continue;
    v.verdict = "UNSURE";
    v.origin = null;
    v.note = `a second look at the line disagreed: ${second.value.reason.trim()}`;
    v.question = `Does this line break rule ${rule.id}? A first pass said yes, a second pass said no.`;
  }
}

// Strongest first, so one verdict per rule survives when a file is checked in parts.
function rank(v: FileVerdict): number {
  if (v.verdict === "FAIL") {
    return v.verified ? (v.origin === "pre-existing" ? 5 : 6) : 4;
  }
  if (v.verdict === "UNSURE") return 3;
  if (v.verdict === "PASS") return v.verified ? 2 : 1;
  return 0;
}

function verdictFrom(
  rule: Rule,
  v: FileOutput["verdicts"][number],
  lines: HunkLine[],
  allPaths: Set<string>,
  path: string
): FileVerdict {
  const quoted = v.quote.trim() ? findQuote(v.quote, lines) : null;
  const needsQuote = assertsPresence(v.verdict, rule.polarity);
  const present = quoted !== null && quoted.kind !== "del";
  const settled = v.verdict === "FAIL" || v.verdict === "UNSURE";
  let note: string | null = null;
  if (needsQuote && !present) {
    note = !v.quote.trim()
      ? "no line was quoted"
      : quoted
        ? "the quoted line is removed by this PR"
        : "the quote was not found in the file";
  }
  return {
    rule: rule.id,
    verdict: v.verdict,
    quote: quoted ? quoted.text.trim() : v.quote.trim() || null,
    line: present ? quoted.line : null,
    verified: !needsQuote || present,
    origin:
      v.verdict === "FAIL"
        ? present && quoted.kind === "ctx"
          ? "pre-existing"
          : "introduced"
        : null,
    note,
    reason: v.reason.trim(),
    why: settled ? v.why.trim() : "",
    steps: settled
      ? annotateSteps(
          v.steps.filter((s) => s.trim()),
          allPaths,
          path,
          lines
        )
      : [],
    resolution: settled && v.resolution.trim() ? v.resolution.trim() : null,
    question:
      v.verdict === "UNSURE" && v.question.trim() ? v.question.trim() : null
  };
}

// The model answered without a verdict for this rule. Silence is not a pass,
// and a file checked in parts needs a verdict from every part.
function noVerdict(rule: Rule, path: string, part: string | null): FileVerdict {
  const where = part ? ` in ${part}` : "";
  return {
    rule: rule.id,
    verdict: "UNSURE",
    quote: null,
    line: null,
    verified: true,
    origin: null,
    reason: `the model returned no verdict for this rule${where}`,
    why: "",
    steps: [],
    resolution: null,
    question: `Does ${path} meet rule ${rule.id}? The check returned no verdict for it${where}.`,
    note: null
  };
}

// A finding of the last check on this path, by key, with the line it quoted.
export type Earlier = { key: string; quote: string | null };

function present(quote: string, lines: HunkLine[]): boolean {
  const hit = findQuote(quote, lines);
  return hit !== null && hit.kind !== "del";
}

// Runs the model on one file, in parts when it is big, and turns the answers
// into verified verdicts. Without content the diff alone is checked.
export async function checkFile(
  rules: Rule[],
  file: PrFile,
  allPaths: Set<string>,
  callJson: JsonCaller,
  content: string | null,
  contentNote: string | null = null,
  earlier: Earlier[] = []
): Promise<FileCheck> {
  const active = rules.filter((r) => ruleApplies(r, file.path));
  const outOfScope: FileVerdict[] = rules
    .filter((r) => !active.includes(r))
    .map((r) => ({
      rule: r.id,
      verdict: "NA",
      quote: null,
      line: null,
      verified: true,
      origin: null,
      reason: "outside the rule's path scope",
      why: "",
      steps: [],
      resolution: null,
      question: null,
      note: null
    }));
  const base = {
    path: file.path,
    chunks: 0,
    purpose: "",
    facts: [] as string[],
    warnings: [] as FileCheck["warnings"],
    seen: {} as Record<string, boolean>,
    raw: null as string | null
  };
  if (active.length === 0) {
    return {
      ...base,
      state: "checked",
      coverage: "full",
      reason: "no rule applies to this path",
      verdicts: outOfScope
    };
  }
  const lines =
    content === null
      ? parseHunks(file.patch ?? "")
      : fileLines(content, file.patch ?? "");
  const { chunks, cut, windowed } = chunkLines(lines);
  const outputs: Array<{ out: FileOutput; lines: HunkLine[]; part: number }> =
    [];
  const raws: string[] = [];
  let lastError: string | null = null;
  for (const [i, chunk] of chunks.entries()) {
    const rendered = renderHunks(chunk);
    const result = await callJson(
      filePrompt(
        active,
        file,
        rendered.text,
        content === null
          ? "diff"
          : windowed
            ? { index: i, total: chunks.length }
            : "whole"
      ),
      fileOutputSchema
    );
    if (result.raw) raws.push(result.raw);
    if (!result.ok) {
      lastError = result.error;
      continue;
    }
    outputs.push({ out: result.value, lines: chunk, part: i });
  }
  const raw = raws.length ? raws.join("\n---\n") : null;
  if (outputs.length === 0) {
    return {
      ...base,
      state: "failed",
      coverage: "partial",
      reason: lastError ?? "no output",
      chunks: chunks.length,
      verdicts: [],
      raw
    };
  }
  const verdicts: FileVerdict[] = [...outOfScope];
  for (const [at, rule] of active.entries()) {
    // The prompt numbers the rules it lists 1 to N (see filePrompt), so a
    // verdict names a rule by its place in that list, not by its id.
    // One candidate per part; a part that stayed silent on the rule is an
    // open question, which outranks a PASS from another part.
    const candidates = outputs.map(({ out, lines: shown, part }) => {
      const v = out.verdicts.find((x) => x.rule === at + 1);
      return v
        ? verdictFrom(rule, v, shown, allPaths, file.path)
        : noVerdict(
            rule,
            file.path,
            chunks.length > 1 ? `part ${part + 1} of ${chunks.length}` : null
          );
    });
    verdicts.push(candidates.sort((a, b) => rank(b) - rank(a))[0]);
  }
  await secondLook(active, file, lines, verdicts, callJson);
  const shown = new Set(lines.map((l) => l.line));
  const failed = chunks.length - outputs.length;
  // Which earlier findings this check reached: the quoted line was in a part
  // the model answered on, or it is no longer in the file at all. A line
  // still in the file but in no answered part was not looked at again.
  const answered = outputs.flatMap((o) => o.lines);
  const seen: Record<string, boolean> = {};
  for (const e of earlier) {
    if (!e.quote) continue;
    seen[e.key] =
      present(e.quote, answered) ||
      (content !== null && !present(e.quote, lines));
  }
  const reasons = [
    contentNote,
    cut ? "cut at the size cap" : null,
    failed ? `${failed} of ${chunks.length} parts failed: ${lastError}` : null
  ].filter(Boolean);
  return {
    ...base,
    state: "checked",
    coverage:
      content === null || cut || failed
        ? "partial"
        : windowed
          ? "changes"
          : "full",
    reason: reasons.length ? reasons.join("; ") : null,
    chunks: chunks.length,
    purpose: outputs.map((o) => o.out.purpose.trim()).find(Boolean) ?? "",
    verdicts: verdicts.sort((a, b) => a.rule - b.rule),
    facts: [
      ...new Set(outputs.flatMap((o) => o.out.facts.map((f) => f.trim())))
    ]
      .filter(Boolean)
      .slice(0, limits.factsPerFile),
    warnings: outputs
      .flatMap((o) => o.out.warnings)
      .slice(0, limits.warningsPerFile)
      .map((w) => ({
        line: shown.has(w.line) ? w.line : null,
        note: w.note.trim(),
        why: w.why.trim(),
        steps: annotateSteps(
          w.steps.filter((s) => s.trim()),
          allPaths,
          file.path,
          lines
        )
      })),
    seen,
    raw
  };
}

// Runs `fn` over the items, at most `limit` at a time, keeping the order.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

export async function loadPr(prUrl: string, deps: CheckDeps): Promise<Pr> {
  const ref = parsePrUrl(prUrl);
  if (!ref) {
    throw new CheckError(
      "bad_url",
      "That is not a GitHub pull request link. Expected https://github.com/owner/repo/pull/123."
    );
  }
  try {
    return await fetchPr(ref, { fetch: deps.fetch, token: deps.githubToken });
  } catch (e) {
    if (e instanceof GithubError) throw new CheckError(e.kind, e.message);
    throw e;
  }
}

// The file as it is at the head commit. When that cannot be loaded the diff
// is checked on its own and the file counts as partially covered.
async function loadContent(
  pr: Pr,
  file: PrFile,
  deps: CheckDeps
): Promise<{ text: string | null; note: string | null }> {
  let reason: string;
  try {
    const raw = await fetchRawFile(pr, pr.headSha, file.path, {
      fetch: deps.fetch,
      token: deps.githubToken
    });
    if (raw.ok) return { text: raw.text, note: null };
    reason = raw.reason;
  } catch (e) {
    reason = (e as Error).message;
  }
  return {
    text: null,
    note: `full content not loaded (${reason}); checked the diff only`
  };
}

// The check is four stages. `runCheck` runs them in one process; the
// Workflow runs each as a step. Both produce the same result.

export type Fetched = { pr: Pr; checked: PrFile[]; notChecked: Skipped[] };

// Stage 1: the pull request, which of its files get checked, and which do not.
export async function fetchStage(
  prUrl: string,
  deps: CheckDeps
): Promise<Fetched> {
  const pr = await loadPr(prUrl, deps);
  const selection = selectFiles(pr.files);
  const notChecked: Skipped[] = [...selection.skipped];
  if (pr.fileListTruncated) {
    notChecked.push({
      path: MORE_FILES,
      reason: `file list cut after ${limits.fileListPagesMax * 100} files`,
      coverage: true
    });
  }
  return { pr, checked: selection.checked, notChecked };
}

// The rules for this check: the ones given with the request, else whatever
// `deps.resolveRules` finds for the pull request.
export async function resolveRuleSet(
  input: CheckInput,
  pr: Pr,
  deps: CheckDeps
): Promise<RuleSet> {
  const ruleSet = input.rules ?? (await deps.resolveRules?.(pr)) ?? null;
  if (!ruleSet || ruleSet.rules.length === 0) {
    throw new CheckError(
      "no_rules",
      "There are no rules to check against yet."
    );
  }
  return ruleSet;
}

// Stage 2, once per file: its content at the head commit, then the check.
// Only the file's own patch is read from the pull request, so the file list
// can travel without diffs. The last run's findings on the path let the
// check say which of them it reached.
export async function fileStage(
  rules: Rule[],
  pr: Pr,
  file: PrFile,
  callJson: JsonCaller,
  deps: CheckDeps,
  previous: PreviousRun | null = null
): Promise<FileCheck> {
  const allPaths = new Set(pr.files.map((f) => f.path));
  const content = await loadContent(pr, file, deps);
  const earlier = (previous?.findings ?? [])
    .filter((f) => f.path === file.path)
    .map((f) => ({ key: f.key, quote: f.quote }));
  return checkFile(
    rules,
    file,
    allPaths,
    callJson,
    content.text,
    content.note,
    earlier
  );
}

// Stage 3: rules that span files, and the description against the facts.
export async function settleStage(
  rules: Rule[],
  pr: Pr,
  results: FileCheck[],
  callJson: JsonCaller
): Promise<{ crossFile: CrossFileVerdict[]; intent: Intent }> {
  const facts = collectFacts(pr, results);
  const [crossFile, intent] = await Promise.all([
    settleCrossFile(rules, pr, results, facts, callJson),
    checkIntent(pr, facts, callJson)
  ]);
  return { crossFile, intent };
}

export type Assembly = {
  input: CheckInput;
  pr: Pr;
  ruleSet: RuleSet;
  results: FileCheck[];
  notChecked: Skipped[];
  crossFile: CrossFileVerdict[];
  intent: Intent;
  modelCalls: number;
  startedAt: number;
  finishedAt: number;
};

// Stage 4: gate the cross-file verdicts, merge per rule, diff against the
// last run, shape the result. Pure.
export function assemble(a: Assembly): CheckResult {
  const { input, pr, ruleSet, results, notChecked, crossFile, intent } = a;
  const strict = input.strict ?? false;
  const gated = gateCrossFile(
    ruleSet.rules,
    crossFile,
    results,
    notChecked,
    factsCut(pr, results),
    strict
  );
  // Answers settle questions after the merge and before the diff, so an
  // answered finding keeps its key and the diff sees it as the same item.
  const { statuses, findings } = applyAttestations(
    ruleStatuses(ruleSet.rules, results, notChecked, gated, strict),
    buildFindings(ruleSet.rules, results, gated, intent),
    input.attestations ?? [],
    ruleSet.hash,
    strict
  );
  const diffed = diffRun(
    input.previous ?? null,
    findings,
    ruleSet.hash,
    assessedBy(ruleSet.rules, results, gated, intent, strict)
  );
  return {
    schemaVersion: 2,
    id: input.id,
    workspace: input.workspace,
    pr: {
      url: pr.url,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      headSha: pr.headSha
    },
    rulesHash: ruleSet.hash,
    rulesSource: ruleSet.source,
    rules: ruleSet.rules,
    strict,
    runner: input.runner ?? "inline",
    status: overallStatus(statuses),
    ruleStatuses: statuses,
    findings: diffed.findings,
    crossFile: gated,
    intent,
    previous: diffed.previous,
    files: results,
    notChecked,
    // Complete when no rule has a file in its scope the check did not cover
    // for it; a skipped file no rule needed is not a gap.
    coverageComplete: statuses.every((s) => s.complete),
    // The rules were interpreted before the stages ran, so their calls
    // arrive on the set.
    modelCalls: a.modelCalls + (ruleSet.calls ?? 0),
    startedAt: a.startedAt,
    finishedAt: a.finishedAt
  };
}

// Counts the model calls made through a caller, retries included, so each
// stage can report its share.
export function countCalls(callJson: JsonCaller): {
  callJson: JsonCaller;
  calls: () => number;
} {
  let n = 0;
  return {
    callJson: async (messages, schema) => {
      const result = await callJson(messages, schema);
      n += result.calls ?? 1;
      return result;
    },
    calls: () => n
  };
}

// A snapshot of where a check stands, safe to hand to a stream.
export function progressFor(
  checkId: string,
  stage: Progress["stage"],
  message: string,
  files: ProgressFile[]
): Progress {
  return { checkId, stage, message, files: files.map((f) => ({ ...f })) };
}

export function doneMessage(files: ProgressFile[]): string {
  const done = files.filter(
    (f) => f.state === "checked" || f.state === "failed"
  ).length;
  return `${done} of ${files.length} files done`;
}

// The engine in one process: fetch, resolve rules, check each file in
// parallel, settle across files, merge, diff.
export async function runCheck(
  input: CheckInput,
  deps: CheckDeps
): Promise<CheckResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const files: ProgressFile[] = [];
  const progress = (stage: Progress["stage"], message: string) =>
    deps.onProgress?.(progressFor(input.id, stage, message, files));

  progress("fetching", "Fetching the pull request");
  const { pr, checked, notChecked } = await fetchStage(input.prUrl, deps);
  const ruleSet = await resolveRuleSet(input, pr, deps);
  for (const f of checked) files.push({ path: f.path, state: "queued" });
  progress("checking", `Checking ${checked.length} files`);

  const counted = countCalls(deps.callJson);
  const results = await mapLimit(
    checked,
    limits.parallelModelCalls,
    async (file, i) => {
      files[i].state = "checking";
      progress("checking", `Checking ${file.path}`);
      const result = await fileStage(
        ruleSet.rules,
        pr,
        file,
        counted.callJson,
        deps,
        input.previous ?? null
      );
      files[i].state = result.state === "checked" ? "checked" : "failed";
      deps.onFile?.(result);
      progress("checking", doneMessage(files));
      return result;
    }
  );

  progress("checking", "Settling rules across files");
  const { crossFile, intent } = await settleStage(
    ruleSet.rules,
    pr,
    results,
    counted.callJson
  );
  const result = assemble({
    input,
    pr,
    ruleSet,
    results,
    notChecked,
    crossFile,
    intent,
    modelCalls: counted.calls(),
    startedAt,
    finishedAt: now()
  });
  progress("done", `Done: ${result.status.toUpperCase()}`);
  return result;
}
