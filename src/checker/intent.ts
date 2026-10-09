import { limits } from "./limits";
import type { JsonCaller } from "./model";
import { intentPrompt, intentSchema } from "./prompts";
import type { Fact, Intent, Pr } from "./types";

function notCompared(summary: string): Intent {
  return { compared: false, summary, unmentioned: [], unsupported: [] };
}

// One call that compares what the description says with what the files do.
// Drift is a pointer for the reader, never a verdict.
export async function checkIntent(
  pr: Pr,
  facts: Fact[],
  callJson: JsonCaller
): Promise<Intent> {
  if (!pr.body.trim()) {
    return notCompared("The pull request has no description to compare.");
  }
  if (!facts.length) return notCompared("No file facts to compare.");
  const result = await callJson(intentPrompt(pr, facts), intentSchema);
  if (!result.ok) return notCompared(`Not compared: ${result.error}`);
  const seen = new Set<number>();
  const unmentioned: Intent["unmentioned"] = [];
  for (const u of result.value.unmentioned) {
    const fact = facts[u.fact];
    if (!fact || seen.has(u.fact)) continue;
    seen.add(u.fact);
    unmentioned.push({ path: fact.path, text: fact.text, note: u.note.trim() });
    if (unmentioned.length === limits.intentItems) break;
  }
  const unsupported = [
    ...new Set(result.value.unsupported.map((s) => s.trim()).filter(Boolean))
  ].slice(0, limits.intentItems);
  return {
    compared: true,
    summary:
      result.value.summary.trim() ||
      (unmentioned.length || unsupported.length
        ? "The description and the changes differ."
        : "The description matches the changes."),
    unmentioned,
    unsupported
  };
}
