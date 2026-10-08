import { describe, expect, it } from "vitest";
import { checkFile } from "../src/checker";
import type { ChatMessage, JsonCaller } from "../src/checker/model";
import type { PrFile } from "../src/checker/types";
import { rule } from "./fixtures";

const file: PrFile = {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  sha: "s",
  additions: 1,
  deletions: 1,
  patch:
    "@@ -1,3 +1,3 @@\n const a = 1;\n-console.log(a);\n+log(a);\n export { a };"
};

function sequence(outputs: unknown[]) {
  const prompts: ChatMessage[][] = [];
  const call: JsonCaller = async (messages) => {
    prompts.push(messages);
    const out = outputs.shift();
    return { ok: true, value: out as never, raw: JSON.stringify(out) };
  };
  return { call, prompts };
}

const firstPass = (quote: string) => ({
  purpose: "",
  verdicts: [
    {
      rule: 1,
      verdict: "FAIL",
      quote,
      reason: "r",
      why: "w",
      steps: [],
      resolution: "",
      question: ""
    }
  ],
  facts: [],
  warnings: []
});

describe("checkFile verification", () => {
  it("does not accept a removed line as evidence that something is present", async () => {
    const { call, prompts } = sequence([firstPass("console.log(a);")]);
    const result = await checkFile([rule(1)], file, new Set([file.path]), call);
    expect(prompts).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "FAIL",
      verified: false,
      line: null,
      note: "the quoted line is removed by this PR"
    });
  });

  it("turns a verified FAIL into a question when the second look disagrees", async () => {
    const { call, prompts } = sequence([
      firstPass("log(a);"),
      { breaks_rule: false, reason: "log is not console.log" }
    ]);
    const result = await checkFile([rule(1)], file, new Set([file.path]), call);
    expect(prompts).toHaveLength(2);
    expect(prompts[1][1].content).toContain(">     2 | log(a);");
    expect(prompts[1][1].content).toContain("      1 | const a = 1;");
    expect(result.verdicts[0]).toMatchObject({
      verdict: "UNSURE",
      verified: true,
      line: 2
    });
    expect(result.verdicts[0].note).toContain("second look");
    expect(result.verdicts[0].question).toContain("rule 1");
  });

  it("keeps a verified FAIL that the second look confirms", async () => {
    const { call } = sequence([
      firstPass("log(a);"),
      { breaks_rule: true, reason: "it logs" }
    ]);
    const result = await checkFile([rule(1)], file, new Set([file.path]), call);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "FAIL",
      verified: true,
      note: null
    });
  });

  it("gives no second look to a FAIL that asserts absence", async () => {
    const { call, prompts } = sequence([firstPass("")]);
    const must = rule(1, "Has a log line", "must");
    const result = await checkFile([must], file, new Set([file.path]), call);
    expect(prompts).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "FAIL",
      verified: true
    });
  });
});
