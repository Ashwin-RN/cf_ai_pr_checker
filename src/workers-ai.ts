import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage
} from "ai";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Flattens stored chat messages to the shape Workers AI accepts.
export function toChatMessages(messages: UIMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const { role } = message;
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (content) out.push({ role, content });
  }
  return out;
}

// Some models send the same text in both `choices[0].delta.content` and
// `response`. Read one field, never both.
export function textDeltaOf(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as {
    choices?: Array<{ delta?: { content?: unknown } }>;
    response?: unknown;
  };
  const content = e.choices?.[0]?.delta?.content;
  if (typeof content === "string") return content;
  return typeof e.response === "string" ? e.response : "";
}

function deltaFromLine(line: string): string {
  if (!line.startsWith("data:")) return "";
  const payload = line.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return "";
  try {
    return textDeltaOf(JSON.parse(payload));
  } catch {
    return "";
  }
}

// Turns a Workers AI server-sent event stream into text deltas.
export function textDeltas(
  sse: ReadableStream<Uint8Array>
): ReadableStream<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  return sse.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const delta = deltaFromLine(line);
          if (delta) controller.enqueue(delta);
        }
      },
      flush(controller) {
        const delta = deltaFromLine(buffer);
        if (delta) controller.enqueue(delta);
      }
    })
  );
}

// Streams one assistant reply as a UI message stream response.
export async function streamChatResponse(
  ai: Env["AI"],
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<Response> {
  const raw = await ai.run(
    model as keyof AiModels,
    { messages, stream: true },
    { signal }
  );
  if (!(raw instanceof ReadableStream)) {
    throw new Error(`Workers AI did not stream a reply for ${model}`);
  }
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      const reader = textDeltas(raw).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write({ type: "text-delta", id, delta: value });
      }
      writer.write({ type: "text-end", id });
    }
  });
  return createUIMessageStreamResponse({ stream });
}
