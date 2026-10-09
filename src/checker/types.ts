export type Verdict = "PASS" | "FAIL" | "UNSURE" | "NA";
export type Polarity = "must" | "must_not";

export type Rule = {
  id: number;
  text: string;
  polarity: Polarity;
  scope: "file" | "cross_file";
  appliesTo: string[] | null;
};

// `calls` is the model calls spent interpreting the rules for this check.
// A set read back from the cache spends none.
export type RuleSet = {
  rules: Rule[];
  hash: string;
  source: string;
  calls?: number;
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

// A file the check did not look at. `coverage` says whether that leaves a
// gap a rule could hide in.
export type Skipped = { path: string; reason: string; coverage: boolean };

// Where a failing line comes from: a line this pull request adds, or one it
// leaves as it was.
export type Origin = "introduced" | "pre-existing";

export type FileVerdict = {
  rule: number;
  verdict: Verdict;
  quote: string | null;
  line: number | null;
  verified: boolean;
  origin: Origin | null;
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
  // How much of the file the model saw: all of it, the windows around its
  // changes, or less than that (the diff alone, a cut, a failed part).
  coverage: "full" | "changes" | "partial";
  reason: string | null;
  chunks: number;
  purpose: string;
  verdicts: FileVerdict[];
  facts: string[];
  warnings: FileWarning[];
  raw: string | null;
};

export type Fact = { index: number; path: string; text: string };

// One rule settled from the facts of every file, for rules no single file can decide.
export type CrossFileVerdict = {
  rule: number;
  verdict: Verdict;
  facts: Fact[];
  reason: string;
  why: string;
  steps: string[];
  resolution: string | null;
  question: string | null;
  note: string | null;
};

export type Intent = {
  compared: boolean;
  summary: string;
  unmentioned: Array<{ path: string; text: string; note: string }>;
  unsupported: string[];
};

export type FindingKind = "blocking" | "question" | "warning";

// A question answered by the author: the rule is met in a way the check
// could not see. It is the author's word, not evidence, and it is keyed by
// the finding it answers, within one pull request.
export type Attestation = {
  key: string;
  rule: number | null;
  path: string;
  question: string;
  answer: string;
  checkId: string;
  headSha: string;
  rulesHash: string;
  createdAt: number;
};

// How a question on a finding was answered, and whether the answer counts
// toward the rule's status in this run.
export type Answered = {
  answer: string;
  headSha: string;
  at: number;
  counted: boolean;
  note: string | null;
};

export type Finding = {
  id: string;
  key: string;
  kind: FindingKind;
  rule: number | null;
  path: string;
  line: number | null;
  quote: string | null;
  origin: Origin | null;
  change: "new" | "open" | null;
  summary: string;
  why: string;
  steps: string[];
  resolution: string | null;
  question: string | null;
  note: string | null;
  attestation: Answered | null;
};

// `complete` is false when a file in the rule's scope was not covered for
// it, whatever the status says. `attested` is true when the status is PASS
// on the author's answers rather than on evidence the check saw.
export type RuleStatus = {
  rule: number;
  status: Verdict;
  blocking: boolean;
  complete: boolean;
  attested: boolean;
  detail: string;
};
export type CheckStatus = "pass" | "fail" | "unsure";
// Where a check ran: as a Cloudflare Workflow, or inside the Durable Object.
export type Runner = "workflow" | "inline";

// What the last finished check of the same pull request found.
export type PreviousRun = {
  checkId: string;
  headSha: string;
  rulesHash: string;
  findings: Array<{
    id: string;
    key: string;
    kind: FindingKind;
    rule: number | null;
    path: string;
    summary: string;
  }>;
};

export type RunDiff = {
  checkId: string;
  headSha: string;
  rulesChanged: boolean;
  new: number;
  open: number;
  resolved: PreviousRun["findings"];
  // Previous findings whose file or step this run did not check again, so
  // their absence says nothing.
  unassessed: PreviousRun["findings"];
};

export type CheckResult = {
  schemaVersion: 2;
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
  rulesSource: string;
  rules: Rule[];
  strict: boolean;
  runner: Runner;
  status: CheckStatus;
  ruleStatuses: RuleStatus[];
  findings: Finding[];
  crossFile: CrossFileVerdict[];
  intent: Intent;
  previous: RunDiff | null;
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
