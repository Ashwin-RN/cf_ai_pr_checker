# cf_ai_pr_checker

A pull request checker on Cloudflare, written for the agent that wrote the code.

You give it rules in plain English.
You give it a public GitHub pull request link.
It checks every changed file against every rule with a small model, verifies each quoted line in code, and returns a report with a fixed shape: what blocks, what needs an answer, what to watch, and the steps that resolve each item.
The reader can be a person or the coding agent that opened the pull request. It never edits code.

**Status:** the check works on the changed lines of each file, in the chat and over an HTTP API. Full-file context, a run-to-run diff of findings, the Workflow and an MCP server come next.

## How it meets the assignment

| Required component      | How this app does it                                                                                                                                                                                        | Where in the code                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| LLM                     | Llama 3.3 on Workers AI. One JSON Mode call per changed file at temperature 0, one call to interpret the rules, and one second look at each FAIL                                                            | `src/checker/model.ts`, `src/checker/prompts.ts` |
| Workflow / coordination | One Durable Object per workspace runs the sequence: fetch the pull request, select files, check them in parallel, verify quotes, merge, render. Step 3 moves the per-file checks into a Cloudflare Workflow | `src/checker/index.ts`, `src/server.ts`          |
| User input via chat     | Chat UI served by the Worker, with a progress card per check. The same engine sits behind `POST /api/check`                                                                                                 | `src/app.tsx`, `src/server.ts`                   |
| Memory or state         | Rules, checks and per-file results in the Durable Object's SQLite storage                                                                                                                                   | `src/store.ts`                                   |

## How a check runs

1. **Rules.** A message starting with `rules:` saves one rule per line. One model call reads each rule as "must" or "must not", one file or many, and a directory scope. The scope is kept only when the rule itself names that directory, so a bad guess cannot hide files from a rule. The reply shows the interpretation.
2. **Fetch.** The pull request and its changed files come from the GitHub API. Lockfiles, minified, vendored and binary files are skipped and listed. Source files come first, then tests, then config and docs. At most 20 files are checked and the rest are named.
3. **Check.** Each file's changed sections go to the model with the rules that apply to its path. The model returns, per rule, PASS, FAIL, UNSURE or NA with a quote, a reason, why the rule matters, steps for the author, what resolves it, and a question for UNSURE. It also returns facts about the change and up to three warnings.
4. **Verify.** A verdict that says something is present must quote a line that is in the diff. A quote that is missing, or that matches a line the pull request removes, turns the verdict into a question. Every verified FAIL gets a second call that sees only the quoted line and its neighbours; if that call disagrees, the FAIL becomes a question too. Steps that name a file the checker never saw are marked.
5. **Merge and render.** Per rule: any verified FAIL is FAIL; otherwise any unverified FAIL or UNSURE is UNSURE; otherwise PASS when every file was checked, and UNSURE when some were not. Code renders the report. The model never writes it.

## The report

Six sections, always in this order, with "none" when empty: Status, Blocking, Questions, Warnings, Not checked, Intent. Blocking items are `F1, F2, ...`, questions `Q1, ...`, warnings `W1, ...`. Each carries a key that stays the same across runs of the same pull request, so a re-check after a push can be compared with the last one.

A question from a real run against this repository's pull request #1:

```markdown
### Q2 · rule 2 · src/checker/github.ts · key b3621a84

**Question:** Is there a matching test file under test/ for the function exported by this file?

**Reason:** The file exports a function but does not contain a test.

**Why:** To ensure the function is properly tested and validated.

**Steps:**

1. Check if the file exports a function
2. Look for a matching test file under test/
3. Verify the test file covers the function
4. Confirm the test file is in the correct location

**Resolved when:** A test file for this function is added under test/
```

Over the API the report also ends with a JSON block that mirrors it: `schema_version`, `check_id`, the rules with their status, the findings, what was not checked, and how to run the same check again.

## Try it

Send this in the chat:

```
rules:
No console.log or console.debug in files under src/
Every GitHub Actions workflow pins actions to a major version tag
No secrets, tokens or passwords are hardcoded
```

Then paste a public pull request link, for example `https://github.com/Ashwin-RN/cf_ai_pr_checker/pull/1`. The progress card fills in as files are checked and the report follows. `history` lists past checks.

## HTTP API

Set the Worker secret `API_TOKEN`; without it the API answers 503. Then:

```bash
curl -X POST https://<your-worker>/api/check \
  -H "authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prUrl":"https://github.com/owner/repo/pull/123","rules":["No console.log in src/"],"workspace":"ci"}'
```

`rules` is optional once a workspace has rules. `workspace` defaults to `api`. The response is the JSON block described above plus `report_markdown`. `GET /api/checks/<check_id>?workspace=ci` returns a stored result.

For local development, put `API_TOKEN=...` in `.dev.vars`.

## Run it locally

Needs Node 22 and a Cloudflare account. Workers AI runs on Cloudflare even in local development, so a login is required.

```bash
npm install
npx wrangler login
npm run dev
```

Then open http://localhost:5173.

## Deploy

`npm run deploy` builds the app and deploys it with Wrangler. A push to `main` deploys automatically once the repository has the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The Worker secrets are `API_TOKEN` for the API and, optionally, `GITHUB_TOKEN` for a higher GitHub rate limit.

_To fill in: the workers.dev link._

## Known limits

- Only the changed lines and a few lines around them are shown to the model, so a rule about the rest of a file comes back UNSURE with a question.
- Rules that span files, such as "every new function has a test", come back as one question per file. Settling them across files is the next step.
- At most 20 files are checked per pull request. The rest are listed under "Not checked", and no rule can PASS while coverage is incomplete.
- GitHub allows 60 unauthenticated API requests an hour. A `GITHUB_TOKEN` Worker secret lifts that.
- The model is small and sometimes wrong. The guards make a wrong answer land in Questions rather than as a confident PASS; they do not make it right.

## Prompts

AI-assisted coding was used. The prompts are in [PROMPTS.md](PROMPTS.md).

Built from Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter) template (MIT).
