import type { FileVerdict, Rule } from "./types";
import type { HunkLine } from "./verify";

// Rules that code checks exactly, with no model call. A rule is recognised
// from its text; the checker then decides the rule for every file it is
// asked about, quoting the line, and the model is never asked about it.
export type MechanicalKind = "pinned-actions";

export type Mechanical = {
  kind: MechanicalKind;
  // Short name of the check, for the report and the rules listing.
  label: string;
  check(rule: Rule, path: string, lines: HunkLine[]): FileVerdict;
};

export const BY_PATTERN = "checked by pattern";

// The rule texts a checker takes on. Each needs the words that make the
// rule unmistakable; a rule that merely resembles one goes to the model.
export function mechanicalKind(text: string): MechanicalKind | null {
  if (/\bpin(s|ned|ning)?\b/i.test(text) && /\baction/i.test(text)) {
    return "pinned-actions";
  }
  return null;
}

export function mechanicalFor(rule: Rule): Mechanical | null {
  const kind = mechanicalKind(rule.text);
  return kind === null ? null : CHECKERS[kind];
}

function verdict(
  rule: Rule,
  verdict: FileVerdict["verdict"],
  reason: string,
  extra: Partial<FileVerdict> = {}
): FileVerdict {
  return {
    rule: rule.id,
    verdict,
    quote: null,
    line: null,
    verified: true,
    origin: null,
    reason,
    why: "",
    steps: [],
    resolution: null,
    question: null,
    note: BY_PATTERN,
    mechanical: true,
    ...extra
  };
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
// A `uses:` step, bare or quoted. A `uses:` inside a `run: |` block scalar
// matches too; that is a known limit of a line check.
const USES = /^\s*-?\s*uses:\s*(['"]?)([^\s'"#]+)\1/;
// A major version tag such as v4, with minor and patch allowed, or a full
// commit SHA, which pins harder than a tag.
const PINNED = /^v?\d+(\.\d+){0,2}$|^[0-9a-f]{40}$/i;

type Use = { line: HunkLine; ref: string; pinned: boolean };

function uses(lines: HunkLine[]): Use[] {
  const out: Use[] = [];
  for (const line of lines) {
    if (line.kind === "del") continue;
    const m = USES.exec(line.text);
    if (!m) continue;
    const ref = m[2];
    // Local actions and Docker images are not pinned by a tag on the action.
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    const at = ref.lastIndexOf("@");
    const version = at === -1 ? "" : ref.slice(at + 1);
    out.push({ line, ref, pinned: PINNED.test(version) });
  }
  return out;
}

// The line to quote: one the pull request adds before one it leaves.
function first(found: Use[]): Use {
  return found.find((u) => u.line.kind === "add") ?? found[0];
}

const pinnedActions: Mechanical = {
  kind: "pinned-actions",
  label: "every `uses:` names a version tag or a commit SHA",
  check(rule, path, lines) {
    if (!WORKFLOW_PATH.test(path)) {
      return verdict(rule, "NA", "not a workflow file");
    }
    const all = uses(lines);
    if (!all.length) {
      return verdict(rule, "NA", "no action is used in this file");
    }
    const loose = all.filter((u) => !u.pinned);
    if (!loose.length) {
      const quoted = first(all);
      return verdict(
        rule,
        "PASS",
        `${all.length === 1 ? "the one action is" : `all ${all.length} actions are`} pinned to a version tag or a commit SHA`,
        { quote: quoted.line.text.trim(), line: quoted.line.line }
      );
    }
    const quoted = first(loose);
    const more = loose.length > 1 ? `, first ${quoted.ref}` : `: ${quoted.ref}`;
    return verdict(
      rule,
      "FAIL",
      `${loose.length === 1 ? "1 action is" : `${loose.length} actions are`} not pinned to a version tag${more}`,
      {
        quote: quoted.line.text.trim(),
        line: quoted.line.line,
        origin: quoted.line.kind === "ctx" ? "pre-existing" : "introduced",
        why: "An action named by a branch runs whatever that branch holds next, so a change to it reaches this workflow unreviewed.",
        steps: [
          `List every \`uses:\` line in ${path}.`,
          "Replace a branch name or a missing version with a major version tag such as `@v4`, or a full commit SHA.",
          "Every `uses:` line names a version tag or a commit SHA."
        ],
        resolution: `every \`uses:\` line in ${path} names a version tag or a commit SHA`
      }
    );
  }
};

const CHECKERS: Record<MechanicalKind, Mechanical> = {
  "pinned-actions": pinnedActions
};
