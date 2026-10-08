import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { textDeltaOf, textDeltas, toChatMessages } from "../src/workers-ai";

function streamOf(text: string, cuts: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      let from = 0;
      for (const cut of [...cuts, bytes.length]) {
        controller.enqueue(bytes.slice(from, cut));
        from = cut;
      }
      controller.close();
    }
  });
}

async function collect(stream: ReadableStream<string>): Promise<string[]> {
  const out: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe("textDeltaOf", () => {
  it("reads one field when both carry the same text", () => {
    const event = { choices: [{ delta: { content: "I" } }], response: "I" };
    expect(textDeltaOf(event)).toBe("I");
  });

  it("falls back to response when choices are absent", () => {
    expect(textDeltaOf({ response: "Hi" })).toBe("Hi");
  });

  it("returns nothing for events without text", () => {
    expect(textDeltaOf({ choices: [{ finish_reason: "stop" }] })).toBe("");
    expect(textDeltaOf({})).toBe("");
    expect(textDeltaOf(null)).toBe("");
  });
});

describe("textDeltas", () => {
  it("joins events split across chunks and skips [DONE] and junk", async () => {
    const text =
      'data: {"choices":[{"delta":{"content":"Hel"}}],"response":"Hel"}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}],"response":"lo"}\n\n' +
      "data: not json\n\n" +
      ": comment\n\n" +
      "data: [DONE]\n\n";
    const deltas = await collect(textDeltas(streamOf(text, [37, 80])));
    expect(deltas).toEqual(["Hel", "lo"]);
  });
});

describe("toChatMessages", () => {
  it("keeps text parts and drops empty messages", () => {
    const messages = [
      { id: "1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "text", text: "a" },
          { type: "text", text: "b" }
        ]
      },
      {
        id: "3",
        role: "user",
        parts: [{ type: "file", mediaType: "image/png", url: "x" }]
      }
    ] as UIMessage[];
    expect(toChatMessages(messages)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "a\nb" }
    ]);
  });
});
