import { describe, expect, it } from "vitest";
import { checkFile } from "../src/checker";
import type { ChatMessage, JsonCaller } from "../src/checker/model";
import { confirmSchema, type FileOutput } from "../src/checker/prompts";
import type { PrFile } from "../src/checker/types";
import { rule } from "./fixtures";

const file: PrFile = {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  sha: "s",
  additions: 1,
  deletions: 0,
  patch: "@@ -1,2 +1,3 @@\n const a = 1;\n+console.log(a);\n export { a };"
};

const output = (verdicts: FileOutput["verdicts"]): FileOutput => ({
  purpose: "exports a",
  verdicts,
  facts: ["adds a log"],
  warnings: [{ line: 2, note: "logs", why: "noise", steps: ["remove"] }]
});

function caller(out: FileOutput) {
  const prompts: ChatMessage[][] = [];
  const call: JsonCaller = async (messages, schema) => {
    if ((schema as unknown) === confirmSchema) {
      const confirmed = { breaks_rule: true, reason: "confirmed" };
      return { ok: true, value: confirmed as never, raw: "" };
    }
    prompts.push(messages);
    return { ok: true, value: out as never, raw: JSON.stringify(out) };
  };
  return { call, prompts };
}

const v = (
  ruleId: number,
  verdict: FileOutput["verdicts"][number]["verdict"],
  quote = ""
) => ({
  rule: ruleId,
  verdict,
  quote,
  reason: "r",
  why: "w",
  steps: ["s"],
  resolution: "res",
  question: "q"
});

describe("checkFile", () => {
  it("skips the model when no rule applies to the path", async () => {
    const scoped = { ...rule(1), appliesTo: ["test/"] };
    const { call, prompts } = caller(output([]));
    const result = await checkFile([scoped], file, new Set([file.path]), call);
    expect(prompts).toHaveLength(0);
    expect(result.state).toBe("checked");
    expect(result.verdicts).toEqual([
      expect.objectContaining({ rule: 1, verdict: "NA", verified: true })
    ]);
  });

  it("asks only about rules in scope and marks the rest NA", async () => {
    const rules = [
      { ...rule(1, "No console.log"), appliesTo: ["src/"] },
      { ...rule(2, "Workflows pin versions"), appliesTo: [".github/"] }
    ];
    const { call, prompts } = caller(output([v(1, "FAIL", "console.log(a);")]));
    const result = await checkFile(rules, file, new Set([file.path]), call);
    expect(prompts).toHaveLength(1);
    expect(prompts[0][1].content).toContain("1. [must not] No console.log");
    expect(prompts[0][1].content).not.toContain("Workflows pin versions");
    expect(
      result.verdicts.map((x) => [x.rule, x.verdict, x.verified, x.line])
    ).toEqual([
      [1, "FAIL", true, 2],
      [2, "NA", true, null]
    ]);
    expect(result.verdicts[0].steps).toEqual(["s"]);
    expect(result.warnings[0]).toMatchObject({ line: 2, note: "logs" });
  });

  it("marks a FAIL unverified when the quote is not in the diff", async () => {
    const { call } = caller(output([v(1, "FAIL", "console.log(b);")]));
    const result = await checkFile([rule(1)], file, new Set([file.path]), call);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "FAIL",
      verified: false,
      line: null
    });
  });

  it("keeps a PASS on a must rule unverified without a quote, and drops steps for PASS", async () => {
    const must = rule(1, "Exports something", "must");
    const { call } = caller(output([v(1, "PASS")]));
    const result = await checkFile([must], file, new Set([file.path]), call);
    expect(result.verdicts[0]).toMatchObject({
      verified: false,
      steps: [],
      why: "",
      resolution: null
    });
  });

  it("reports a model failure as a failed file", async () => {
    const failing: JsonCaller = async () => ({
      ok: false,
      error: "invalid output: x",
      raw: "junk"
    });
    const result = await checkFile(
      [rule(1)],
      file,
      new Set([file.path]),
      failing
    );
    expect(result).toMatchObject({
      state: "failed",
      reason: "invalid output: x",
      raw: "junk"
    });
  });
});
