import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable, getAgentByName, routeAgentRequest } from "agents";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage
} from "ai";
import { CheckError, type CheckInput, countCalls, runCheck } from "./checker";
import {
  GithubError,
  canonicalPrUrl,
  fetchRawFile,
  findPrUrl,
  parsePrUrl
} from "./checker/github";
import { limits } from "./checker/limits";
import { jsonCaller, modelFor, workersAiText } from "./checker/model";
import { machineReport, renderReport } from "./checker/report";
import {
  defaultRules,
  hashTexts,
  interpretRules,
  parseRuleText,
  parseRulesFile
} from "./checker/rules";
import type {
  CheckResult,
  FileCheck,
  Pr,
  Progress,
  Rule,
  RuleSet
} from "./checker/types";
import { Store, type Sql } from "./store";
import type { CheckParams, RulesLookup } from "./workflow";
import { streamChatResponse, toChatMessages } from "./workers-ai";
import {
  apiInstance,
  isApiWorkspace,
  isChatWorkspace,
  workspaceOf
} from "./workspace";

export { CheckWorkflow } from "./workflow";

// The generated `Env` carries the bindings. Secrets and variables are
// optional because a deployment may leave them unset.
export type AppEnv = Env & {
  API_TOKEN?: string;
  GITHUB_TOKEN?: string;
  AI_MODEL?: string;
  // "workflow" (the default) runs a check as a Cloudflare Workflow;
  // "inline" runs it inside the Durable Object.
  CHECK_RUNNER?: string;
};

export type CheckMessage = UIMessage<unknown, { check: Progress }>;

const RULES_FILE = "pr-rules.md";
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

function assistantMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [{ type: "text", text }]
  };
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

// The message a chat check ends with: the report, or what went wrong.
function checkOutcomeText(e: unknown): string {
  return e instanceof CheckError
    ? e.message
    : `The check failed: ${(e as Error).message}`;
}

type CheckOptions = {
  rules?: RuleSet | null;
  strict?: boolean;
  source?: "chat" | "api";
  onProgress?: (progress: Progress) => void;
};

// A check this instance is waiting on: where its progress goes and how its
// end is delivered.
type Waiter = {
  resolve: (result: CheckResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: Progress) => void;
};

export class ChatAgent extends AIChatAgent<AppEnv> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  private store = new Store((<T>(
    s: TemplateStringsArray,
    ...v: Parameters<Sql>[1][]
  ) => this.sql<T>(s, ...v)) as Sql);
  private waiters = new Map<string, Waiter>();
  // Checks whose end reached a waiter, so the Workflow's completion callback
  // does not deliver the report a second time.
  private delivered = new Set<string>();

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
      modelFor(this.env),
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
          strict: body.strict === true,
          source: "api"
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

  // Called by the Workflow over RPC: the rules for a pull request, with a
  // failure kept as data because an error does not keep its kind across RPC.
  async rulesFor(pr: Pr): Promise<RulesLookup> {
    try {
      const set = await this.resolveRules(pr);
      return set && set.rules.length
        ? { ok: true, set }
        : {
            ok: false,
            kind: "no_rules",
            message: "There are no rules to check against yet."
          };
    } catch (e) {
      if (e instanceof CheckError) {
        return { ok: false, kind: e.kind, message: e.message };
      }
      throw e;
    }
  }

  // Called by the Workflow over RPC from inside a file step.
  saveWorkflowFile(checkId: string, file: FileCheck): void {
    this.store.saveFileResult(checkId, file);
  }

  // Called by the Workflow over RPC from its last step.
  finishWorkflowCheck(result: CheckResult): void {
    this.store.finishCheck(result);
    const waiter = this.waiters.get(result.id);
    if (waiter) {
      this.delivered.add(result.id);
      waiter.resolve(result);
    }
  }

  failWorkflowCheck(
    checkId: string,
    kind: CheckError["kind"],
    message: string
  ): void {
    this.store.failCheck(checkId, message);
    const waiter = this.waiters.get(checkId);
    if (waiter) {
      this.delivered.add(checkId);
      waiter.reject(new CheckError(kind, this.describeFailure(kind, message)));
    }
  }

  async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: unknown
  ) {
    this.waiters.get(workflowId)?.onProgress?.(progress as Progress);
  }

  async onWorkflowComplete(_workflowName: string, workflowId: string) {
    await this.deliverIfLost(workflowId);
  }

  // The Workflow died outside its own handling. The check is over either way.
  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    const state = this.store.checkState(workflowId);
    if (state && !state.result) this.store.failCheck(workflowId, error);
    const waiter = this.waiters.get(workflowId);
    if (waiter) {
      this.delivered.add(workflowId);
      waiter.reject(new CheckError("error", `The check failed: ${error}`));
    }
    await this.deliverIfLost(workflowId);
  }

  // A chat check whose stream this instance no longer has, because the
  // instance restarted while the Workflow ran, still gets its report: it is
  // appended to the conversation here.
  private async deliverIfLost(workflowId: string): Promise<void> {
    const info = this.getWorkflow(workflowId);
    const source = (info?.metadata as { source?: string } | undefined)?.source;
    if (source === "chat" && !this.delivered.has(workflowId)) {
      const state = this.store.checkState(workflowId);
      const text = state?.result
        ? renderReport(state.result, { json: false })
        : `The check failed: ${state?.error ?? "unknown error"}`;
      await this.saveMessages((messages) => [
        ...messages,
        assistantMessage(text)
      ]);
    }
    this.delivered.delete(workflowId);
    this.deleteWorkflow(workflowId);
  }

  private callJson() {
    return jsonCaller(workersAiText(this.env.AI, modelFor(this.env)));
  }

  private usesWorkflow(): boolean {
    return (
      this.env.CHECK_RUNNER !== "inline" && Boolean(this.env.CHECK_WORKFLOW)
    );
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
    const counted = countCalls(this.callJson());
    const rules = await interpretRules(texts, counted.callJson);
    const set = {
      rules: rules ?? defaultRules(texts),
      hash,
      source,
      calls: counted.calls()
    };
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

  // The rules file at a commit or branch, as rule texts; null without one.
  private async rulesFileAt(pr: Pr, at: string): Promise<string[] | null> {
    let file: Awaited<ReturnType<typeof fetchRawFile>>;
    try {
      file = await fetchRawFile(pr, at, RULES_FILE, {
        fetch: (input, init) => fetch(input, init),
        token: this.env.GITHUB_TOKEN
      });
    } catch (e) {
      if (e instanceof GithubError) throw new CheckError(e.kind, e.message);
      throw e;
    }
    if (!file.ok) return null;
    const texts = parseRulesFile(file.text);
    return texts.length ? texts : null;
  }

  // Rules from the checked repository come first; the workspace's own are
  // the fallback.
  private async resolveRules(pr: Pr): Promise<RuleSet | null> {
    const fromBase = await this.rulesFileAt(pr, pr.baseRef);
    if (fromBase) {
      const { set } = await this.normalise(
        fromBase,
        `${RULES_FILE} in ${pr.owner}/${pr.repo} (${pr.baseRef})`
      );
      return set;
    }
    // A pull request that adds the rules file is checked against it.
    if (pr.files.some((f) => f.path === RULES_FILE)) {
      const fromHead = await this.rulesFileAt(pr, pr.headSha);
      if (fromHead) {
        const { set } = await this.normalise(
          fromHead,
          `${RULES_FILE} added by this pull request`
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
          const result = await this.check(id, prUrl, {
            onProgress,
            source: "chat"
          });
          markdown = renderReport(result, { json: false });
        } catch (e) {
          markdown = checkOutcomeText(e);
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

  private describeFailure(kind: CheckError["kind"], message: string): string {
    return kind === "no_rules"
      ? `No rules to check against: the repository has no ${RULES_FILE} and this workspace has no saved rules. Send a message that starts with \`rules:\` and has one rule per line.`
      : message;
  }

  // Runs a check with real bindings, as a Workflow or in this instance. It
  // does not take the chat's abort signal: a check keeps going when the
  // client disconnects.
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
    const input: CheckInput = {
      id,
      workspace: workspaceOf(this.name),
      prUrl: canonical,
      rules: options.rules ?? null,
      strict: options.strict ?? false,
      previous: this.store.previousCheck(canonical)
    };
    this.store.startCheck(id, canonical);
    return this.usesWorkflow()
      ? this.checkByWorkflow(input, options)
      : this.checkInline(input, options);
  }

  private async checkInline(
    input: CheckInput,
    options: CheckOptions
  ): Promise<CheckResult> {
    try {
      const result = await runCheck(input, {
        fetch: (i, init) => fetch(i, init),
        callJson: this.callJson(),
        githubToken: this.env.GITHUB_TOKEN,
        onProgress: options.onProgress,
        onFile: (file) => this.store.saveFileResult(input.id, file),
        resolveRules: (pr) => this.resolveRules(pr)
      });
      this.store.finishCheck(result);
      return result;
    } catch (e) {
      this.store.failCheck(input.id, (e as Error).message);
      if (e instanceof CheckError) {
        throw new CheckError(e.kind, this.describeFailure(e.kind, e.message));
      }
      throw e;
    }
  }

  // Starts the Workflow and waits for its end. The finish and fail RPCs
  // resolve the wait; the stored row is read as well, in case this instance
  // missed them. Past the deadline the Workflow is stopped and the check fails.
  private checkByWorkflow(
    input: CheckInput,
    options: CheckOptions
  ): Promise<CheckResult> {
    const id = input.id;
    const params: CheckParams = {
      ...input,
      runner: "workflow",
      startedAt: Date.now()
    };
    return new Promise<CheckResult>((resolve, reject) => {
      const deadline = Date.now() + limits.checkWaitMs;
      const stop = () => {
        clearInterval(timer);
        this.waiters.delete(id);
      };
      const waiter: Waiter = {
        resolve: (result) => {
          stop();
          resolve(result);
        },
        reject: (error) => {
          stop();
          reject(error);
        },
        onProgress: options.onProgress
      };
      const timer = setInterval(() => {
        const state = this.store.checkState(id);
        if (state?.result) {
          waiter.resolve(state.result);
        } else if (state?.status === "error") {
          waiter.reject(
            new CheckError("error", state.error ?? "The check failed.")
          );
        } else if (Date.now() > deadline) {
          const minutes = Math.round(limits.checkWaitMs / 60_000);
          const message = `The check did not finish within ${minutes} minutes.`;
          this.terminateWorkflow(id).catch(() => {});
          this.store.failCheck(id, message);
          waiter.reject(new CheckError("error", message));
        }
      }, limits.checkPollMs);
      this.waiters.set(id, waiter);
      this.runWorkflow("CHECK_WORKFLOW", params, {
        id,
        agentBinding: "ChatAgent",
        metadata: { prUrl: input.prUrl, source: options.source ?? "api" }
      }).catch((e: Error) => {
        this.store.failCheck(id, e.message);
        waiter.reject(e);
      });
    });
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
// API workspaces live in their own name space, apart from the chat's.
async function handleApi(request: Request, env: AppEnv): Promise<Response> {
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
  if (!isApiWorkspace(workspace)) {
    return json(
      { error: "workspace must be lowercase letters, digits and dashes." },
      400
    );
  }
  const agent = await getAgentByName(env.ChatAgent, apiInstance(workspace));
  return agent.fetch(
    new Request(request.url, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body
    })
  );
}

// The chat transport opens chat workspaces only, so an API workspace cannot
// be reached by naming it.
function chatOnly(
  _request: Request,
  lobby: { name: string }
): Response | undefined {
  return isChatWorkspace(lobby.name)
    ? undefined
    : new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: AppEnv) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return (
      (await routeAgentRequest(request, env, {
        onBeforeConnect: chatOnly,
        onBeforeRequest: chatOnly
      })) || new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<AppEnv>;
