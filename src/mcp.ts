import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentByName } from "agents";
import { McpAgent } from "agents/mcp";
import { type McpProps, type Workspace, registerTools } from "./mcp-tools";
import type { AppEnv, ChatAgent } from "./server";
import { apiInstance } from "./workspace";

export type { McpProps } from "./mcp-tools";

// One Durable Object per MCP session, bound to the workspace named when
// the session was opened. The tools call that workspace's agent over RPC.
export class CheckMcp extends McpAgent<AppEnv, unknown, McpProps> {
  server = new McpServer({ name: "cf-ai-pr-checker", version: "1.0.0" });

  async init() {
    registerTools(this.server, this.workspace());
  }

  private workspace(): Workspace {
    const agent = async (): Promise<DurableObjectStub<ChatAgent>> => {
      const name = this.props?.workspace;
      if (!name)
        throw new Error("This session was opened without a workspace.");
      return getAgentByName(this.env.ChatAgent, apiInstance(name));
    };
    return {
      check: async (id, prUrl, options) =>
        (await agent()).apiCheck(id, prUrl, options),
      progress: async (id) => (await agent()).progressOf(id),
      state: async (id) => (await agent()).stateOf(id),
      answer: async (checkId, question, answer) =>
        (await agent()).answer(checkId, question, answer),
      rules: async () => (await agent()).getRules(),
      setRules: async (texts) =>
        (await agent()).setRules(texts, "the rules set over MCP"),
      checks: async (limit) => (await agent()).listChecks(limit),
      waive: async (ref, rule, reason) =>
        (await agent()).waive(ref, rule, reason),
      revoke: async (ref, rule) => (await agent()).revoke(ref, rule)
    };
  }
}
