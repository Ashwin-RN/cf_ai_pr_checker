import { z } from "zod";
import { limits } from "./limits";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type JsonResult<T> =
  | { ok: true; value: T; raw: string }
  | { ok: false; error: string; raw: string | null };

export type JsonCaller = <T>(
  messages: ChatMessage[],
  schema: z.ZodType<T>
) => Promise<JsonResult<T>>;

export type TextModel = (
  messages: ChatMessage[],
  responseFormat?: Record<string, unknown>
) => Promise<unknown>;

// Workers AI returns { response } where response is the JSON text or, in
// JSON Mode, sometimes the parsed object already.
export function rawTextOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "response" in output) {
    const r = (output as { response: unknown }).response;
    if (typeof r === "string") return r;
    if (r && typeof r === "object") return JSON.stringify(r);
  }
  return "";
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object found");
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
    .join("; ");
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema);
  return rest;
}

const CAPACITY = /429|3040|capacity|rate limit|too many/i;

export function workersAiText(ai: Ai, model: string): TextModel {
  return (messages, responseFormat) =>
    ai.run(
      model as keyof AiModels,
      {
        messages,
        response_format: responseFormat,
        max_tokens: limits.maxOutputTokens,
        temperature: 0
      } as never
    );
}

// Calls the model in JSON Mode, validates with zod, and retries once with the
// validation error fed back. Capacity errors get a short backoff.
export function jsonCaller(run: TextModel, onCall?: () => void): JsonCaller {
  return async <T>(messages: ChatMessage[], schema: z.ZodType<T>) => {
    const format = { type: "json_schema", json_schema: jsonSchemaOf(schema) };
    let conversation = messages;
    let raw: string | null = null;
    for (let attempt = 0; attempt <= limits.modelRetries; attempt++) {
      let output: unknown;
      try {
        output = await runWithBackoff(run, conversation, format, onCall);
      } catch (e) {
        return {
          ok: false,
          error: `model error: ${(e as Error).message}`,
          raw
        };
      }
      raw = rawTextOf(output);
      let error: string;
      try {
        const parsed = schema.safeParse(parseJson(raw));
        if (parsed.success) return { ok: true, value: parsed.data, raw };
        error = issues(parsed.error);
      } catch (e) {
        error = (e as Error).message;
      }
      if (attempt === limits.modelRetries) {
        return { ok: false, error: `invalid output: ${error}`, raw };
      }
      conversation = [
        ...messages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `That output failed validation: ${error}. Return only JSON that matches the schema.`
        }
      ];
    }
    return { ok: false, error: "unreachable", raw };
  };
}

async function runWithBackoff(
  run: TextModel,
  messages: ChatMessage[],
  format: Record<string, unknown>,
  onCall?: () => void
): Promise<unknown> {
  const waits = [1_000, 3_000];
  for (let i = 0; ; i++) {
    try {
      onCall?.();
      return await run(messages, format);
    } catch (e) {
      if (i >= waits.length || !CAPACITY.test(String((e as Error).message))) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}
