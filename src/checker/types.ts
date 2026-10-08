export type Verdict = "PASS" | "FAIL" | "UNSURE" | "NA";
export type Polarity = "must" | "must_not";

export type Rule = {
  id: number;
  text: string;
  polarity: Polarity;
  scope: "file" | "cross_file";
  appliesTo: string[] | null;
};

export type PrFile = {
  path: string;
  previousPath: string | null;
  status: string;
  sha: string;
  additions: number;
  deletions: number;
  patch: string | null;
};

export type Pr = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  headSha: string;
  baseRef: string;
  files: PrFile[];
  fileListTruncated: boolean;
};

export type Skipped = { path: string; reason: string };

export type FileVerdict = {
  rule: number;
  verdict: Verdict;
  quote: string | null;
  line: number | null;
  verified: boolean;
  reason: string;
  why: string;
  steps: string[];
  resolution: string | null;
  question: string | null;
  note: string | null;
};

export type FileWarning = {
  line: number | null;
  note: string;
  why: string;
  steps: string[];
};

export type FileCheck = {
  path: string;
  state: "checked" | "failed";
  reason: string | null;
  purpose: string;
  verdicts: FileVerdict[];
  facts: string[];
  warnings: FileWarning[];
  raw: string | null;
};

export type FindingKind = "blocking" | "question" | "warning";

export type Finding = {
  id: string;
  key: string;
  kind: FindingKind;
  rule: number | null;
  path: string;
  line: number | null;
  quote: string | null;
  summary: string;
  why: string;
  steps: string[];
  resolution: string | null;
  question: string | null;
  note: string | null;
};

export type RuleStatus = { rule: number; status: Verdict; detail: string };
export type CheckStatus = "pass" | "fail" | "unsure";

export type CheckResult = {
  schemaVersion: 1;
  id: string;
  workspace: string;
  pr: {
    url: string;
    owner: string;
    repo: string;
    number: number;
    title: string;
    headSha: string;
  };
  rulesHash: string;
  rules: Rule[];
  status: CheckStatus;
  ruleStatuses: RuleStatus[];
  findings: Finding[];
  files: FileCheck[];
  notChecked: Skipped[];
  coverageComplete: boolean;
  modelCalls: number;
  startedAt: number;
  finishedAt: number;
};

export type ProgressFile = {
  path: string;
  state: "queued" | "checking" | "checked" | "failed";
};

export type Progress = {
  checkId: string;
  stage: "fetching" | "checking" | "done" | "error";
  message: string;
  files: ProgressFile[];
};
