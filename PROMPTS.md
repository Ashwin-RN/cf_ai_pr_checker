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
