import { GithubError, fetchPr, parsePrUrl } from "./github";
import { limits } from "./limits";
import { buildFindings, overallStatus, ruleStatuses } from "./merge";
import type { JsonCaller } from "./model";
import {
  confirmPrompt,
  confirmSchema,
  filePrompt,
  fileOutputSchema
} from "./prompts";
import { ruleApplies } from "./rules";
import { selectFiles } from "./select";
import type {
  CheckResult,
  FileCheck,
  FileVerdict,
  Pr,
  PrFile,
  Progress,
  ProgressFile,
  Rule
} from "./types";
import {
  annotateSteps,
  assertsPresence,
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
  rules: Rule[];
  rulesHash: string;
};

export type CheckDeps = {
  fetch: typeof fetch;
  callJson: JsonCaller;
  githubToken?: string;
  now?: () => number;
  onProgress?: (progress: Progress) => void;
  onFile?: (file: FileCheck) => void;
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
    v.note = `a second look at the line disagreed: ${second.value.reason.trim()}`;
    v.question = `Does this line break rule ${rule.id}? A first pass said yes, a second pass said no.`;
  }
}

// Runs the model on one file and turns its answer into verified verdicts.
export async function checkFile(
  rules: Rule[],
  file: PrFile,
  allPaths: Set<string>,
  callJson: JsonCaller
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
      reason: "outside the rule's path scope",
      why: "",
      steps: [],
      resolution: null,
      question: null,
      note: null
    }));
  if (active.length === 0) {
    return {
      path: file.path,
      state: "checked",
      reason: "no rule applies to this path",
      purpose: "",
      verdicts: outOfScope,
      facts: [],
      warnings: [],
      raw: null
    };
  }
  const lines = parseHunks(file.patch ?? "");
  const hunks = renderHunks(lines);
  const result = await callJson(
    filePrompt(active, file, hunks.text),
    fileOutputSchema
  );
  if (!result.ok) {
    return {
      path: file.path,
      state: "failed",
      reason: result.error,
      purpose: "",
      verdicts: [],
      facts: [],
      warnings: [],
      raw: result.raw
    };
  }
  const out = result.value;
  const verdicts: FileVerdict[] = [...outOfScope];
  for (const rule of active) {
    const v = out.verdicts.find((x) => x.rule === rule.id);
    if (!v) continue;
    const quoted = v.quote.trim() ? findQuote(v.quote, lines) : null;
    const needsQuote = assertsPresence(v.verdict, rule.polarity);
    const present = quoted !== null && quoted.kind !== "del";
    const settled = v.verdict === "FAIL" || v.verdict === "UNSURE";
    let note: string | null = null;
    if (needsQuote && !present) {
      note = quoted
        ? "the quoted line is removed by this PR"
        : "the quote was not found in the diff";
    }
    verdicts.push({
      rule: rule.id,
      verdict: v.verdict,
      quote: quoted ? quoted.text.trim() : v.quote.trim() || null,
      line: quoted?.line ?? null,
      verified: !needsQuote || present,
      note,
      reason: v.reason.trim(),
      why: settled ? v.why.trim() : "",
      steps: settled
        ? annotateSteps(
            v.steps.filter((s) => s.trim()),
            allPaths,
            file.path,
            lines
          )
        : [],
      resolution: settled && v.resolution.trim() ? v.resolution.trim() : null,
      question:
        v.verdict === "UNSURE" && v.question.trim() ? v.question.trim() : null
    });
  }
  await secondLook(active, file, lines, verdicts, callJson);
  const shown = new Set(lines.map((l) => l.line));
  return {
    path: file.path,
    state: "checked",
    reason: hunks.truncated ? "diff cut at the size cap" : null,
    purpose: out.purpose.trim(),
    verdicts: verdicts.sort((a, b) => a.rule - b.rule),
    facts: out.facts
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, limits.factsPerFile),
    warnings: out.warnings.slice(0, limits.warningsPerFile).map((w) => ({
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
    raw: result.raw
  };
}

async function mapLimit<T, R>(
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

// The engine. Fetch, select, check each file in parallel, verify, merge, render.
export async function runCheck(
  input: CheckInput,
  deps: CheckDeps
): Promise<CheckResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  if (input.rules.length === 0) {
    throw new CheckError(
      "no_rules",
      "There are no rules to check against yet."
    );
  }
  const files: ProgressFile[] = [];
  const progress = (stage: Progress["stage"], message: string) =>
    deps.onProgress?.({
      checkId: input.id,
      stage,
      message,
      files: files.map((f) => ({ ...f }))
    });

  progress("fetching", "Fetching the pull request");
  const pr = await loadPr(input.prUrl, deps);
  const selection = selectFiles(pr.files);
  const notChecked = [...selection.skipped];
  if (pr.fileListTruncated) {
    notChecked.push({
      path: "(more files)",
      reason: "file list cut after 300 files"
    });
  }
  for (const f of selection.checked)
    files.push({ path: f.path, state: "queued" });
  progress("checking", `Checking ${selection.checked.length} files`);

  let modelCalls = 0;
  const callJson: JsonCaller = (messages, schema) => {
    modelCalls++;
    return deps.callJson(messages, schema);
  };
  const allPaths = new Set(pr.files.map((f) => f.path));
  const results = await mapLimit(
    selection.checked,
    limits.parallelModelCalls,
    async (file, i) => {
      files[i].state = "checking";
      progress("checking", `Checking ${file.path}`);
      const checked = await checkFile(input.rules, file, allPaths, callJson);
      files[i].state = checked.state === "checked" ? "checked" : "failed";
      deps.onFile?.(checked);
      progress(
        "checking",
        `${files.filter((f) => f.state === "checked" || f.state === "failed").length} of ${files.length} files done`
      );
      return checked;
    }
  );

  const coverageComplete =
    selection.coverageComplete &&
    !pr.fileListTruncated &&
    results.every((r) => r.state === "checked");
  const statuses = ruleStatuses(input.rules, results, coverageComplete);
  const result: CheckResult = {
    schemaVersion: 1,
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
    rulesHash: input.rulesHash,
    rules: input.rules,
    status: overallStatus(statuses),
    ruleStatuses: statuses,
    findings: buildFindings(input.rules, results),
    files: results,
    notChecked,
    coverageComplete,
    modelCalls,
    startedAt,
    finishedAt: now()
  };
  progress("done", `Done: ${result.status.toUpperCase()}`);
  return result;
}
