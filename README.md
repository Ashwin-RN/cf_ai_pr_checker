# cf_ai_pr_checker

A chat app on Cloudflare that checks a GitHub pull request against a set of rules.

You give it your rules once.
You paste a public pull request link.
It fetches the diff and returns pass or fail for each rule, quoting the diff line that decides it.
It remembers your rules and every past check.

**Status:** chat shell only. The checker is not built yet.

## How it meets the assignment

| Required component      | How this app does it                                                                                                                                              | Where in the code |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| LLM                     | Llama 3.3 on Workers AI                                                                                                                                           | `src/server.ts`   |
| Workflow / coordination | One Durable Object per workspace runs the sequence: fetch the PR, check each file in parallel, merge. Step 3 moves the per-file checks into a Cloudflare Workflow | `src/server.ts`   |
| User input via chat     | Chat UI served by the Worker                                                                                                                                      | `src/app.tsx`     |
| Memory or state         | Rules and past checks stored in the Durable Object's SQLite storage                                                                                               | _to fill in_      |

## Design (planned, not built yet)

**Step 1: the rules check**

- You give it rules in plain English. It stores them.
- You paste a public GitHub pull request link.
- It returns PASS, FAIL or UNSURE per rule. UNSURE means the rule needs code the PR does not show.
- Every verdict quotes the line that decides it. Code checks that each quote really is in the diff. A quote that is not there makes the verdict "unverified".
- Rules and past checks are stored in the Durable Object.

**Step 2: the wide check**

- It fetches the full content of each changed file, not just the changed lines.
- One model call per file, run in parallel. Each returns rule verdicts, facts ("adds route `/login`") and considerations.
- Code merges verdicts: any FAIL is FAIL, else any UNSURE is UNSURE, else PASS.
- One small model call reads only the per-file facts, to settle rules that span files.
- It lists at most five considerations for a reviewer, each naming a file and line. These are pointers, never verdicts.
- Files over the size cap are split by changed section. Files beyond the file cap are named as not checked.

**Step 3: Workflow**

- The per-file checks run as steps of a Cloudflare Workflow, so each one retries on its own and a failure does not lose the rest.

## Run it locally

Needs Node 22 and a Cloudflare account. Workers AI runs on Cloudflare even in local development, so a login is required.

```bash
npm install
npx wrangler login
npm run dev
```

Then open http://localhost:5173.

## Try it

_To fill in once the checker works: example rules, an example pull request link, and the expected output._

## Deploy

`npm run deploy` builds the app and deploys it with Wrangler. A push to `main` deploys automatically once the repository has the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

_To fill in: the workers.dev link._

## Known limits

- Very large diffs exceed the model's context. They are cut down, and the reply says so.
- GitHub allows 60 unauthenticated API requests an hour. A GitHub token stored as a Worker secret lifts that.

## Prompts

AI-assisted coding was used. The prompts are in [PROMPTS.md](PROMPTS.md).

Built from Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter) template (MIT).
