import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, getAgentByName, routeAgentRequest } from "agents";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage
} from "ai";
import { CheckError, runCheck } from "./checker";
import {
  GithubError,
  canonicalPrUrl,
  fetchRawFile,
  findPrUrl,
  parsePrUrl
} from "./checker/github";
import { jsonCaller, workersAiText } from "./checker/model";
import { machineReport, renderReport } from "./checker/report";
import {
  defaultRules,
  hashTexts,
  interpretRules,
  parseRuleText,
  parseRulesFile
} from "./checker/rules";
import type { CheckResult, Pr, Progress, Rule, RuleSet } from "./checker/types";
import { Store, type Sql } from "./store";
import { streamChatResponse, toChatMessages } from "./workers-ai";

declare global {
  interface Env {
    API_TOKEN?: string;
    GITHUB_TOKEN?: string;
  }
}

export type CheckMessage = UIMessage<unknown, { check: Progress }>;

// The default model. The AI_MODEL variable overrides it.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const RULES_FILE = "pr-rules.md";
const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHAT_HISTORY = 12;
const CHAT_MESSAGE_CHARS = 4_000;

const SYSTEM_PROMPT = `You are the chat side of a pull request checker that runs on Cloudflare.
How it works: the user sends a message starting with "rules:" with one rule per line, then pastes a public GitHub pull request link. If the checked repository has a pr-rules.md file at the root of its base branch, those rules are used instead. The checker fetches every changed file in full, checks each against the rules with one model call per file, verifies every quoted line in code, settles rules that span files from per-file facts, compares the description with the changes, and replies with a report: Blocking, Questions and Warnings, each with steps to resolve it. A second check of the same pull request says which findings are new, still open or resolved. "history" lists past checks.
Answer questions about that briefly. You cannot run a check yourself and must never claim to have checked anything.`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function reply(markdown: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: markdown });
      writer.write({ type: "text-end", id });
    }
  });
  return createUIMessageStreamResponse({ stream });
}

function lastUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return (
    last?.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
      .trim() ?? ""
  );
}

function rulesMarkdown(
  rules: Rule[],
  hash: string,
  interpreted: boolean
): string {
  const rows = rules.map((r) => {
    const reads = r.polarity === "must_not" ? "must not" : "must";
    const scope = r.scope === "cross_file" ? "may span files" : "one file";
    const applies =
      r.appliesTo?.map((g) => `\`${g}\``).join(", ") ?? "everywhere";
    return `| ${r.id} | ${r.text.replace(/\|/g, "\\|")} | ${reads} | ${scope} | ${applies} |`;
  });
  const caveat = interpreted
    ? ""
    : ' The model could not interpret them this time, so each reads as "must not" when it contains a negation and applies everywhere; save them again to retry.';
  return [
    `Saved ${rules.length} rule${rules.length === 1 ? "" : "s"} as set \`${hash}\`. Paste a pull request link to run them. A \`${RULES_FILE}\` file in the checked repository takes precedence.${caveat}`,
    "",
    "| # | Rule | Reads as | Scope | Applies to |",
    "| --- | --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}

function apiBody(result: CheckResult): Record<string, unknown> {
  return {
    ...machineReport(result),
    report_markdown: renderReport(result, { json: false })
  };
}

type CheckOptions = {
  rules?: RuleSet | null;
  strict?: boolean;
  onProgress?: (progress: Progress) => void;
};

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  private store = new Store((<T>(
    s: TemplateStringsArray,
    ...v: Parameters<Sql>[1][]
  ) => this.sql<T>(s, ...v)) as Sql);

  async onStart() {
    this.store.init();
  }

  // Routing is by code. The model only answers free-form questions.
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const text = lastUserText(this.messages);
    const prUrl = findPrUrl(text);
    if (prUrl) return this.checkResponse(prUrl);
    if (/^\s*rules:/i.test(text)) return this.rulesResponse(text);
    if (/^\s*history\s*$/i.test(text)) return reply(this.historyMarkdown());

    const current = this.store.currentRules();
    const context = current
      ? `Current rules:\n${current.rules.map((r) => `${r.id}. ${r.text}`).join("\n")}`
      : "No rules are saved yet.";
    const history = toChatMessages(this.messages.slice(-CHAT_HISTORY)).map(
      (m) => ({
        ...m,
        content:
          m.content.length > CHAT_MESSAGE_CHARS
            ? `${m.content.slice(0, CHAT_MESSAGE_CHARS)}\n[cut]`
            : m.content
      })
    );
    return streamChatResponse(
      this.env.AI,
      this.model(),
      [
        { role: "system", content: `${SYSTEM_PROMPT}\n\n${context}` },
        ...history
      ],
      options?.abortSignal
    );
  }

  // The HTTP API, reached through the Worker's /api/* handler.
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/check") {
      const body = (await request.json().catch(() => null)) as {
        prUrl?: unknown;
        rules?: unknown;
        strict?: unknown;
      } | null;
      if (!body || typeof body.prUrl !== "string") {
        return json({ error: "Body must be JSON with a prUrl string." }, 400);
      }
      let rules: RuleSet | null = null;
      if (body.rules !== undefined) {
        const texts = Array.isArray(body.rules)
          ? body.rules.filter((x): x is string => typeof x === "string")
          : typeof body.rules === "string"
            ? parseRuleText(body.rules)
            : [];
        if (!texts.length) {
          return json(
            { error: "rules must be a string or an array of strings." },
            400
          );
        }
        rules = (await this.saveRules(texts, "the rules sent with the request"))
          .set;
      }
      try {
        const result = await this.check(crypto.randomUUID(), body.prUrl, {
          rules,
          strict: body.strict === true
        });
        return json(apiBody(result));
      } catch (e) {
        if (!(e instanceof CheckError)) throw e;
        const status =
          e.kind === "bad_url" || e.kind === "no_rules" ? 400 : 502;
        return json({ error: e.message, kind: e.kind }, status);
      }
    }
    const match = /^\/api\/checks\/([\w-]+)$/.exec(url.pathname);
    if (request.method === "GET" && match) {
      const result = this.store.getCheck(match[1]);
      return result
        ? json(apiBody(result))
        : json({ error: "No such check." }, 404);
    }
    return json({ error: "Not found." }, 404);
  }

  @callable()
  getRules() {
    return this.store.currentRules();
  }

  @callable()
  listChecks() {
    return this.store.listChecks();
  }

  @callable()
  getCheck(id: string) {
    return this.store.getCheck(id);
  }

  private model(): string {
    return (this.env as { AI_MODEL?: string }).AI_MODEL || MODEL;
  }

  private callJson() {
    return jsonCaller(workersAiText(this.env.AI, this.model()));
  }

  // Interprets rule text once per distinct text: the same text, already
  // interpreted, is read back from the store. A failed interpretation is
  // not kept, so the next save tries again.
  private async normalise(
    texts: string[],
    source: string
  ): Promise<{ set: RuleSet; interpreted: boolean }> {
    const hash = await hashTexts(texts);
    const known = this.store.getRuleSet(hash);
    if (known) return { set: { ...known, source }, interpreted: true };
    const rules = await interpretRules(texts, this.callJson());
    const set = { rules: rules ?? defaultRules(texts), hash, source };
    if (rules) this.store.putRuleSet(set);
    return { set, interpreted: rules !== null };
  }

  private async saveRules(
    texts: string[],
    source: string
  ): Promise<{ set: RuleSet; interpreted: boolean }> {
    const out = await this.normalise(texts, source);
    this.store.saveRules(out.set, out.interpreted);
    return out;
  }

  // Rules from the checked repository come first; the workspace's own are
  // the fallback.
  private async resolveRules(pr: Pr): Promise<RuleSet | null> {
    let file: Awaited<ReturnType<typeof fetchRawFile>>;
    try {
      file = await fetchRawFile(pr, pr.baseRef, RULES_FILE, {
        fetch: (input, init) => fetch(input, init),
        token: this.env.GITHUB_TOKEN
      });
    } catch (e) {
      if (e instanceof GithubError) throw new CheckError(e.kind, e.message);
      throw e;
    }
    if (file.ok) {
      const texts = parseRulesFile(file.text);
      if (texts.length) {
        const { set } = await this.normalise(
          texts,
          `${RULES_FILE} in ${pr.owner}/${pr.repo} (${pr.baseRef})`
        );
        return set;
      }
    }
    const current = this.store.currentRules();
    return current
      ? { ...current, source: "the rules saved in this workspace" }
      : null;
  }

  private async rulesResponse(text: string): Promise<Response> {
    const texts = parseRuleText(text);
    if (!texts.length) {
      return reply("Write one rule per line after `rules:`.");
    }
    const { set, interpreted } = await this.saveRules(
      texts,
      "the rules saved in this chat"
    );
    return reply(rulesMarkdown(set.rules, set.hash, interpreted));
  }

  private historyMarkdown(): string {
    const rows = this.store.listChecks();
    if (!rows.length) return "No checks yet.";
    return [
      "| When | Pull request | Status | Id |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (r) =>
          `| ${new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")} | ${r.prUrl} | ${r.status} | \`${r.id.slice(0, 8)}\` |`
      )
    ].join("\n");
  }

  // Progress goes out as one data part updated in place; the report follows as text.
  private checkResponse(prUrl: string): Response {
    const stream = createUIMessageStream<CheckMessage>({
      execute: async ({ writer }) => {
        const id = crypto.randomUUID();
        const onProgress = (data: Progress) =>
          writer.write({ type: "data-check", id: `check-${id}`, data });
        let markdown: string;
        try {
          const result = await this.check(id, prUrl, { onProgress });
          markdown = renderReport(result, { json: false });
        } catch (e) {
          markdown =
            e instanceof CheckError
              ? e.message
              : `The check failed: ${(e as Error).message}`;
          onProgress({
            checkId: id,
            stage: "error",
            message: markdown,
            files: []
          });
        }
        const textId = `report-${id}`;
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: markdown });
        writer.write({ type: "text-end", id: textId });
      }
    });
    return createUIMessageStreamResponse({ stream });
  }

  // Runs the engine with real bindings. It does not take the chat's abort
  // signal: a check keeps going when the client disconnects.
  private async check(
    id: string,
    prUrl: string,
    options: CheckOptions
  ): Promise<CheckResult> {
    const ref = parsePrUrl(prUrl);
    if (!ref) {
      throw new CheckError(
        "bad_url",
        "That is not a GitHub pull request link. Expected https://github.com/owner/repo/pull/123."
      );
    }
    const canonical = canonicalPrUrl(ref);
    const previous = this.store.previousCheck(canonical);
    this.store.startCheck(id, canonical);
    try {
      const result = await runCheck(
        {
          id,
          workspace: this.name,
          prUrl: canonical,
          rules: options.rules ?? null,
          strict: options.strict,
          previous
        },
        {
          fetch: (input, init) => fetch(input, init),
          callJson: this.callJson(),
          githubToken: this.env.GITHUB_TOKEN,
          onProgress: options.onProgress,
          onFile: (file) => this.store.saveFileResult(id, file),
          resolveRules: (pr) => this.resolveRules(pr)
        }
      );
      this.store.finishCheck(result);
      return result;
    } catch (e) {
      this.store.failCheck(id, (e as Error).message);
      if (e instanceof CheckError && e.kind === "no_rules") {
        throw new CheckError(
          "no_rules",
          `No rules to check against: the repository has no ${RULES_FILE} and this workspace has no saved rules. Send a message that starts with \`rules:\` and has one rule per line.`
        );
      }
      throw e;
    }
  }
}

function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Bearer token, then hand the request to the workspace's Durable Object.
async function handleApi(request: Request, env: Env): Promise<Response> {
  if (!env.API_TOKEN) {
    return json(
      { error: "The API is off until the API_TOKEN secret is set." },
      503
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !sameToken(auth.slice(7), env.API_TOKEN)) {
    return json({ error: "Unauthorized." }, 401);
  }
  const url = new URL(request.url);
  let workspace = url.searchParams.get("workspace") ?? "api";
  let body: string | undefined;
  if (request.method === "POST") {
    body = await request.text();
    try {
      const parsed = JSON.parse(body) as { workspace?: unknown };
      if (typeof parsed?.workspace === "string") workspace = parsed.workspace;
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
  }
  if (!WORKSPACE.test(workspace)) {
    return json(
      { error: "workspace must be lowercase letters, digits and dashes." },
      400
    );
  }
  const agent = await getAgentByName(env.ChatAgent, workspace);
  return agent.fetch(
    new Request(request.url, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body
    })
  );
}

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
