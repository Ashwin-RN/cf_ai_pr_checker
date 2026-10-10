// One Durable Object class serves two kinds of workspace that must never
// meet. A chat workspace is the unguessable id the page puts in its URL, and
// the chat transport admits no other shape. An API workspace is the name the
// caller gives behind the bearer token, kept apart by a prefix no chat id
// can carry.

import { stableKey } from "./checker/merge";

export const CHAT_WORKSPACE = /^[a-z0-9]{20,}$/;
export const API_WORKSPACE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The id a caller may give its check over the API or MCP, so the check can
// be found again if the call is cut off.
export const CHECK_ID = /^[0-9a-z][0-9a-z-]{7,63}$/i;

export function isCheckId(id: string): boolean {
  return CHECK_ID.test(id);
}

const API_PREFIX = "api:";

export function isChatWorkspace(name: string): boolean {
  return CHAT_WORKSPACE.test(name);
}

export function isApiWorkspace(name: string): boolean {
  return API_WORKSPACE.test(name);
}

// The instance name an API workspace lives under.
export function apiInstance(workspace: string): string {
  return `${API_PREFIX}${workspace}`;
}

// The name a caller knows a workspace by, chat or API.
export function workspaceOf(instance: string): string {
  return instance.startsWith(API_PREFIX)
    ? instance.slice(API_PREFIX.length)
    : instance;
}

export function newChatWorkspace(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

// A Workflow instance id is unique per Workflow, and a caller may name its
// check, so two workspaces naming the same check must not collide: the
// instance id carries a short hash of the workspace instance in front of
// the check id. The hash keeps the id within the platform's 100 characters
// and its character set, which an instance name with a colon does not.
export function workflowInstance(instance: string, checkId: string): string {
  return `${stableKey([instance])}-${checkId}`;
}

// The check id behind a Workflow instance id. An id without this
// workspace's prefix is one from before the prefix existed, and is the
// check id itself.
export function checkIdOf(instance: string, workflowId: string): string {
  const prefix = `${stableKey([instance])}-`;
  return workflowId.startsWith(prefix)
    ? workflowId.slice(prefix.length)
    : workflowId;
}
