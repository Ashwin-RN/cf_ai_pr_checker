import type {
  CheckResult,
  FileCheck,
  FileVerdict,
  Rule
} from "../src/checker/types";

export function rule(
  id: number,
  text = `Rule ${id}`,
  polarity: Rule["polarity"] = "must_not"
): Rule {
  return { id, text, polarity, scope: "file", appliesTo: null };
}

export function verdict(
  ruleId: number,
  v: FileVerdict["verdict"],
  extra: Partial<FileVerdict> = {}
): FileVerdict {
  return {
    rule: ruleId,
    verdict: v,
    quote: null,
    line: null,
    verified: true,
    reason: "because",
    why: "",
    steps: [],
    resolution: null,
    question: null,
    note: null,
    ...extra
  };
}

export function file(
  path: string,
  verdicts: FileVerdict[],
  extra: Partial<FileCheck> = {}
): FileCheck {
  return {
    path,
    state: "checked",
    reason: null,
    purpose: "",
    verdicts,
    facts: [],
    warnings: [],
    raw: null,
    ...extra
  };
}

export function result(extra: Partial<CheckResult> = {}): CheckResult {
  const rules = extra.rules ?? [
    rule(1, "No console.log"),
    rule(2, "Has a test", "must")
  ];
  return {
    schemaVersion: 1,
    id: "check-1",
    workspace: "ws",
    pr: {
      url: "https://github.com/o/r/pull/1",
      owner: "o",
      repo: "r",
      number: 1,
      title: "T",
      headSha: "abcdef1234567890"
    },
    rulesHash: "hash",
    rules,
    status: "pass",
    ruleStatuses: rules.map((r) => ({
      rule: r.id,
      status: "PASS",
      detail: "passes in 1 file"
    })),
    findings: [],
    files: [],
    notChecked: [],
    coverageComplete: true,
    modelCalls: 0,
    startedAt: 0,
    finishedAt: 1,
    ...extra
  };
}
