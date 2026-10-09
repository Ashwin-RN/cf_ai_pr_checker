import { ACROSS_FILES, DESCRIPTION, covers } from "./merge";
import type {
  CrossFileVerdict,
  FileCheck,
  Finding,
  Intent,
  PreviousRun,
  Rule,
  RunDiff
} from "./types";

type Previous = PreviousRun["findings"][number];

// Whether this run looked again at where a previous finding came from: the
// line it quoted, shown to the model again or gone from the file; else its
// file, checked fully enough for its rule; the cross-file step, for its
// rule; or the description comparison. Only then can its absence mean it is
// resolved.
export function assessedBy(
  rules: Rule[],
  files: FileCheck[],
  crossFile: CrossFileVerdict[],
  intent: Intent,
  strict = false
): (f: Previous) => boolean {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return (f) => {
    if (f.path === DESCRIPTION) return intent.compared;
    if (f.path === ACROSS_FILES)
      return crossFile.some((c) => c.rule === f.rule);
    const file = byPath.get(f.path);
    if (!file || file.state !== "checked") return false;
    const seen = file.seen[f.key];
    if (seen !== undefined) return seen;
    const rule =
      f.rule === null ? null : (rules.find((r) => r.id === f.rule) ?? null);
    return covers(file, rule, strict);
  };
}

// Keys stay stable across runs, so a finding is new, still open, resolved or
// not assessed by comparing keys with the last finished check of the same
// pull request. A previous finding is resolved only when its key is absent
// and this run assessed where it came from.
export function diffRun(
  previous: PreviousRun | null,
  findings: Finding[],
  rulesHash: string,
  assessed: (f: Previous) => boolean
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
  const gone = previous.findings.filter((f) => !now.has(f.key));
  return {
    findings: marked,
    previous: {
      checkId: previous.checkId,
      headSha: previous.headSha,
      rulesChanged: previous.rulesHash !== rulesHash,
      new: marked.filter((f) => f.change === "new").length,
      open: marked.filter((f) => f.change === "open").length,
      resolved: gone.filter(assessed),
      unassessed: gone.filter((f) => !assessed(f))
    }
  };
}
