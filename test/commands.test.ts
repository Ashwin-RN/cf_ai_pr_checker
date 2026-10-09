import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands";

describe("parseCommand", () => {
  it("records an answer that cites a pull request link instead of starting a check", () => {
    expect(
      parseCommand(
        "answer Q2: Tests were added in https://github.com/o/r/pull/5"
      )
    ).toEqual({
      kind: "answer",
      question: "Q2",
      checkId: null,
      text: "Tests were added in https://github.com/o/r/pull/5"
    });
    expect(
      parseCommand("answer Q2 on 1234abcd: see https://github.com/o/r/pull/5")
    ).toMatchObject({ kind: "answer", question: "Q2", checkId: "1234abcd" });
    expect(
      parseCommand("rules:\n- No links to https://github.com/o/r/pull/5")
    ).toMatchObject({ kind: "rules" });
  });

  it("tells the other commands apart", () => {
    expect(parseCommand(" History ")).toEqual({ kind: "history" });
    expect(parseCommand("check https://github.com/o/r/pull/5 please")).toEqual({
      kind: "check",
      prUrl: "https://github.com/o/r/pull/5"
    });
    expect(parseCommand("what do you do?")).toEqual({ kind: "chat" });
    expect(parseCommand("answer me this")).toEqual({ kind: "chat" });
  });
});
