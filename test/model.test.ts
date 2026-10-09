import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonCaller, rawTextOf, type ChatMessage } from "../src/checker/model";

const schema = z.object({ a: z.number() });
const messages: ChatMessage[] = [{ role: "user", content: "go" }];

function runner(outputs: unknown[]) {
  const calls: Array<{
    messages: ChatMessage[];
    format?: Record<string, unknown>;
  }> = [];
  const run = async (m: ChatMessage[], format?: Record<string, unknown>) => {
    calls.push({ messages: m, format });
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, calls };
}

describe("rawTextOf", () => {
  it("reads strings, response strings and response objects", () => {
    expect(rawTextOf("x")).toBe("x");
    expect(rawTextOf({ response: "y" })).toBe("y");
    expect(rawTextOf({ response: { a: 1 } })).toBe('{"a":1}');
    expect(rawTextOf({})).toBe("");
  });
});

describe("jsonCaller", () => {
  it("validates a parsed object and sends the schema as JSON Mode", async () => {
    const { run, calls } = runner([{ response: { a: 1 } }]);
    const out = await jsonCaller(run)(messages, schema);
    expect(out).toEqual({
      ok: true,
      value: { a: 1 },
      raw: '{"a":1}',
      calls: 1
    });
    expect(calls[0].format).toMatchObject({ type: "json_schema" });
    const js = calls[0].format!.json_schema as Record<string, unknown>;
    expect(js).not.toHaveProperty("$schema");
    expect(js).toMatchObject({ type: "object", required: ["a"] });
  });

  it("retries once with the validation error fed back", async () => {
    const { run, calls } = runner([
      { response: '{"a":"x"}' },
      { response: '{"a": 2}' }
    ]);
    const out = await jsonCaller(run)(messages, schema);
    expect(out).toMatchObject({ ok: true, value: { a: 2 }, calls: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[1]).toEqual({
      role: "assistant",
      content: '{"a":"x"}'
    });
    expect(calls[1].messages[2].content).toMatch(/failed validation: a: /);
  });

  it("gives up after the retry and keeps the raw output", async () => {
    const { run } = runner([{ response: "nope" }, { response: "still nope" }]);
    const out = await jsonCaller(run)(messages, schema);
    expect(out).toMatchObject({ ok: false, raw: "still nope", calls: 2 });
    expect((out as { error: string }).error).toMatch(/^invalid output/);
  });

  it("extracts JSON wrapped in prose", async () => {
    const { run } = runner([
      { response: 'Here you go:\n```json\n{"a": 3}\n```' }
    ]);
    expect(await jsonCaller(run)(messages, schema)).toMatchObject({
      ok: true,
      value: { a: 3 }
    });
  });

  it("reports model errors without retrying", async () => {
    const { run, calls } = runner([new Error("boom")]);
    const out = await jsonCaller(run)(messages, schema);
    expect(out).toEqual({
      ok: false,
      error: "model error: boom",
      raw: null,
      calls: 1
    });
    expect(calls).toHaveLength(1);
  });

  it("counts calls", async () => {
    let n = 0;
    const { run } = runner([{ response: { a: 1 } }]);
    await jsonCaller(run, () => n++)(messages, schema);
    expect(n).toBe(1);
  });
});
