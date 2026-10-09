import { describe, expect, it } from "vitest";
import {
  apiInstance,
  isApiWorkspace,
  isChatWorkspace,
  newChatWorkspace,
  workspaceOf
} from "../src/workspace";

describe("workspaces", () => {
  it("admits only the page's own id shape on the chat transport", () => {
    expect(isChatWorkspace(newChatWorkspace())).toBe(true);
    expect(isChatWorkspace("ci")).toBe(false);
    expect(isChatWorkspace("api")).toBe(false);
    expect(isChatWorkspace("api:ci")).toBe(false);
    expect(isChatWorkspace("abcdefghij0123456789-")).toBe(false);
    expect(isChatWorkspace("ABCDEFGHIJ0123456789")).toBe(false);
  });

  it("keeps API instances out of reach of any chat id", () => {
    for (const name of ["ci", "api", "eval", "a".repeat(40)]) {
      expect(isApiWorkspace(name)).toBe(true);
      expect(isChatWorkspace(apiInstance(name))).toBe(false);
    }
    expect(isApiWorkspace("Ci")).toBe(false);
    expect(isApiWorkspace("-ci")).toBe(false);
  });

  it("gives a workspace back its own name", () => {
    expect(workspaceOf(apiInstance("ci"))).toBe("ci");
    const chat = newChatWorkspace();
    expect(workspaceOf(chat)).toBe(chat);
  });
});
