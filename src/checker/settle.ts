import { limits } from "./limits";
import type { JsonCaller } from "./model";
import { settlePrompt, settleSchema } from "./prompts";
import type {
  CrossFileVerdict,
  EvidenceFile,
  Fact,
  FileCheck,
  Pr,
  Rule
} from "./types";
import { annotateSteps } from "./verify";

// What the settle step is told about a requested file: its facts, or that
// it is missing or could not be read.
export function evidenceFacts(e: EvidenceFile): string[] {
  const head = `requested evidence for rule ${e.rule}`;
  if (e.state === "read") {
    return e.facts.length
      ? e.facts.map(
          (fact) =>
            `${head}, ${e.path} (not changed by this pull request): ${fact}`
        )
      : [
          `${head}: ${e.path} exists but reported nothing that bears on the rule`
        ];
  }
  if (e.state === "missing") {
    return [`${head}: ${e.path} does not exist at the head commit`];
  }
  return [
    `${head}: ${e.path} could not be read (${e.reason ?? "unknown reason"})`
  ];
}

// Facts are the file list plus what each checked file reported, numbered so
// a later call can cite them and code can check the citations. Files read as
// requested evidence come last, marked as such.
export function collectFacts(
  pr: Pr,
  files: FileCheck[],
  evidence: EvidenceFile[] = []
): Fact[] {
  const out: Fact[] = [];
  const add = (path: string, text: string) => {
    if (out.length < limits.factsPerSettle) {
      out.push({ index: out.length, path, text });
    }
  };
  for (const f of pr.files) {
    const rename = f.previousPath ? ` (renamed from ${f.previousPath})` : "";
    add(f.path, `${f.status} file ${f.path}${rename}`);
  }
  for (const f of files) {
    if (f.state !== "checked") continue;
    for (const fact of f.facts) add(f.path, `${f.path}: ${fact}`);
  }
  for (const e of evidence) {
    for (const fact of evidenceFacts(e)) add(e.path, fact);
  }
  return out;
}

// Whether the fact list was cut at its cap, so the settle step did not see
// everything the files reported.
export function factsCut(
  pr: Pr,
  files: FileCheck[],
  evidence: EvidenceFile[] = []
): boolean {
  const wanted =
    pr.files.length +
    files
      .filter((f) => f.state === "checked")
      .reduce((n, f) => n + f.facts.length, 0) +
    evidence.reduce((n, e) => n + evidenceFacts(e).length, 0);
  return wanted > limits.factsPerSettle;
}

// The path the settle step named as the file that would settle a rule, as a
// path the next check can read: relative, inside the repository, not a file
// of the pull request (those were checked), and not one already read this
// run (it did not settle the rule). Anything else is no request.
export function evidencePathFrom(
  raw: string | undefined,
  pr: Pr,
  read: EvidenceFile[] = []
): string | null {
  const path = (raw ?? "").trim().replace(/^`|`$/g, "").replace(/^\.\//, "");
  if (
    !path ||
    path.length > limits.evidencePathChars ||
    path.startsWith("/") ||
    /\\|\s|^[a-z]+:/i.test(path) ||
    path.split("/").some((part) => part === "..") ||
    !/[\w.-]$/.test(path)
  ) {
    return null;
  }
  if (pr.files.some((f) => f.path === path)) return null;
  if (read.some((e) => e.path === path)) return null;
  return path;
}

// One call over the facts for the rules no single file can settle. A verdict
// stands only on facts that exist.
export async function settleCrossFile(
  rules: Rule[],
  pr: Pr,
  files: FileCheck[],
  facts: Fact[],
  callJson: JsonCaller,
  evidence: EvidenceFile[] = []
): Promise<CrossFileVerdict[]> {
  const crossFile = rules.filter((r) => r.scope === "cross_file");
  const checked = files.filter((f) => f.state === "checked");
  if (!crossFile.length || !checked.length) return [];
  // What each file said about these rules from its own side: a question it
  // could not settle alone, or a fail it saw without the other files.
  const open = checked.flatMap((f) =>
    f.verdicts
      .filter(
        (v) =>
          (v.verdict === "UNSURE" || v.verdict === "FAIL") &&
          crossFile.some((r) => r.id === v.rule)
      )
      .map((v) => ({
        rule: v.rule,
        path: f.path,
        question:
          v.verdict === "FAIL"
            ? `possible fail: ${v.reason}`
            : (v.question ?? v.reason)
      }))
  );
  const result = await callJson(
    settlePrompt(crossFile, facts, open),
    settleSchema
  );
  if (!result.ok) return [];
  const allPaths = new Set(pr.files.map((f) => f.path));
  return crossFile.flatMap((rule, at) => {
    // The prompt numbers the rules as listed, 1 to N, not by id.
    const v = result.value.verdicts.find((x) => x.rule === at + 1);
    if (!v) return [];
    const cited = [...new Set(v.facts)]
      .map((i) => facts[i])
      .filter((f): f is Fact => f !== undefined);
    let verdict = v.verdict;
    let note: string | null = null;
    if (verdict !== "NA" && cited.length === 0) {
      note = "the verdict cited no fact, so it is not accepted";
      verdict = "UNSURE";
    }
    const settled = verdict === "FAIL" || verdict === "UNSURE";
    return [
      {
        rule: rule.id,
        verdict,
        facts: cited,
        reason: v.reason.trim(),
        why: settled ? v.why.trim() : "",
        steps: settled
          ? annotateSteps(
              v.steps.filter((s) => s.trim()),
              allPaths,
              "",
              []
            )
          : [],
        resolution: settled && v.resolution.trim() ? v.resolution.trim() : null,
        question: verdict === "UNSURE" ? v.question.trim() || null : null,
        note,
        evidencePath:
          verdict === "UNSURE"
            ? evidencePathFrom(v.evidence_path, pr, evidence)
            : null
      }
    ];
  });
}
