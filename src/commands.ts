import { findPrUrl } from "./checker/github";

// What a chat message asks for. A message that starts with a command is that
// command whatever else it holds, so an answer that cites a pull request
// link records the answer rather than starting a check.
export type Command =
  | { kind: "rules"; text: string }
  | { kind: "history" }
  | { kind: "answer"; question: string; checkId: string | null; text: string }
  | { kind: "check"; prUrl: string }
  | { kind: "chat" };

const ANSWER = /^\s*answer\s+(\S+?)(?:\s+on\s+(\S+))?\s*:\s*([\s\S]+)$/i;

export function parseCommand(text: string): Command {
  if (/^\s*rules:/i.test(text)) return { kind: "rules", text };
  if (/^\s*history\s*$/i.test(text)) return { kind: "history" };
  const answer = ANSWER.exec(text);
  if (answer) {
    return {
      kind: "answer",
      question: answer[1],
      checkId: answer[2] ?? null,
      text: answer[3]
    };
  }
  const prUrl = findPrUrl(text);
  return prUrl ? { kind: "check", prUrl } : { kind: "chat" };
}
