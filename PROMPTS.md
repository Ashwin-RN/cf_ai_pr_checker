# Prompts

The assignment asks for the prompt history behind AI-assisted coding.
This file records the prompts used to plan and build this app, in order.
Each entry gives the date, the prompt, and what came out of it.

## 2026-10-08: Planning and base setup

**Prompt:**

> let's start the Cloudflare build now... but lets plan and set up the base.

**What came out of it:** a spec, which I approved before any code was written.

- Start from Cloudflare's `agents-starter` template. It provides the chat UI and a Durable Object with state.
- LLM: Llama 3.3 on Workers AI, so no external key is needed.
- v1 behaviour: I give it rules, then a public GitHub pull request link. It fetches the diff and returns pass or fail per rule, quoting the deciding diff line.
- Memory: rules and past checks are stored in the Durable Object.
- The check runs as a fixed sequence (fetch, check, reply), not as tools the model chooses for itself.
- Workflows are left out of v1.
- Known limits: large diffs, GitHub's unauthenticated rate limit, and a model quoting a line that is not in the diff.

**Prompt:**

> yes. across the board for all 3

**What came out of it:** approval to scaffold the template and approval of the spec. The template was scaffolded, renamed to `cf-ai-pr-checker`, and given this file and a README outline.

## 2026-10-08: Widening the spec

These prompts were asked in a planning conversation, before any checker code was written.

**Prompt:**

> Can you explain to me what a PR checker does? And what are the potential gaps that would make it unusable?

**What came out of it:** the worst failure is a false PASS. Two guards were added: a third verdict, UNSURE, for rules the diff alone cannot settle; and a check in code that every line the model quotes really is in the diff.

**Prompt:**

> Is there any way for us to also pull up the relevant code to the PR and understand what the point of that code is and see if we can give like a list of potential limits or worthwhile checks outside of our scope? ... it would make it usable in case of somebody using a bigger model and we just shrink down the potential problems by cheaply pointing out a bunch of them.

**What came out of it:** fetch the full content of each changed file, say in one line what each file is for, and list at most five considerations a reviewer should still check. Considerations are pointers, never verdicts.

**Prompt:**

> Another wild idea would be to split it into multiple PRs and analyze it in pieces. Would that work with a smaller context window? ... if say the PR touches four files, we can have four different checks run instead of just one if the files are big.

**What came out of it:** one model check per file, run in parallel, then a merge. Rules that span files (a route in one file, its test in another) are handled by having each file check report facts as well as verdicts, and a small final call reads only the facts. Verdicts are merged by code, not the model. Moving the per-file checks into a Cloudflare Workflow became step 3.

**Prompt:**

> We can aim for step 3 as well. But let's do step 1 and 2 in one blow and check it out.

**What came out of it:** steps 1 and 2 are built together. Step 3 is decided once they work.

## 2026-10-08: Scoping before the build

**Prompt:**

> Build steps 1 and 2 from the Design section in README.md... However, before we actually go into building, I want to see if we can scope and plan out as well as possible to build this into a strong base with potential for upward scale. How do we design for this? What are the considerations? And how can we achieve this? Are there any other approaches worth looking into to achieve a more usable PR checker, for example?

**What came out of it:** a design plan. The decisions that are hard to change later were fixed before any code:

- The checker is a plain module with a typed input and output. The chat, an HTTP API, a CI job, a Workflow, and an MCP server are callers of it. Nothing in the engine imports the agent or the UI.
- Code decides, the model reports. The model emits JSON against a schema. Code verifies quotes, merges verdicts, tracks coverage, and renders the reply.
- Verified platform numbers drove the caps: Llama 3.3 has a 24k context window and JSON Mode, so checks are per file; the Workers Free plan allows 50 external subrequests per invocation, so the file cap is 20.
- Two problems found in the scaffold: the chosen model needs the Workers Paid plan, and the client connected every visitor to one Durable Object named `default`.
- Evidence has two kinds. Presence is quoted and verified. Absence cannot be quoted, so its strength is the coverage of what was shown, and code downgrades it when coverage is incomplete.
- The same engine will sit behind the chat, an HTTP endpoint for CI, and later an MCP server. Rules can also be read from a `pr-rules.md` file in the checked repository.

## 2026-10-08: M0, base hygiene

**Prompt:**

> start M0 on a branch

**What came out of it:** the branch `m0-base-hygiene`. The template's demo tools, MCP panel and image attachments were removed. The model became Llama 3.3 on Workers AI, which the Free plan allows. Each visitor now gets their own Durable Object, named from a workspace id in the URL, instead of everyone sharing one instance. Vitest was added with the first tests. CI now runs the tests, and deploys main when the Cloudflare secrets are set.

Testing the chat in the browser showed every streamed word twice. The raw Workers AI stream for Llama 3.3 carries each piece of text in two fields, `choices[0].delta.content` and `response`, and the `workers-ai-provider` package reads both. The chat now reads the stream from the binding directly and takes one field, with a test that pins that down. The provider package was removed.

## 2026-10-08: M1, the engine and the report

**Prompt:**

> I think the output shape should match that of a agent reading it rather than a human, or maybe something in between. Give it steps for checks and a short note as to why. If there are no gaps, then mention warnings and structure it extremely systematically in the output. ... We won't fix code or directly change code. We just analyze, determine whether this is the intended output.

**What came out of it:** the report became a contract for the coding agent that wrote the pull request, and the engine behind it was built on the branch `m1-vertical-slice`.

- Fixed sections every time, in the same order: Status, Blocking, Questions, Warnings, Not checked, Intent. An empty section says "none".
- Every finding has an id (F1, Q1, W1), a key that stays stable across runs, a quote where one exists, a reason, why the rule matters, steps the author runs on their own code, and what resolves it. UNSURE verdicts carry one question.
- Verification in code: a verdict that claims something is present must quote a line that exists in the diff. A quote that is missing, or that matches a line the pull request removes, turns the verdict into a question. Every verified FAIL gets a second model call with only the quoted line and its neighbours in view; if that call disagrees, the FAIL becomes a question.
- Rules are normalised once: must or must not, one file or many, and a directory scope. The scope is accepted only when the rule text names the directory, after a live run showed malformed path hints silently turning two rules off for every file.
- The same engine answers the chat and `POST /api/check`, which takes a bearer token.

Smoke-tested against this repository's own pull request #1, in the chat and over the API.

## 2026-10-08: M2, full files, rules that span files, and the loop

**Prompt:**

> can we start m2?

**What came out of it:** the branch `m2-widen`. The check now sees whole files and the report closes the loop with the agent that wrote the code.

- Each changed file is fetched in full at the head commit and shown with the added and removed lines marked. A file over the size cap is checked in parts around its changes, and past six parts it counts as partially checked.
- With whole files in view, an old violation on an untouched line would fail every pull request that touches the file. A verified FAIL on a line the pull request does not change is now labelled pre-existing: reported with its quote, kept as FAIL per rule, but not blocking unless the check runs in strict mode.
- Rules that span files are settled by one call over numbered facts from every checked file plus the file list. A verdict is accepted only when it cites facts that exist.
- One call compares the title and description with the facts. Changes the description does not mention, and claims the files do not support, land in Warnings and the Intent section.
- A second check of the same pull request marks each finding new or still open and lists what was resolved, by stable key.
- Rules come from `pr-rules.md` at the base branch of the checked repository when it has one, or from the pull request itself when it adds the file. This repository has one, and `templates/pr-rules.md` is a starter. Rules sent with an API request come first, then the file, then the workspace's saved rules.
- Coverage is tracked per rule, so a lockfile or a file outside a rule's directory does not downgrade that rule. A quote now verifies on a whole-line match, or a substring only past twelve characters, because substring matching over a whole file would verify almost anything.
- A public fixture repository holds eleven open pull requests, one per case: clean, a console.log, a prompt injection beside a real violation, near-duplicate lines, more files than the cap, a TODO without a link, a pre-existing violation, a new function without a test, an unpinned action, a hardcoded secret, and a 65 KB file changed in two places. `npm run eval` runs them and counts false PASSes.
- `pr-check.yml` checks this repository's own pull requests with its rules file and keeps one comment on the pull request up to date.

**Prompt:**

> I'm getting a bunch of fail emails. Check it out.

**What came out of it:** the fixture repository's own CI was failing on every pull request because its test script passed a directory to `node --test`, which Node reads as a module path. Fixed with a glob, verified locally on every branch, and pushed as a normal commit with the branches rebased, after a first attempt that rewrote the base branch closed all the pull requests.

The first live run also hit the Workers AI Free plan's daily cap of 10,000 neurons, used up by the day's earlier runs. The run came back UNSURE on every rule with every file under "Not checked" and the model's error quoted, which is the designed failure mode: no false PASS. A rule interpretation that failed the same way had been cached under the rules' hash; the store now keeps a failed interpretation only as the workspace's rules and retries the model on the next save.

## 2026-10-09: M3, the check as a Workflow

**Prompt:**

> nevermind testing things then. lets focus on getting stage 3 off the ground?

**What came out of it:** the branch `m3-workflow`. Each check now runs as a Cloudflare Workflow.

- The engine is split into four stages that both runners share: fetch and select, one per file, settle across files, assemble. Running them in one process gives the same result as running them as steps, and a test holds the two equal.
- `CheckWorkflow` runs the stages as durable steps: `fetch-pr`, `resolve-rules`, one `check:<path>` per file with five in flight, `settle`, `finalise`. Rules resolve through the agent by RPC, since that path needs the store and the rules file. Every step hands its result to the agent by RPC before it returns, so a retry cannot write twice and a crash keeps the files already done. A failure the check owns, such as a missing rules file, is returned as data rather than thrown, so the step is not retried and the failure keeps its kind.
- Step outputs are capped at 1 MiB, so the file list travels without its diffs and the selected diffs are trimmed to a budget; a file dropped for that is a named coverage gap. Raw model output goes to the store, never into a step output.
- The agent starts the Workflow with the check id as the instance id, forwards progress to whoever is waiting, and takes the result when the last step stores it, with the stored row as the fallback and a deadline after which the Workflow is stopped. A chat check whose stream was lost to a restart still gets its report appended to the conversation once, and a reload mid-check was tested to land it once.
- `CHECK_RUNNER=inline` keeps the one-process runner, and the JSON block names the runner a check used.
- Tested locally under the exhausted model budget, which exercises every step with model errors as results, and on the deployed Worker, where the instance shows as completed.

The Workers AI cap from the day before had not lifted at 03:00 UTC despite the documented midnight reset and zero usage for the day, which matches unanswered community threads; the evaluation run waits for it.

## 2026-10-09: Trust, part one: the harness

**Prompt:**

> [a pasted review of the repository at `ffb822a`] this is a report of our repo so far... what do you think? lets make a plan to address the concerns you agree with.

**What came out of it:** every finding in the review was checked against the code, and all seven held: the chat transport could open any workspace name, including the API's; four paths in the merge could end in PASS without the evidence for it; a rule's directory scope accepted an invented parent directory; a big file cut into windows counted as fully covered; a finding whose file was not checked this run counted as resolved; the evaluation runner exited green on an error; and cross-file verdicts rest on model summaries. The plan is two pull requests: the harness first, so a green result can be trusted to mean what it says, then the verdict core.

**Prompt:**

> I accept your recommendation on one. Uh, same on two as well. Let's not push the draft. I don't know what the best approach for CI is. I think maybe we should fail on unsure. I'm not sure. Um, you would be able to tell me what's better for that.

**What came out of it:** the branch `trust-harness`.

- API workspaces are a name space of their own. The Worker opens them under a prefix no chat id can carry, and the chat transport admits only the page's own id shape through the router's `onBeforeConnect` and `onBeforeRequest` hooks; any other name gets a 404 before it reaches a Durable Object. Checked live on a local server: `ci` and `api:ci` are refused on the chat path, and the API still reaches `ci` with the token.
- `modelCalls` now counts model runs, validation retries and capacity backoffs included; each answer from the model caller says how many runs it took.
- The evaluation runner scores through `eval/score.ts`, which has its own tests, and exits non-zero on any case it could not score: an error from the checker, a rule missing from the answer, or a fixture whose head has moved. Before, such a run exited green.
- `pr-check.yml` skips drafts, since a push to a draft is frequent and each check spends a share of the day's model budget. It now ends in two status checks, `rules` and `verified`, so branch protection can require a failing rule to block, or require every rule to be verified; `unsure` is red on the second. A skipped job counts as passing for a required check, so both run whenever the check job did and read how it ended.
- A `.gitattributes` keeps the working tree on LF, which ends the format check failing on a Windows checkout.

**Prompt:**

> [a second review, pasted without comment, of the commit `d750cea`]

**What came out of it:** five more changes on the same branch, since the review found the harness not yet honest in five places.

- The `verified` status check read only the overall status, which a pre-existing failure beside a file over the cap can leave at pass. It now reads the JSON block: every changed file checked, no rule FAIL anywhere, and it is red when the checker is not configured, since nothing was verified then.
- The evaluation scores the overall status and the blocking policy in their own right: a check that should fail or stay unsure but passes, or a rule that should block and does not, is a false PASS even when every rule verdict was right. One cause counts once.
- The model call that interprets the rules happens before the stages and was not counted; the count now travels on the rule set, so a check that interpreted its rules reports one call more than one that read them from the cache.
- `--only` that matches no case is an error, not a green run over nothing.
- The README says that a deployment upgraded across the name-space change starts its API workspaces empty, and that pull requests from forks are not checked, since secrets are not available to them.

## 2026-10-09: Trust, part two: the verdicts

**Prompt:**

> start PR B

**What came out of it:** the branch `trust-verdicts`, which changes how a verdict is decided so that a PASS means the evidence was seen.

- A PASS claimed without a quote the file contains is UNSURE and a question, like an unverified FAIL. A rule the model returned no verdict for is UNSURE for that file; silence is not a pass.
- Every rule status says whether its coverage is complete, and the check is UNSURE on any gap, so a pre-existing failure beside a file over the cap no longer reads as pass.
- A rule that spans files takes its verdict from the cross-file step. A file's own verdict on such a rule is one of that step's inputs, a FAIL included, and never decides alone; without the step the rule is UNSURE. A cross-file FAIL stands only when every file the rule needed was checked and no file's facts were cut short; otherwise it is a question that says so.
- A path hint is kept only when the rule names every directory on it, so an invented parent directory no longer narrows a rule.
- A file checked in windows is prompted as parts even when there is one window, and counts as checked for its change: complete for a "must not" rule and a rule that spans files, a gap for a per-file "must" rule.
- Finding keys no longer include the kind, so a FAIL that becomes a question keeps its key. A previous finding whose file or step was not checked again is listed as not assessed rather than resolved. Cross-file findings sit at `(across files)`.
- The README says what the cross-file step rests on and what a windowed file does and does not cover.

## 2026-10-09: M4, the MCP server and the answer loop

**Prompt:**

> can you start m4?

**What came out of it:** the branch `m4-mcp`. The same engine is now an MCP server, and a question in a report can be answered.

- `McpAgent` from the Agents SDK serves `/mcp` over Streamable HTTP behind the API token. The workspace is named in the URL and bound to the session; each session is a Durable Object of its own, and its tools reach the workspace's agent over RPC, the way the Workflow does. The tools are `check_pr`, `get_check`, `answer_question`, `get_rules`, `set_rules` and `list_checks`; each returns the text an agent reads and the same as structured content. `check_pr` sends progress notifications to a client that asks for them, and the check keeps running if the stream is cut: a client that gave its own `check_id` reads the result back with `get_check`, and `list_checks` finds it otherwise.
- An answer is stored per pull request and finding key, with the commit and the rule set it was given against. The next check applies answers after the merge and before the diff: a question with an answer is listed as answered, after the open ones, and a rule that was UNSURE only because of answered questions passes by attestation, marked in the rule table, the status line and the JSON. An answer never touches a FAIL or a coverage gap, counts for nothing under strict, and is stale once the rules change. The same answer path serves the chat (`answer Q2: ...`), `POST /api/answer` and MCP, and replies with what the same evidence gives with the answers so far, without a model call.
- The `verified` status check in CI stays red on a pass by attestation: a pass on the author's word is not a verified one.
- The router hook checks the Durable Object class as well as the instance name, so an MCP session cannot be reached over the chat route.
- The tool contract is tested over the SDK's in-memory transport against a faked workspace; the answer logic is tested on its own and through the assembly, where an answered item stays open in the diff rather than resolved. Live on a local server, with no model calls: the token and workspace guards, the router, a session over Streamable HTTP, and every tool through RPC to the workspace agent. A check over MCP against a real pull request waits, like the evaluation, for a day of Workers AI budget.
- Left for later: `waive_rule`, which needs the exceptions table and the handling of a waived FAIL in the report and CI; and fetching a named file on request.

**Prompt:**

> [a third review, pasted without comment, of the commit `be167a5`]

**What came out of it:** eleven findings, each reproduced by reading the code, and a change for each on the same branch, with a test named after the review's scenario.

- A failure on a line the pull request does not change no longer outranks an open point on another file: the rule reads UNSURE and names both, so the check cannot pass over an unanswered question. Once the question is answered the rule returns to that failure, not to PASS.
- A file checked in parts needs a verdict from every part; a part that says nothing about a rule leaves it UNSURE.
- On a file checked in parts, an earlier finding counts as assessed only when the line it quoted was shown to the model again or is gone from the file, so a violation outside the windows is listed as not assessed rather than resolved. Under strict such a file is a coverage gap for every rule.
- A cross-file PASS is held to uncut facts like a FAIL: a capped or cut fact list makes it a question.
- A directory scope is kept only when the rule names the path itself; "src/ or test/" no longer admits `src/test/`.
- The evaluation scores a blocking expectation on its own, so a rule that should block and comes back UNSURE fails the run.
- An answer no longer settles a different question that a later push raises under the same key.
- A finding one run could not assess is carried to the next until a run looks at it.
- A result stored by an earlier build is filled in on read instead of failing to render.
- A client-supplied check id is kept apart per workspace inside the Workflow, whose instance ids are unique per Workflow.
- An answer that cites a pull request link is recorded as an answer, not run as a check.

## 2026-10-10: The first eval run

**Prompt:**

> whats pending for us? its a new day.

**What came out of it:** a check that the Workers AI daily cap had cleared (a two-token probe on the smallest model, then the usage analytics), and the order for the day: the evaluation set first, the README's sample report and results table from it, then the next milestone.

**Prompt:**

> go

**What came out of it:** the first full run of the eleven cases, then a fix, then the run again.

- Before spending any budget, the API was given an optional `checkId` and `GET /api/checks/<id>` learned to answer 202 while a check runs, so the eval runner can read a check back if the connection drops; verified at no cost with bad ids, a bad link and an unknown id.
- The first run: 66 model calls, no false PASS and no false FAIL, but five wrong statuses and 24 UNSURE rules with one cause, read from the raw verdicts in the local Durable Object database rather than from another run. A file is checked against the rules that apply to its path, so the model saw rule numbers with gaps and closed them, shifting every verdict after the gap. The rules now go to the model numbered as listed and are mapped back in code; three cases were run again to confirm it.
- The second full run: 67 calls, no false PASS, no false FAIL, one wrong status. The three rules still off are questions the report asks, listed with the table in the README.
