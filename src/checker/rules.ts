import { z } from "zod";
import type { JsonCaller } from "./model";
import { rulesPrompt } from "./prompts";
import type { Rule } from "./types";

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

// One rule per line. Bullets and numbering are stripped; blank lines are dropped.
export function parseRuleText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.replace(/^\s*rules:\s*/i, "").split(/\r?\n/)) {
    const line = raw.replace(BULLET, "").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export const normalisedRulesSchema = z.object({
  rules: z.array(
    z.object({
      polarity: z.enum(["must", "must_not"]),
      scope: z.enum(["file", "cross_file"]),
      applies_to: z.array(z.string())
    })
  )
});

export function defaultRules(texts: string[]): Rule[] {
  return texts.map((text, i) => ({
    id: i + 1,
    text,
    polarity: /\b(no|never|not|don't|do not|avoid|without)\b/i.test(text)
      ? "must_not"
      : "must",
    scope: "file",
    appliesTo: null
  }));
}

// The model's path hints become directory prefixes, kept only when the rule
// text names the directory (singular or plural). A prefix is never narrower
// than the hint, so a bad hint cannot hide files from a rule.
export function scopeFrom(hints: string[], text: string): string[] | null {
  const out = new Set<string>();
  for (const hint of hints) {
    const literal = hint.replace(/^\.?\//, "").split(/[*?{[]/)[0];
    const cut = literal.lastIndexOf("/");
    if (cut === -1) continue;
    const prefix = literal.slice(0, cut + 1).replace(/\/+/g, "/");
    const dir = prefix.split("/").filter(Boolean).at(-1) ?? "";
    const stem = dir
      .replace(/^\./, "")
      .replace(/s$/i, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (stem && new RegExp(`(^|[^\\w])${stem}s?(?!\\w)`, "i").test(text)) {
      out.add(prefix);
    }
  }
  return out.size ? [...out] : null;
}

export function ruleApplies(rule: Rule, path: string): boolean {
  return (
    !rule.appliesTo?.length || rule.appliesTo.some((p) => path.startsWith(p))
  );
}

// One model call interprets every rule. If it fails, the defaults stand.
export async function normaliseRules(
  texts: string[],
  callJson: JsonCaller
): Promise<Rule[]> {
  const fallback = defaultRules(texts);
  if (texts.length === 0) return fallback;
  const result = await callJson(rulesPrompt(texts), normalisedRulesSchema);
  if (!result.ok || result.value.rules.length !== texts.length) return fallback;
  return fallback.map((rule, i) => {
    const n = result.value.rules[i];
    return {
      ...rule,
      polarity: n.polarity,
      // A prohibition is always settled by the file that breaks it.
      scope: n.polarity === "must_not" ? "file" : n.scope,
      appliesTo: scopeFrom(n.applies_to, rule.text)
    };
  });
}

export async function rulesHash(rules: Rule[]): Promise<string> {
  const bytes = new TextEncoder().encode(rules.map((r) => r.text).join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
