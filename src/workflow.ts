import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import {
  CheckError,
  type CheckDeps,
  type CheckInput,
  assemble,
  countCalls,
  doneMessage,
  evidenceRequests,
  fetchStage,
  fileStage,
  mapLimit,
  progressFor,
  readEvidence,
  settleStage
} from "./checker";
import { limits } from "./checker/limits";
import { jsonCaller, modelFor, workersAiText } from "./checker/model";
import { fitFiles } from "./checker/select";
import type {
  CheckStatus,
  CrossFileVerdict,
  EvidenceFile,
  FileCheck,
  Intent,
  Pr,
  PrFile,
  Progress,
  ProgressFile,
  RuleSet,
  Skipped
} from "./checker/types";
import type { AppEnv, ChatAgent } from "./server";

// What the agent hands the Workflow: everything the check needs that is not
// a binding, so a replay rebuilds the same check.
export type CheckParams = CheckInput & { startedAt: number };

export type CheckFailure = { kind: CheckError["kind"]; message: string };
export type RulesLookup =
  | { ok: true; set: RuleSet }
  | ({ ok: false } & CheckFailure);
export type CheckOutcome =
  | { checkId: string; status: CheckStatus }
  | { checkId: string; failed: CheckFailure };

type Failed = { failed: CheckFailure };
type Fetched = { pr: Pr; checked: PrFile[]; notChecked: Skipped[] };
type FileStep = { file: FileCheck; calls: number };
type EvidenceStep = { evidence: EvidenceFile; calls: number };
type Settled = { crossFile: CrossFileVerdict[]; intent: Intent; calls: number };

const STEP = { retries: limits.stepRetries, timeout: limits.stepTimeout };

// A failure the check reports as its outcome, as opposed to one a step retries.
function failure(e: unknown): Failed | null {
  return e instanceof CheckError
    ? { failed: { kind: e.kind, message: e.message } }
    : null;
}

// The check as a Workflow: one step to fetch, one to resolve the rules, one
// per file, one to settle across files, one to finalise. Results reach the
// agent by RPC from inside the steps, so a retry cannot write twice and a
// crash keeps the files already done. Step outputs carry results only, never
// file content.
export class CheckWorkflow extends AgentWorkflow<
  ChatAgent,
  CheckParams,
  Progress,
  AppEnv
> {
  async run(
    event: AgentWorkflowEvent<CheckParams>,
    step: AgentWorkflowStep
  ): Promise<CheckOutcome> {
    const input = event.payload;
    const files: ProgressFile[] = [];
    const progress = (stage: Progress["stage"], message: string) =>
      this.reportProgress(progressFor(input.id, stage, message, files));
    const deps: CheckDeps = {
      fetch: (i, init) => fetch(i, init),
      callJson: jsonCaller(workersAiText(this.env.AI, modelFor(this.env))),
      githubToken: this.env.GITHUB_TOKEN
    };
    const fail = async (failed: CheckFailure): Promise<CheckOutcome> => {
      await step.do("fail", async () => {
        await this.agent.failWorkflowCheck(
          input.id,
          failed.kind,
          failed.message
        );
      });
      const outcome = { checkId: input.id, failed };
      await step.reportComplete(outcome);
      await progress("error", failed.message);
      return outcome;
    };

    await progress("fetching", "Fetching the pull request");
    // The file list goes on without its diffs; only the selected files keep
    // theirs, up to the step output budget.
    const fetched = await step.do(
      "fetch-pr",
      STEP,
      async (): Promise<Fetched | Failed> => {
        try {
          const { pr, checked, notChecked } = await fetchStage(
            input.prUrl,
            deps
          );
          const fit = fitFiles(checked, limits.stepOutputChars);
          return {
            pr: { ...pr, files: pr.files.map((f) => ({ ...f, patch: null })) },
            checked: fit.checked,
            notChecked: [...notChecked, ...fit.dropped]
          };
        } catch (e) {
          const f = failure(e);
          if (f) return f;
          throw e;
        }
      }
    );
    if ("failed" in fetched) return fail(fetched.failed);

    const ruleSet = await step.do(
      "resolve-rules",
      STEP,
      async (): Promise<RuleSet | Failed> => {
        if (input.rules) return input.rules;
        const found = (await this.agent.rulesFor(fetched.pr)) as RulesLookup;
        return found.ok
          ? found.set
          : { failed: { kind: found.kind, message: found.message } };
      }
    );
    if ("failed" in ruleSet) return fail(ruleSet.failed);
    const rules = ruleSet.rules;

    for (const f of fetched.checked)
      files.push({ path: f.path, state: "queued" });
    await progress("checking", `Checking ${fetched.checked.length} files`);
    const fileSteps = await mapLimit(
      fetched.checked,
      limits.parallelModelCalls,
      async (file, i) => {
        files[i].state = "checking";
        await progress("checking", `Checking ${file.path}`);
        const done = await step.do(
          `check:${file.path}`,
          STEP,
          async (): Promise<FileStep> => {
            const counted = countCalls(deps.callJson);
            const result = await fileStage(
              rules,
              fetched.pr,
              file,
              counted.callJson,
              deps,
              input.previous ?? null
            );
            await this.agent.saveWorkflowFile(input.id, result);
            return { file: { ...result, raw: null }, calls: counted.calls() };
          }
        );
        files[i].state = done.file.state === "checked" ? "checked" : "failed";
        await progress("checking", doneMessage(files));
        return done;
      }
    );
    const results = fileSteps.map((s) => s.file);

    // Files the last check asked for: one step each, like a changed file.
    const requests = evidenceRequests(
      input.previous ?? null,
      ruleSet,
      fetched.pr
    );
    for (const r of requests) {
      files.push({ path: r.path, state: "queued", role: "evidence" });
    }
    const evidenceSteps = await mapLimit(
      requests,
      limits.parallelModelCalls,
      async (request, i) => {
        const at = fetched.checked.length + i;
        files[at].state = "checking";
        await progress(
          "checking",
          `Reading ${request.path} as requested evidence`
        );
        const done = await step.do(
          `evidence:${request.path}`,
          STEP,
          async (): Promise<EvidenceStep> => {
            const counted = countCalls(deps.callJson);
            const evidence = await readEvidence(
              rules,
              fetched.pr,
              request,
              counted.callJson,
              deps
            );
            return { evidence, calls: counted.calls() };
          }
        );
        const { state } = done.evidence;
        files[at].state =
          state === "read" || state === "missing" ? "checked" : "failed";
        await progress("checking", doneMessage(files));
        return done;
      }
    );
    const evidence = evidenceSteps.map((s) => s.evidence);

    await progress("checking", "Settling rules across files");
    const settled = await step.do(
      "settle",
      STEP,
      async (): Promise<Settled> => {
        const counted = countCalls(deps.callJson);
        const out = await settleStage(
          rules,
          fetched.pr,
          results,
          counted.callJson,
          evidence
        );
        return { ...out, calls: counted.calls() };
      }
    );

    const outcome = await step.do(
      "finalise",
      async (): Promise<{ checkId: string; status: CheckStatus }> => {
        const result = assemble({
          input,
          pr: fetched.pr,
          ruleSet,
          results,
          notChecked: fetched.notChecked,
          evidence,
          crossFile: settled.crossFile,
          intent: settled.intent,
          modelCalls: [...fileSteps, ...evidenceSteps].reduce(
            (n, s) => n + s.calls,
            settled.calls
          ),
          startedAt: input.startedAt,
          finishedAt: Date.now()
        });
        await progress("done", `Done: ${result.status.toUpperCase()}`);
        await this.agent.finishWorkflowCheck(result);
        return { checkId: input.id, status: result.status };
      }
    );
    await step.reportComplete(outcome);
    return outcome;
  }
}
