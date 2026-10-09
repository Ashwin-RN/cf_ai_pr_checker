import { describe, expect, it } from "vitest";
import {
  apiInstance,
  checkIdOf,
  isApiWorkspace,
  isChatWorkspace,
  newChatWorkspace,
  workflowInstance,
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

  it("keeps a client's check id from colliding across workspaces in the Workflow", () => {
    const a = workflowInstance(apiInstance("ci"), "review-1234");
    const b = workflowInstance(apiInstance("dev"), "review-1234");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-review-1234$/);
    expect(checkIdOf(apiInstance("ci"), a)).toBe("review-1234");
    expect(checkIdOf(apiInstance("dev"), b)).toBe("review-1234");
    const longest = workflowInstance(
      apiInstance("a".repeat(64)),
      "b".repeat(64)
    );
    expect(longest.length).toBeLessThanOrEqual(100);
    expect(longest).toMatch(/^[0-9a-z-]+$/);
    // An instance started before the prefix existed carries the check id itself.
    expect(checkIdOf(apiInstance("ci"), "review-1234")).toBe("review-1234");
  });
});
