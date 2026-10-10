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
    origin: v === "FAIL" ? "introduced" : null,
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
    coverage: "full",
    reason: null,
    chunks: 1,
    purpose: "",
    verdicts,
    facts: [],
    warnings: [],
    seen: {},
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
    schemaVersion: 2,
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
    rulesSource: "the rules saved in this workspace",
    rules,
    strict: false,
    runner: "inline",
    status: "pass",
    ruleStatuses: rules.map((r) => ({
      rule: r.id,
      status: "PASS",
      blocking: false,
      complete: true,
      attested: false,
      waived: false,
      detail: "passes in 1 file"
    })),
    findings: [],
    crossFile: [],
    intent: {
      compared: false,
      summary: "The pull request has no description to compare.",
      unmentioned: [],
      unsupported: []
    },
    previous: null,
    files: [],
    notChecked: [],
    waivers: [],
    evidence: [],
    coverageComplete: true,
    modelCalls: 0,
    startedAt: 0,
    finishedAt: 1,
    ...extra
  };
}
