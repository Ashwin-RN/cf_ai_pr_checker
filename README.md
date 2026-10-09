# cf_ai_pr_checker

A pull request checker on Cloudflare, written for the agent that wrote the code.

You give it rules in plain English, or commit them as `pr-rules.md` in the repository.
You give it a public GitHub pull request link.
It fetches every changed file in full, checks each against every rule with a small model, verifies each quoted line in code, settles rules that span files from per-file facts, compares the description with the change, and returns a report with a fixed shape: what blocks, what needs an answer, what to watch, what was not checked, and the steps that resolve each item.
The reader can be a person or the coding agent that opened the pull request. It never edits code.

Live: https://cf-ai-pr-checker.ashwin-rn.workers.dev

**Status:** whole-file checks, rules that span files, an intent check, a run-to-run diff, rules from the repository, a CI job that comments on pull requests, an evaluation set, each check running as a Cloudflare Workflow with one durable step per file, and an MCP server with the answer loop: an agent runs the check, answers the questions it can, and sees the answers honoured on the next run. Exceptions and rule statistics come next.

## The loop

The report is written so that the agent that pushed the code can act on it without a person in between. Paste this into the agent's instructions:

```
After pushing a pull request, run the check and read the report:
  over MCP: the server at https://cf-ai-pr-checker.ashwin-rn.workers.dev/mcp?workspace=<team>
  with the bearer token; call check_pr with the pull request link.
  over HTTP: POST https://cf-ai-pr-checker.ashwin-rn.workers.dev/api/check
  {"prUrl": "<pull request link>", "workspace": "<team>"}
or read the "PR check" comment on the pull request.
Work through Blocking, then Questions, then Warnings. Each item has steps to
run against your own code and the condition the next check verifies. When a
question is settled because the rule is met somewhere the check cannot see,
answer it with answer_question (or POST /api/answer) and say where; never
answer a question when the rule is not met. Push, run the check again, and
repeat until the status is pass. Keys stay the same across runs, so an item
that is still open is the same item, and an answered one stays answered.
```

A report from a run against a fixture pull request that adds one file with a `console.log` call:

A full sample report from a run with a fresh Workers AI budget is still to be added here; the shape is described under "The report" below.

## How it meets the assignment

| Required component      | How this app does it                                                                                                                                                                                                                                                                                                                                                                                | Where in the code                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| LLM                     | Llama 3.3 on Workers AI, JSON Mode at temperature 0. One call to interpret the rules, one per changed file (or per part of a big file), one second look at each FAIL, one to settle rules across files, one to compare the description with the change                                                                                                                                              | `src/checker/model.ts`, `src/checker/prompts.ts`                                                   |
| Workflow / coordination | A Cloudflare Workflow runs each check as durable steps: fetch the pull request, resolve the rules through the agent, one step per file a few at a time, settle across files, finalise. Each step hands its result to the workspace's Durable Object by RPC, so a retry cannot write twice and a crash keeps the files already done. The same stages run in one process behind `CHECK_RUNNER=inline` | `src/workflow.ts`, `src/checker/index.ts`, `src/server.ts`                                         |
| User input via chat     | Chat UI served by the Worker, with a progress card per check. The same engine sits behind `POST /api/check`, which the CI job calls, and behind an MCP server, which a coding agent or an editor calls                                                                                                                                                                                              | `src/app.tsx`, `src/server.ts`, `src/mcp.ts`, `src/mcp-tools.ts`, `.github/workflows/pr-check.yml` |
| Memory or state         | Rules, checks and per-file results in the Durable Object's SQLite storage. The last check of the same pull request is what the run-to-run diff reads                                                                                                                                                                                                                                                | `src/store.ts`                                                                                     |

## How a check runs

A check is a Cloudflare Workflow. Fetching is one step and resolving the rules another; each file is a step of its own, five at a time, covering check and verify; settling and intent share a step; merge, render and diff share the last. A step that fails outright is retried; a model error is a result, not a retry. Every step hands what it found to the workspace's Durable Object by RPC before it returns, so a retried step cannot write twice and a Workflow that dies keeps the files already done. Step outputs carry results only, never file content. The agent starts the Workflow, forwards its progress to the chat or the API caller, and takes the result when the last step stores it. With the variable `CHECK_RUNNER=inline` the same stages run inside the Durable Object instead, and the JSON block names which runner a check used.

1. **Rules.** From `pr-rules.md` at the root of the pull request's base branch when the repository has one; when the pull request itself adds that file, from its head commit; otherwise the rules saved in the workspace with a message starting with `rules:`. Rules sent with an API request come first. One model call reads each rule as "must" or "must not", one file or many, and a directory scope. The scope is kept only when the rule itself names every directory on the path; a hint the rule does not name is dropped and the rule applies everywhere, so a bad guess widens a rule and never narrows it. The JSON block shows the directories each rule was limited to. The interpretation is cached by the hash of the rule text.
2. **Fetch.** The pull request and its changed files come from the GitHub API, and each file's full content at the head commit from raw.githubusercontent.com. Lockfiles, minified, vendored, binary and deleted files are skipped and listed. Source files come first, then tests, then config and docs. At most 20 files are checked and the rest are named.
3. **Check.** The whole file goes to the model with the rules that apply to its path, added lines marked `+` and removed lines shown in place. A file over 40,000 characters is cut into windows around its changes with 80 lines of context either side, and is prompted as parts even when there is one window. Such a file counts as checked for its change: that settles a "must not" rule and a rule that spans files, but a per-file "must" rule may be met anywhere in the file, so for it the rest of the file is a coverage gap. Past six windows the file counts as partially checked for every rule. The model returns, per rule, PASS, FAIL, UNSURE or NA with a quote, a reason, why the rule matters, steps for the author, what resolves it, and a question for UNSURE. It also returns facts about the change and up to three warnings.
4. **Verify.** A verdict that says something is present must quote a line that is in the file: a whole-line match, or a substring of twelve characters or more. A quote that is missing, or that matches a line the pull request removes, turns the verdict into a question. Every verified FAIL gets a second call that sees only the quoted line and its neighbours; if that call disagrees, the FAIL becomes a question too. A FAIL whose line the pull request does not change is labelled pre-existing. Steps that name a file the checker never saw are marked.
5. **Settle across files.** Rules no single file can decide ("every new route has a test") get one call over numbered facts: the file list and what each checked file reported. A verdict is accepted only when it cites facts that exist. This step never sees code: the facts are each file's own summary of what it does. A file's own FAIL or UNSURE on a rule that spans files goes to it as an open point.
6. **Intent.** One call compares the title and description with the facts. Changes the description does not mention, and claims the files do not support, become warnings.
7. **Merge and render.** For a rule one file can decide: any verified FAIL is FAIL, blocking when at least one failing line is one the pull request adds; otherwise an unverified FAIL, an UNSURE, or a PASS claimed without a quote the file contains is UNSURE; otherwise PASS when every file in the rule's scope was fully checked, and UNSURE when some were not. A rule the model returned no verdict for is UNSURE for that file. A rule that spans files takes its verdict from the cross-file step: its FAIL stands only when every file the rule needed was checked and no file's facts were cut short, and is a question otherwise; without that step the rule is UNSURE. The check is FAIL on a blocking rule, UNSURE when any rule is UNSURE or has a file in its scope the check did not cover, and PASS otherwise. Code renders the report. The model never writes it.
8. **Answers.** A question the author answered on an earlier check of the same pull request (see "MCP" below) is matched by its key. The item is listed as answered, and a rule that was UNSURE only because of answered questions passes by attestation, marked as such. An answer never touches a FAIL or a coverage gap, counts for nothing under `strict`, and is stale once the rules change, since rule numbers are positions in the rules file.
9. **Diff.** If the same pull request was checked before in this workspace, each finding is marked new or still open and the resolved ones are listed, by key. A previous finding whose file or step this run did not check again is listed as not assessed, not as resolved. An answered question stays in the list as the same item.

## The report

Six sections, always in this order, with "none" when empty: Status, Blocking, Questions, Warnings, Not checked, Intent. Blocking items are `F1, F2, ...`, questions `Q1, ...`, warnings `W1, ...`. Each carries a key that stays the same across runs of the same pull request, and keeps it when a blocking item becomes a question. A finding from the cross-file step is placed at `(across files)` and names the facts it rests on. The keys changed in this version, so the first check of a pull request after the upgrade marks its findings new and lists the previous ones as resolved or not assessed. A blocking item on a line the pull request does not change is tagged pre-existing: it is reported with its quote and keeps the rule at FAIL, but it does not fail the check unless `strict` is set. A question the author has answered stays under Questions after the open ones, tagged answered, with the answer, the commit it was given at and whether it counted; the rule table then reads `PASS (attested)` and the status line counts such rules.

Over the API the report also ends with a JSON block that mirrors it: `schema_version`, `check_id`, the runner, the rules with their status, whether each blocks, whether its coverage is complete and whether it passes by attestation, the findings with their answers, the cross-file verdicts with the facts they cite, the intent comparison, what changed since the last run, what was not checked, the number of model calls, how to run the same check again over the API or MCP, and how to answer a question.

## Rules in the repository

Commit a `pr-rules.md` at the root of the repository and every check of its pull requests uses it. The pull request that adds the file is checked against it. Only the list items count as rules; headings and prose around them are ignored, so the file can explain itself. [`templates/pr-rules.md`](templates/pr-rules.md) is a starter set. This repository's own [`pr-rules.md`](pr-rules.md) is what its CI job checks.

## Try it

Send this in the chat:

```
rules:
No console.log or console.debug in files under src/
Every workflow under .github/workflows/ pins actions to a major version tag
No secret values are hardcoded; references like secrets.X are fine
```

Then paste a public pull request link, for example `https://github.com/Ashwin-RN/pr-check-fixtures/pull/2`. The progress card fills in as files are checked and the report follows. That repository has its own `pr-rules.md`, so the report names it as the source; a repository without one is checked against the rules you saved. `history` lists past checks.

## HTTP API

Set the Worker secret `API_TOKEN`; without it the API answers 503. Then:

```bash
curl -X POST https://cf-ai-pr-checker.ashwin-rn.workers.dev/api/check \
  -H "authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prUrl":"https://github.com/owner/repo/pull/123","workspace":"ci"}'
```

`rules` (a string or an array of strings) is optional and, when given, is used for this check and saved for the workspace. `strict: true` makes pre-existing failures block and answered questions not count. `workspace` defaults to `api`. API workspaces are a name space of their own: one cannot be opened from the chat, and a chat workspace cannot be named over the API. A deployment upgraded from before this name space starts its API workspaces empty; the old history stays under the old instance names, which nothing reads. The response is the JSON block described above plus `report_markdown`. `GET /api/checks/<check_id>?workspace=ci` returns a stored result. `POST /api/answer` with `{"checkId", "question", "answer", "workspace"}` answers a question on a finished check, `question` being the item's id in that report, such as `Q2`, or its key; the reply carries the stored answer and what the same evidence gives with every answer so far.

For local development, put `API_TOKEN=...` in `.dev.vars`.

## MCP

The same engine is an MCP server at `/mcp`, over Streamable HTTP, behind the same `API_TOKEN`. The workspace is named in the URL and bound to the session: `/mcp?workspace=ci` opens the workspace the HTTP API knows as `ci`, and the default is `api`. For Claude Code:

```bash
claude mcp add --transport http pr-checker "https://cf-ai-pr-checker.ashwin-rn.workers.dev/mcp?workspace=ci" \
  --header "Authorization: Bearer $API_TOKEN"
```

Six tools. Each returns the text an agent reads and the same as structured content.

| Tool                     | What it does                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check_pr`               | Runs the check on a pull request link, with `rules` and `strict` as in the API. Returns the report, and reports progress to a client that asks for it. If the call is cut off, the error names the check id and `get_check` returns the result once it is in |
| `get_check`              | A check by id: the report once it has finished, its progress while it runs, or its error                                                                                                                                                                     |
| `answer_question`        | Answers a question on a finished check, by the item's id in that report or its key                                                                                                                                                                           |
| `get_rules`, `set_rules` | The workspace rules as interpreted; saving returns the interpretation. A repository with a `pr-rules.md` is still checked against that file                                                                                                                  |
| `list_checks`            | Past checks in the workspace, newest first                                                                                                                                                                                                                   |

**Answering a question.** A question is a rule the check could not settle from what it saw: a test that lives outside the pull request, a quote the file did not contain, a rule that spans files. An answer is the author's word that the rule is met, with where to look. It is stored per pull request and question key, so it holds across pushes, and the next check takes it: the item is listed as answered and a rule that was UNSURE only because of answered questions passes by attestation, marked in the rule table, the status line and the JSON. An answer is a claim, not evidence: it never touches a FAIL or a coverage gap, it counts for nothing under `strict`, and it is stale once the rules change. Answering the same question again replaces the answer. The reply previews what the same evidence gives with the answers so far, without a model call. The same path serves the chat, as `answer Q2: <how the rule is met>` on the last check or `answer Q2 on <check id>: ...`, and the HTTP API, as `POST /api/answer`.

## CI

[`.github/workflows/pr-check.yml`](.github/workflows/pr-check.yml) runs on every pull request to this repository once it is out of draft. It posts the pull request to the deployed Worker, writes the report to the job summary, and keeps one comment on the pull request up to date with it. Two status checks come out of it: `rules` fails when a rule fails on a line the pull request adds, and `verified` fails unless every file a rule applies to was fully checked and every rule passed on evidence, so `unsure`, a file over the cap that a rule needed, a pre-existing failure and a pass by attestation are all red there. Branch protection can require either: `rules` to block a merge on a failing rule, `verified` to block it until everything is verified. The workflow needs two repository secrets, `CHECKER_URL` and `CHECKER_API_TOKEN`; without them `rules` prints a notice and passes, and `verified` fails, since nothing was verified. Pull requests from forks are not checked, because secrets are not available to them.

## Evaluation

[`eval/cases`](eval/cases) holds eleven cases, each an open pull request in [Ashwin-RN/pr-check-fixtures](https://github.com/Ashwin-RN/pr-check-fixtures) with the status and per-rule verdicts it should get: a clean change, a `console.log`, a prompt injection next to a real violation, near-duplicate lines, more files than the cap, a `TODO` without a link, a pre-existing violation, a new function without a test, an unpinned action, a hardcoded secret, and a 65 KB file changed in two places.

```bash
CHECKER_URL=http://localhost:5173 API_TOKEN=dev-token npm run eval
```

It prints one row per case and exits non-zero on any false PASS: a rule that should have failed or needed an answer but came back PASS, a rule that should block and does not, or a check that should fail or stay unsure and passes. It also exits non-zero on any case it could not score: an error from the checker, a rule missing from the answer, a fixture whose head commit has moved, or a `--only` that matches nothing.

The results table is still to be added: the first full run against the fixtures is waiting on a day of Workers AI budget, which one run uses up.

## Run it locally

Needs Node 22 and a Cloudflare account. Workers AI runs on Cloudflare even in local development, so a login is required.

```bash
npm install
npx wrangler login
npm run dev
```

Then open http://localhost:5173.

## Deploy

`npm run deploy` builds the app and deploys it with Wrangler, which also creates the `cf-ai-pr-checker-check` Workflow. A push to `main` deploys automatically once the repository has the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The Worker secrets are `API_TOKEN` for the API and the MCP server and, optionally, `GITHUB_TOKEN` for a higher GitHub rate limit. The variable `AI_MODEL` switches the model and `CHECK_RUNNER=inline` runs checks inside the Durable Object instead of as Workflows.

## Known limits

- The Workers AI Free plan allows 10,000 neurons a day. A check costs roughly one to three hundred per file, so the day's budget covers a few dozen files. When it runs out, every file lands under "Not checked" with the model's error and no rule can pass; the report says so rather than guessing.
- A FAIL by absence ("every file has X" and it does not) cannot be placed on a line, so it always counts as introduced and blocks.
- At most 20 files are checked per pull request. The rest are listed under "Not checked", and a rule whose scope includes them cannot PASS.
- A rule that spans files is settled from each file's summary of itself, never from code. Its PASS is only as good as those summaries, and its FAIL is held to complete coverage and uncut summaries, so on a large pull request it tends to end as a question.
- A file checked in windows is checked for its change. A per-file "must" rule cannot pass on it, and a pre-existing failure outside the windows is not seen.
- A check is one Workflow instance. The Workers Free plan runs 100 at once and limits what one step may return, so the selected diffs are trimmed to fit and any file dropped for that is listed under "Not checked".
- An answer to a question is the author's word. The checker stores it, shows it and honours it; it does not verify it. `strict` ignores answers, and the `verified` status check stays red on a pass by attestation.
- GitHub allows 60 unauthenticated API requests an hour. A `GITHUB_TOKEN` Worker secret lifts that.
- The model is small and sometimes wrong. The guards make a wrong answer land in Questions rather than as a confident PASS; they do not make it right.

## Prompts

AI-assisted coding was used. The prompts are in [PROMPTS.md](PROMPTS.md).

Built from Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter) template (MIT).
