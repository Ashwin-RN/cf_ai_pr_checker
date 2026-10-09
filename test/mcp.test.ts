import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerTools, type Workspace } from "../src/mcp-tools";
import type { Finding, Progress } from "../src/checker/types";
import { result, rule } from "./fixtures";

const notInThisTest = async (): Promise<never> => {
  throw new Error("not in this test");
};

// A client wired to a server over an in-memory pair, with the workspace
// faked tool by tool.
async function connect(ws: Partial<Workspace>, pollMs = 5): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(
    server,
    {
      check: notInThisTest,
      progress: notInThisTest,
      state: notInThisTest,
      answer: notInThisTest,
      rules: notInThisTest,
      setRules: notInThisTest,
      checks: notInThisTest,
      ...ws
    },
    { pollMs }
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(b);
  return client;
}

type Called = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  onprogress?: (p: { progress: number; message?: string }) => void
): Promise<Called> =>
  (await client.callTool({ name, arguments: args }, undefined, {
    onprogress
  })) as Called;

const textOf = (r: Called): string => r.content[0]?.text ?? "";

const finished = result({ id: "check-7", status: "unsure" });

describe("the MCP server", () => {
  it("offers the six tools of the loop", async () => {
    const client = await connect({});
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "answer_question",
      "check_pr",
      "get_check",
      "get_rules",
      "list_checks",
      "set_rules"
    ]);
    const check = tools.find((t) => t.name === "check_pr")!;
    expect(check.inputSchema.required).toEqual(["pr_url"]);
    expect(check.description).toContain("answer_question");
  });

  it("check_pr returns the report as text and as structured content", async () => {
    const seen: Array<{ id: string; prUrl: string; strict?: boolean }> = [];
    const client = await connect({
      check: async (id, prUrl, options) => {
        seen.push({ id, prUrl, strict: options.strict });
        return { ok: true, result: { ...finished, id } };
      }
    });
    const out = await call(client, "check_pr", {
      pr_url: "https://github.com/o/r/pull/1",
      strict: true
    });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toContain("# PR check · o/r#1 · UNSURE");
    expect(out.structuredContent).toMatchObject({
      schema_version: 2,
      check_id: seen[0].id,
      status: "unsure"
    });
    expect(seen[0]).toMatchObject({
      prUrl: "https://github.com/o/r/pull/1",
      strict: true
    });
    expect(seen[0].id).toMatch(/^[0-9a-f-]{36}$/);
    // A client that names the check can find it again after a cut stream.
    const named = await call(client, "check_pr", {
      pr_url: "https://github.com/o/r/pull/1",
      check_id: "agent-run-42"
    });
    expect(named.structuredContent).toMatchObject({ check_id: "agent-run-42" });
    expect(seen[1].id).toBe("agent-run-42");
    const bad = await call(client, "check_pr", {
      pr_url: "https://github.com/o/r/pull/1",
      check_id: "no spaces or _"
    });
    expect(bad.isError).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("check_pr reports progress to a client that asks, then the report", async () => {
    const progress: Progress = {
      checkId: "x",
      stage: "checking",
      message: "1 of 2 files done",
      files: [
        { path: "a.ts", state: "checked" },
        { path: "b.ts", state: "checking" }
      ]
    };
    const client = await connect({
      check: async (id) => {
        await new Promise((r) => setTimeout(r, 40));
        return { ok: true, result: { ...finished, id } };
      },
      progress: async () => progress
    });
    const notices: Array<{
      progress: number;
      total?: number;
      message?: string;
    }> = [];
    const out = await call(
      client,
      "check_pr",
      { pr_url: "https://github.com/o/r/pull/1" },
      (p) => notices.push(p)
    );
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]).toMatchObject({
      progress: 1,
      total: 2,
      message: "1 of 2 files done"
    });
    expect(textOf(out)).toContain("# PR check");
  });

  it("check_pr names the check in its error so get_check can find it", async () => {
    const client = await connect({
      check: async () => ({
        ok: false,
        kind: "no_rules",
        message: "There are no rules to check against yet."
      })
    });
    const out = await call(client, "check_pr", {
      pr_url: "https://github.com/o/r/pull/1"
    });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(
      /^There are no rules to check against yet\. \(check [0-9a-f-]{36}\)$/
    );
    expect(out.structuredContent).toMatchObject({
      status: "error",
      kind: "no_rules"
    });
  });

  it("get_check tells running, failed, finished and unknown apart", async () => {
    const client = await connect({
      state: async (id) => {
        if (id === "run")
          return {
            status: "running",
            progress: {
              checkId: "run",
              stage: "checking",
              message: "Checking a.ts",
              files: []
            }
          };
        if (id === "bad") return { status: "error", error: "GitHub said 404" };
        if (id === "done") return { status: "done", result: finished };
        return null;
      }
    });
    const running = await call(client, "get_check", { check_id: "run" });
    expect(textOf(running)).toBe(
      "Check run is still running: Checking a.ts. Ask again in a moment."
    );
    expect(running.structuredContent).toMatchObject({ status: "running" });
    const failed = await call(client, "get_check", { check_id: "bad" });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe("Check bad failed: GitHub said 404");
    const done = await call(client, "get_check", { check_id: "done" });
    expect(textOf(done)).toContain("# PR check · o/r#1 · UNSURE");
    const none = await call(client, "get_check", { check_id: "nope" });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toBe("No check matches nope.");
  });

  it("answer_question records the answer and previews the next status", async () => {
    const finding: Finding = {
      id: "Q1",
      key: "feedface",
      kind: "question",
      rule: 2,
      path: "src/a.ts",
      line: null,
      quote: null,
      origin: null,
      change: null,
      summary: "s",
      why: "",
      steps: [],
      resolution: null,
      question: "Is it tested elsewhere?",
      note: null,
      attestation: {
        answer: "Yes, in test/a.test.ts",
        headSha: "abcdef1234567890",
        at: 1,
        counted: true,
        note: null
      }
    };
    const given: string[] = [];
    const client = await connect({
      answer: async (checkId, question, answer) => {
        given.push(checkId, question, answer);
        if (question === "F1") {
          return {
            ok: false,
            message:
              "F1 is a blocking item, not a question. Only questions can be answered; a blocking item needs a change to the code."
          };
        }
        return {
          ok: true,
          checkId: "check-7",
          prUrl: "https://github.com/o/r/pull/1",
          finding,
          attestation: {
            key: "feedface",
            rule: 2,
            path: "src/a.ts",
            question: "Is it tested elsewhere?",
            answer: "Yes, in test/a.test.ts",
            checkId: "check-7",
            headSha: "abcdef1234567890",
            rulesHash: "hash",
            createdAt: 1
          },
          preview: {
            status: "pass",
            rules: [
              {
                rule: 2,
                status: "PASS",
                blocking: false,
                complete: true,
                attested: true,
                detail: 'passes by attestation: "Yes, in test/a.test.ts"'
              }
            ]
          }
        };
      }
    });
    const out = await call(client, "answer_question", {
      check_id: "check-7",
      question: "Q1",
      answer: "Yes, in test/a.test.ts"
    });
    expect(out.isError).toBeUndefined();
    expect(textOf(out)).toBe(
      "Recorded the answer to Q1 (rule 2, src/a.ts) on check check-7. The next check of https://github.com/o/r/pull/1 takes it: with the answers so far, the same evidence gives PASS. Run check_pr again to confirm."
    );
    expect(out.structuredContent).toMatchObject({
      check_id: "check-7",
      preview: { status: "pass" }
    });
    expect(given).toEqual(["check-7", "Q1", "Yes, in test/a.test.ts"]);
    const refused = await call(client, "answer_question", {
      check_id: "check-7",
      question: "F1",
      answer: "whatever"
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("F1 is a blocking item");
  });

  it("get_rules and set_rules show the interpretation", async () => {
    const set = {
      rules: [
        rule(1, "No console.log"),
        {
          ...rule(2, "Has a test", "must"),
          scope: "cross_file" as const,
          appliesTo: ["src/"]
        }
      ],
      hash: "abc12345",
      source: "the rules set over MCP"
    };
    const saved: string[][] = [];
    const client = await connect({
      rules: async () => null,
      setRules: async (texts) => {
        saved.push(texts);
        return { set, interpreted: true };
      }
    });
    const none = await call(client, "get_rules");
    expect(textOf(none)).toContain("No rules are saved in this workspace.");
    expect(none.structuredContent).toEqual({
      hash: null,
      source: null,
      rules: []
    });
    const out = await call(client, "set_rules", {
      rules: ["No console.log", "Has a test"]
    });
    expect(saved).toEqual([["No console.log", "Has a test"]]);
    expect(textOf(out)).toBe(
      [
        "Saved 2 rules as set abc12345.",
        "1. No console.log (must not; one file; everywhere)",
        "2. Has a test (must; may span files; src/)"
      ].join("\n")
    );
    expect(out.structuredContent).toMatchObject({
      hash: "abc12345",
      interpreted: true
    });
    const rules = (out.structuredContent as { rules: unknown[] }).rules;
    expect(rules).toHaveLength(2);
    expect(rules[1]).toMatchObject({
      id: 2,
      scope: "cross_file",
      applies_to: ["src/"]
    });
  });

  it("list_checks lists newest first with the ids an agent needs", async () => {
    const client = await connect({
      checks: async (limit) =>
        [
          {
            id: "check-7",
            prUrl: "https://github.com/o/r/pull/1",
            status: "unsure",
            startedAt: Date.UTC(2026, 9, 9, 12, 0),
            finishedAt: Date.UTC(2026, 9, 9, 12, 1)
          }
        ].slice(0, limit)
    });
    const out = await call(client, "list_checks", { limit: 5 });
    expect(textOf(out)).toBe(
      "2026-10-09 12:00  unsure   check-7  https://github.com/o/r/pull/1"
    );
    expect(out.structuredContent).toEqual({
      checks: [
        {
          check_id: "check-7",
          pr_url: "https://github.com/o/r/pull/1",
          status: "unsure",
          started_at: Date.UTC(2026, 9, 9, 12, 0),
          finished_at: Date.UTC(2026, 9, 9, 12, 1)
        }
      ]
    });
  });

  it("turns a thrown error into a tool error, not a dead session", async () => {
    const client = await connect({});
    const out = await call(client, "get_rules");
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("not in this test");
  });
});
