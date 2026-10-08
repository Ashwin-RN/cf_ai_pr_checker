import type { Finding, PreviousRun, RunDiff } from "./types";

// Keys stay stable across runs, so a finding is new, still open, or resolved
// by comparing keys with the last finished check of the same pull request.
export function diffRun(
  previous: PreviousRun | null,
  findings: Finding[],
  rulesHash: string
): { findings: Finding[]; previous: RunDiff | null } {
  if (!previous) {
    return {
      findings: findings.map((f) => ({ ...f, change: null })),
      previous: null
    };
  }
  const before = new Set(previous.findings.map((f) => f.key));
  const now = new Set(findings.map((f) => f.key));
  const marked = findings.map(
    (f): Finding => ({ ...f, change: before.has(f.key) ? "open" : "new" })
  );
  return {
    findings: marked,
    previous: {
      checkId: previous.checkId,
      headSha: previous.headSha,
      rulesChanged: previous.rulesHash !== rulesHash,
      new: marked.filter((f) => f.change === "new").length,
      open: marked.filter((f) => f.change === "open").length,
      resolved: previous.findings.filter((f) => !now.has(f.key))
    }
  };
}
