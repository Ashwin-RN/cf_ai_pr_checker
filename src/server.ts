import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import { streamChatResponse, toChatMessages } from "./workers-ai";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are the chat front end of a pull request checker that runs on Cloudflare.
The checker is not connected yet. When it is, a user will give rules in plain English, paste a public GitHub pull request link, and get PASS, FAIL or UNSURE for each rule with the deciding line quoted.
Answer questions about that briefly. Never claim to have checked anything.`;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...toChatMessages(this.messages)
    ];
    return streamChatResponse(
      this.env.AI,
      MODEL,
      messages,
      options?.abortSignal
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
