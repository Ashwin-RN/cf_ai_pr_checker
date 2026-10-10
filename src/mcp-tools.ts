import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { limits } from "./checker/limits";
import { machineReport, renderReport } from "./checker/report";
import type { CheckResult, Progress, RuleSet } from "./checker/types";
import type {
  AnswerOutcome,
  CheckLookup,
  CheckState,
  PrRef,
  WaiveOutcome
} from "./server";
import type { CheckRow } from "./store";
import { CHECK_ID } from "./workspace";

// What an MCP session carries: the workspace it was opened on.
export type McpProps = { workspace: string };

// What the tools need from a workspace. The server reaches the workspace's
// Durable Object over RPC; a test hands in a fake.
export type Workspace = {
  check(
    id: string,
    prUrl: string,
    options: { rules?: string[]; strict?: boolean }
  ): Promise<CheckLookup>;
  progress(id: string): Promise<Progress | null>;
  state(id: string): Promise<CheckState | null>;
  answer(
    checkId: string,
    question: string,
    answer: string
  ): Promise<AnswerOutcome>;
  rules(): Promise<RuleSet | null>;
  setRules(texts: string[]): Promise<{ set: RuleSet; interpreted: boolean }>;
  checks(limit: number): Promise<CheckRow[]>;
  waive(ref: PrRef, rule: number, reason: string): Promise<WaiveOutcome>;
  revoke(ref: PrRef, rule: number): Promise<WaiveOutcome>;
};

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function text(
  body: string,
  structured?: Record<string, unknown>,
  isError = false
): CallToolResult {
  return {
    content: [{ type: "text", text: body }],
    ...(structured ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {})
  };
}

// The report as the agent reads it, and the same as structured content.
function reportResult(result: CheckResult): CallToolResult {
  return text(renderReport(result, { json: false }), machineReport(result));
}

function rulesResult(
  set: RuleSet | null,
  saved: boolean,
  interpreted = true
): CallToolResult {
  if (!set) {
    return text(
      "No rules are saved in this workspace. A repository with a pr-rules.md is checked against it; set_rules saves rules for the rest.",
      { hash: null, source: null, rules: [] }
    );
  }
  const n = set.rules.length;
  const head = saved
    ? `Saved ${n} rule${n === 1 ? "" : "s"} as set ${set.hash}.${interpreted ? "" : " The model could not interpret them this time: each reads as must-not when it contains a negation and applies everywhere. Save them again to retry."}`
    : `${n} rule${n === 1 ? "" : "s"} from ${set.source} (set ${set.hash}).`;
  const lines = set.rules.map(
    (r) =>
      `${r.id}. ${r.text} (${r.polarity === "must_not" ? "must not" : "must"}; ${r.scope === "cross_file" ? "may span files" : "one file"}; ${r.appliesTo?.join(", ") ?? "everywhere"})`
  );
  return text([head, ...lines].join("\n"), {
    hash: set.hash,
    source: set.source,
    interpreted,
    rules: set.rules.map((r) => ({
      id: r.id,
      text: r.text,
      polarity: r.polarity,
      scope: r.scope,
      applies_to: r.appliesTo
    }))
  });
}

// Sends the check's progress to a client that asked for it, once per poll,
// until the check ends. The notifications also keep a long stream alive.
async function withProgress<T>(
  run: Promise<T>,
  poll: () => Promise<Progress | null>,
  extra: Extra,
  pollMs: number
): Promise<T> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return run;
  let done = false;
  void (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (done) return;
      const p = await poll().catch(() => null);
      if (!p) continue;
      const finished = p.files.filter(
        (f) => f.state === "checked" || f.state === "failed"
      ).length;
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: finished,
            ...(p.files.length ? { total: p.files.length } : {}),
            message: p.message
          }
        })
        .catch(() => {});
    }
  })();
  try {
    return await run;
  } finally {
    done = true;
  }
}

// The tools, over any workspace. Every answer is text for the agent to read
// plus the same as structured content.
export function registerTools(
  server: McpServer,
  ws: Workspace,
  options: { pollMs?: number } = {}
): void {
  const pollMs = options.pollMs ?? limits.checkPollMs;

  server.registerTool(
    "check_pr",
    {
      title: "Check a pull request",
      description:
        "Runs the rules against a public GitHub pull request and returns the report: Status, Blocking, Questions, Warnings, Not checked, Intent. Work through Blocking, then Questions (answer_question when the rule is met in a way the check cannot see), then Warnings; push and run again. Rules come from pr-rules.md in the checked repository when it has one, else from this workspace; rules given here are used for this check and saved for the workspace. A check takes a minute or more and reports progress when asked for it. The check keeps running if the call is cut off: give a check_id of your own and read it back with get_check, or find it with list_checks.",
      inputSchema: {
        pr_url: z.string().describe("https://github.com/owner/repo/pull/123"),
        check_id: z
          .string()
          .regex(CHECK_ID)
          .optional()
          .describe(
            "Your own id for this check, unique within the workspace, so get_check can find it if this call is cut off. One is generated otherwise."
          ),
        rules: z
          .array(z.string())
          .optional()
          .describe(
            "Rules in plain English, one per entry; used for this check and saved for the workspace."
          ),
        strict: z
          .boolean()
          .optional()
          .describe(
            "Pre-existing failures block and answered questions do not count. Default false."
          )
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ pr_url, check_id, rules, strict }, extra) => {
      const id = check_id ?? crypto.randomUUID();
      const out = await withProgress(
        ws.check(id, pr_url, { rules, strict }),
        () => ws.progress(id),
        extra,
        pollMs
      );
      if (!out.ok) {
        return text(
          `${out.message} (check ${id})`,
          { check_id: id, status: "error", kind: out.kind, error: out.message },
          true
        );
      }
      return reportResult(out.result);
    }
  );

  server.registerTool(
    "get_check",
    {
      title: "Read a check",
      description:
        "A check by id: its report once it has finished, its progress while it runs, or its error.",
      inputSchema: { check_id: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ check_id }) => {
      const state = await ws.state(check_id);
      if (!state) return text(`No check matches ${check_id}.`, undefined, true);
      if (state.status === "done") return reportResult(state.result);
      if (state.status === "error") {
        return text(
          `Check ${check_id} failed: ${state.error}`,
          { check_id, status: "error", error: state.error },
          true
        );
      }
      const p = state.progress;
      return text(
        `Check ${check_id} is still running${p ? `: ${p.message}` : ""}. Ask again in a moment.`,
        { check_id, status: "running", progress: p }
      );
    }
  );

  server.registerTool(
    "answer_question",
    {
      title: "Answer a question",
      description:
        "Records the author's answer to a question (a Q item) on a finished check: the rule is met in a way the check could not see, and the answer says how and where. It is a claim, not evidence. On the next check of the same pull request the question is settled and the rule passes by attestation, unless the check is strict or the rules have changed. Do not answer when the rule is not met; change the code instead. A blocking item (F) cannot be answered.",
      inputSchema: {
        check_id: z.string(),
        question: z
          .string()
          .describe("The item's id in that report, such as Q2, or its key."),
        answer: z.string().describe("How the rule is met, and where to look.")
      }
    },
    async ({ check_id, question, answer }) => {
      const out = await ws.answer(check_id, question, answer);
      if (!out.ok) return text(out.message, undefined, true);
      return text(
        `Recorded the answer to ${out.finding.id} (rule ${out.attestation.rule}, ${out.attestation.path}) on check ${out.checkId}. The next check of ${out.prUrl} takes it: with the answers so far, the same evidence gives ${out.preview.status.toUpperCase()}. Run check_pr again to confirm.`,
        {
          check_id: out.checkId,
          pr_url: out.prUrl,
          finding: out.finding,
          attestation: out.attestation,
          preview: out.preview
        }
      );
    }
  );

  const prRef = {
    check_id: z
      .string()
      .optional()
      .describe("A check of the pull request, by id or a prefix of it."),
    pr_url: z
      .string()
      .optional()
      .describe("The pull request link, when no check id is given.")
  };

  server.registerTool(
    "waive_rule",
    {
      title: "Waive a rule on a pull request",
      description:
        "Excuses one rule for one pull request, with a reason that is kept on record. The rule must be one of the last finished check of that pull request. On the next check the rule's evidence is shown as found, marked waived, and the rule neither blocks nor leaves the check unsure; under strict a waiver counts for nothing. Use it when a rule does not apply to this change and say why; do not use it to silence a real failure. revoke_waiver ends it.",
      inputSchema: {
        ...prRef,
        rule: z.number().int().min(1).describe("The rule's number."),
        reason: z.string().describe("Why the rule does not apply here.")
      }
    },
    async ({ check_id, pr_url, rule, reason }) => {
      const out = await ws.waive(
        { checkId: check_id, prUrl: pr_url },
        rule,
        reason
      );
      if (!out.ok) return text(out.message, undefined, true);
      return text(
        `Waived rule ${rule} on ${out.prUrl}: "${out.waiver.reason}". The next check shows the rule's evidence as found and does not block on it; with the waivers so far, the same evidence gives ${out.preview.status.toUpperCase()}. A waiver counts for nothing under strict.`,
        {
          pr_url: out.prUrl,
          check_id: out.checkId,
          waiver: out.waiver,
          preview: out.preview
        }
      );
    }
  );

  server.registerTool(
    "revoke_waiver",
    {
      title: "Revoke a waiver",
      description:
        "Ends the waiver on a rule for a pull request. The waiver stays on record as revoked; the next check holds the rule to its evidence again.",
      inputSchema: {
        ...prRef,
        rule: z.number().int().min(1).describe("The rule's number.")
      }
    },
    async ({ check_id, pr_url, rule }) => {
      const out = await ws.revoke({ checkId: check_id, prUrl: pr_url }, rule);
      if (!out.ok) return text(out.message, undefined, true);
      return text(
        `Revoked the waiver on rule ${rule} for ${out.prUrl}. With the waivers left, the same evidence gives ${out.preview.status.toUpperCase()}.`,
        {
          pr_url: out.prUrl,
          check_id: out.checkId,
          waiver: out.waiver,
          preview: out.preview
        }
      );
    }
  );

  server.registerTool(
    "get_rules",
    {
      title: "Read the workspace rules",
      description:
        "The rules saved in this workspace, as interpreted: must or must not, one file or many, and the directories each is limited to.",
      annotations: { readOnlyHint: true }
    },
    async () => rulesResult(await ws.rules(), false)
  );

  server.registerTool(
    "set_rules",
    {
      title: "Save the workspace rules",
      description:
        "Saves rules in plain English for this workspace and returns how each was read. A repository with a pr-rules.md is still checked against that file.",
      inputSchema: {
        rules: z.array(z.string()).min(1).describe("One rule per entry.")
      }
    },
    async ({ rules }) => {
      const { set, interpreted } = await ws.setRules(rules);
      return rulesResult(set, true, interpreted);
    }
  );

  server.registerTool(
    "list_checks",
    {
      title: "List checks",
      description: "Past checks in this workspace, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ limit }) => {
      const rows = await ws.checks(limit ?? 20);
      if (!rows.length) return text("No checks yet.", { checks: [] });
      const lines = rows.map(
        (r) =>
          `${new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")}  ${r.status.padEnd(7)}  ${r.id}  ${r.prUrl}`
      );
      return text(lines.join("\n"), {
        checks: rows.map((r) => ({
          check_id: r.id,
          pr_url: r.prUrl,
          status: r.status,
          started_at: r.startedAt,
          finished_at: r.finishedAt
        }))
      });
    }
  );
}
