import { describe, expect, it } from "vitest";
import { checkIntent } from "../src/checker/intent";
import type { ChatMessage, JsonCaller } from "../src/checker/model";
import type { Fact, Pr } from "../src/checker/types";

const pr: Pr = {
  owner: "o",
  repo: "r",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title: "Add login",
  body: "Adds the login route and bumps the version.",
  headSha: "abc",
  baseRef: "main",
  files: [],
  fileListTruncated: false
};

const facts: Fact[] = [
  { index: 0, path: "src/login.ts", text: "added file src/login.ts" },
  {
    index: 1,
    path: "src/login.ts",
    text: "src/login.ts: adds route POST /login"
  },
  { index: 2, path: "src/retry.ts", text: "src/retry.ts: adds a retry loop" }
];

function caller(out: unknown) {
  const prompts: ChatMessage[][] = [];
  const call: JsonCaller = async (messages) => {
    prompts.push(messages);
    return { ok: true, value: out as never, raw: "" };
  };
  return { call, prompts };
}

describe("checkIntent", () => {
  it("compares the description with the facts and validates citations", async () => {
    const { call, prompts } = caller({
      summary: "Mostly matches.",
      unmentioned: [
        { fact: 2, note: "new behaviour" },
        { fact: 2, note: "again" },
        { fact: 9, note: "made up" }
      ],
      unsupported: [" bumps the version ", "bumps the version", ""]
    });
    const intent = await checkIntent(pr, facts, call);
    expect(prompts[0][1].content).toContain("Title: Add login");
    expect(prompts[0][1].content).toContain(
      "[2] src/retry.ts: adds a retry loop"
    );
    expect(intent).toEqual({
      compared: true,
      summary: "Mostly matches.",
      unmentioned: [
        {
          path: "src/retry.ts",
          text: "src/retry.ts: adds a retry loop",
          note: "new behaviour"
        }
      ],
      unsupported: ["bumps the version"]
    });
  });

  it("skips the call without a description and reports a failed call", async () => {
    const { call, prompts } = caller({
      summary: "",
      unmentioned: [],
      unsupported: []
    });
    const none = await checkIntent({ ...pr, body: "  " }, facts, call);
    expect(prompts).toHaveLength(0);
    expect(none).toMatchObject({ compared: false });
    const failing: JsonCaller = async () => ({
      ok: false,
      error: "boom",
      raw: null
    });
    expect(await checkIntent(pr, facts, failing)).toMatchObject({
      compared: false,
      summary: "Not compared: boom"
    });
  });

  it("fills in a summary when the model leaves it empty", async () => {
    const { call } = caller({ summary: "", unmentioned: [], unsupported: [] });
    expect((await checkIntent(pr, facts, call)).summary).toBe(
      "The description matches the changes."
    );
  });
});
