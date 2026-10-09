import { z } from "zod";
import { limits } from "./limits";
import type { JsonCaller } from "./model";
import { rulesPrompt } from "./prompts";
import type { Rule } from "./types";

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

function clean(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const line = raw.replace(BULLET, "").trim().slice(0, limits.ruleChars);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length === limits.rulesMax) break;
  }
  return out;
}

// One rule per line. Bullets and numbering are stripped; blank lines are dropped.
export function parseRuleText(text: string): string[] {
  return clean(text.replace(/^\s*rules:\s*/i, "").split(/\r?\n/));
}

// A rules file is Markdown. Only its list items are rules; headings, prose
// and code blocks around them are ignored.
export function parseRulesFile(markdown: string): string[] {
  const items: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && BULLET.test(line)) items.push(line);
  }
  return clean(items);
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

// One model call interprets every rule. Null when the call failed, so the
// caller can decide whether to keep the defaults.
export async function interpretRules(
  texts: string[],
  callJson: JsonCaller
): Promise<Rule[] | null> {
  const defaults = defaultRules(texts);
  if (texts.length === 0) return defaults;
  const result = await callJson(rulesPrompt(texts), normalisedRulesSchema);
  if (!result.ok || result.value.rules.length !== texts.length) return null;
  return defaults.map((rule, i) => {
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

// The interpretation, or the defaults when the call failed.
export async function normaliseRules(
  texts: string[],
  callJson: JsonCaller
): Promise<Rule[]> {
  return (await interpretRules(texts, callJson)) ?? defaultRules(texts);
}

export async function rulesHash(rules: Rule[]): Promise<string> {
  return hashTexts(rules.map((r) => r.text));
}

export async function hashTexts(texts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(texts.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
