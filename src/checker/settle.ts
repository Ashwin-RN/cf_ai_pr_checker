import { limits } from "./limits";
import type { JsonCaller } from "./model";
import { settlePrompt, settleSchema } from "./prompts";
import type { CrossFileVerdict, Fact, FileCheck, Pr, Rule } from "./types";
import { annotateSteps } from "./verify";

// Facts are the file list plus what each checked file reported, numbered so
// a later call can cite them and code can check the citations.
export function collectFacts(pr: Pr, files: FileCheck[]): Fact[] {
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
  return out;
}

// Whether the fact list was cut at its cap, so the settle step did not see
// everything the files reported.
export function factsCut(pr: Pr, files: FileCheck[]): boolean {
  const wanted =
    pr.files.length +
    files
      .filter((f) => f.state === "checked")
      .reduce((n, f) => n + f.facts.length, 0);
  return wanted > limits.factsPerSettle;
}

// One call over the facts for the rules no single file can settle. A verdict
// stands only on facts that exist.
export async function settleCrossFile(
  rules: Rule[],
  pr: Pr,
  files: FileCheck[],
  facts: Fact[],
  callJson: JsonCaller
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
        note
      }
    ];
  });
}
