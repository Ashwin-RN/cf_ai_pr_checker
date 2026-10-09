import { describe, expect, it } from "vitest";
import { checkFile } from "../src/checker";
import { limits } from "../src/checker/limits";
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

const content = "const a = 1;\nconsole.log(a);\nexport { a };\n";

const output = (verdicts: FileOutput["verdicts"]): FileOutput => ({
  purpose: "exports a",
  verdicts,
  facts: ["adds a log"],
  warnings: [{ line: 2, note: "logs", why: "noise", steps: ["remove"] }]
});

function caller(out: FileOutput | FileOutput[]) {
  const outputs = Array.isArray(out) ? [...out] : [out];
  const prompts: ChatMessage[][] = [];
  const call: JsonCaller = async (messages, schema) => {
    if ((schema as unknown) === confirmSchema) {
      const confirmed = { breaks_rule: true, reason: "confirmed" };
      return { ok: true, value: confirmed as never, raw: "" };
    }
    prompts.push(messages);
    const next = outputs.length > 1 ? outputs.shift()! : outputs[0];
    return { ok: true, value: next as never, raw: JSON.stringify(next) };
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

const paths = new Set([file.path]);

describe("checkFile", () => {
  it("skips the model when no rule applies to the path", async () => {
    const scoped = { ...rule(1), appliesTo: ["test/"] };
    const { call, prompts } = caller(output([]));
    const result = await checkFile([scoped], file, paths, call, content);
    expect(prompts).toHaveLength(0);
    expect(result).toMatchObject({
      state: "checked",
      coverage: "full",
      chunks: 0
    });
    expect(result.verdicts).toEqual([
      expect.objectContaining({ rule: 1, verdict: "NA", verified: true })
    ]);
  });

  it("shows the whole file, asks only about rules in scope and marks the rest NA", async () => {
    const rules = [
      { ...rule(1, "No console.log"), appliesTo: ["src/"] },
      { ...rule(2, "Workflows pin versions"), appliesTo: [".github/"] }
    ];
    const { call, prompts } = caller(output([v(1, "FAIL", "console.log(a);")]));
    const result = await checkFile(rules, file, paths, call, content);
    expect(prompts).toHaveLength(1);
    const user = prompts[0][1].content;
    expect(user).toContain("1. [must not] No console.log");
    expect(user).not.toContain("Workflows pin versions");
    expect(user).toContain("The whole file follows.");
    expect(user).toContain("+     2 | console.log(a);");
    expect(user).toContain("      3 | export { a };");
    expect(
      result.verdicts.map((x) => [
        x.rule,
        x.verdict,
        x.verified,
        x.line,
        x.origin
      ])
    ).toEqual([
      [1, "FAIL", true, 2, "introduced"],
      [2, "NA", true, null, null]
    ]);
    expect(result.verdicts[0].steps).toEqual(["s"]);
    expect(result.warnings[0]).toMatchObject({ line: 2, note: "logs" });
    expect(result).toMatchObject({ coverage: "full", chunks: 1, reason: null });
  });

  it("labels a FAIL on an unchanged line as pre-existing", async () => {
    const old: PrFile = {
      ...file,
      patch: "@@ -1,2 +1,3 @@\n const a = 1;\n console.log(a);\n+export { a };"
    };
    const { call } = caller(output([v(1, "FAIL", "console.log(a);")]));
    const result = await checkFile([rule(1)], old, paths, call, content);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "FAIL",
      verified: true,
      line: 2,
      origin: "pre-existing"
    });
  });

  it("marks a FAIL unverified when the quote is not in the file", async () => {
    const { call } = caller(output([v(1, "FAIL", "console.log(b);")]));
    const result = await checkFile([rule(1)], file, paths, call, content);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "FAIL",
      verified: false,
      line: null,
      note: "the quote was not found in the file"
    });
  });

  it("keeps a PASS on a must rule unverified without a quote, and drops steps for PASS", async () => {
    const must = rule(1, "Exports something", "must");
    const { call } = caller(output([v(1, "PASS")]));
    const result = await checkFile([must], file, paths, call, content);
    expect(result.verdicts[0]).toMatchObject({
      verified: false,
      note: "no line was quoted",
      origin: null,
      steps: [],
      why: "",
      resolution: null
    });
  });

  it("checks the diff alone when the content is missing and says so", async () => {
    const { call, prompts } = caller(output([v(1, "PASS")]));
    const result = await checkFile(
      [rule(1)],
      file,
      paths,
      call,
      null,
      "full content not loaded (binary); checked the diff only"
    );
    expect(prompts[0][1].content).not.toContain("The whole file follows.");
    expect(result).toMatchObject({
      state: "checked",
      coverage: "partial",
      reason: "full content not loaded (binary); checked the diff only"
    });
  });

  it("checks a big file in parts and keeps the strongest verdict per rule", async () => {
    const line = (i: number) => `const v${i} = ${"x".repeat(60)};`;
    const rows = Array.from({ length: 1500 }, (_, i) => line(i));
    rows[100] = "console.log(early);";
    rows[1400] = "console.log(late);";
    const big = rows.join("\n") + "\n";
    const patch = [
      "@@ -101,1 +101,1 @@",
      `-${line(100)}`,
      "+console.log(early);",
      "@@ -1401,1 +1401,1 @@",
      `-${line(1400)}`,
      "+console.log(late);"
    ].join("\n");
    const bigFile: PrFile = { ...file, patch, additions: 2, deletions: 2 };
    const { call, prompts } = caller([
      output([v(1, "PASS")]),
      output([v(1, "FAIL", "console.log(late);")])
    ]);
    const result = await checkFile([rule(1)], bigFile, paths, call, big);
    expect(prompts).toHaveLength(2);
    expect(prompts[0][1].content).toContain("Part 1 of 2");
    expect(prompts[0][1].content).toContain("+   101 | console.log(early);");
    expect(prompts[0][1].content).not.toContain("console.log(late);");
    expect(prompts[0][1].content.length).toBeLessThan(
      limits.charsPerModelCall + 2_000
    );
    expect(result).toMatchObject({ chunks: 2, coverage: "changes" });
    expect(result.verdicts[0]).toMatchObject({
      verdict: "FAIL",
      verified: true,
      line: 1401,
      origin: "introduced"
    });
  });

  it("prompts a single window as a part and counts the file as checked for its changes", async () => {
    const line = (i: number) => `const v${i} = ${"x".repeat(60)};`;
    const rows = Array.from({ length: 1500 }, (_, i) => line(i));
    rows[100] = "console.log(early);";
    const big = rows.join("\n") + "\n";
    const patch = [
      "@@ -101,1 +101,1 @@",
      `-${line(100)}`,
      "+console.log(early);"
    ].join("\n");
    const bigFile: PrFile = { ...file, patch, additions: 1, deletions: 1 };
    const { call, prompts } = caller(output([v(1, "PASS")]));
    const result = await checkFile([rule(1)], bigFile, paths, call, big);
    expect(prompts).toHaveLength(1);
    expect(prompts[0][1].content).toContain("Part 1 of 1 of the file follows");
    expect(prompts[0][1].content).not.toContain("The whole file follows.");
    expect(result).toMatchObject({
      chunks: 1,
      coverage: "changes",
      reason: null
    });
  });

  it("returns UNSURE for a rule the model left out, not nothing", async () => {
    const rules = [rule(1, "No console.log"), rule(2, "No TODO")];
    const { call } = caller(output([v(1, "PASS")]));
    const result = await checkFile(rules, file, paths, call, content);
    expect(result.verdicts.map((x) => [x.rule, x.verdict])).toEqual([
      [1, "PASS"],
      [2, "UNSURE"]
    ]);
    expect(result.verdicts[1]).toMatchObject({
      verified: true,
      reason: "the model returned no verdict for this rule",
      question:
        "Does src/a.ts meet rule 2? The check returned no verdict for it."
    });
  });

  it("reports a model failure as a failed file", async () => {
    const failing: JsonCaller = async () => ({
      ok: false,
      error: "invalid output: x",
      raw: "junk"
    });
    const result = await checkFile([rule(1)], file, paths, failing, content);
    expect(result).toMatchObject({
      state: "failed",
      coverage: "partial",
      reason: "invalid output: x",
      raw: "junk"
    });
  });
});
