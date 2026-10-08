# cf_ai_pr_checker

A chat app on Cloudflare that checks a GitHub pull request against a set of rules.

You give it your rules once.
You paste a public pull request link.
It fetches the diff and returns pass or fail for each rule, quoting the diff line that decides it.
It remembers your rules and every past check.

**Status:** base scaffold only (Cloudflare `agents-starter` template). The checker is not built yet.

## How it meets the assignment

| Required component | How this app does it | Where in the code |
|---|---|---|
| LLM | Llama 3.3 on Workers AI | _to fill in_ |
| Workflow / coordination | One Durable Object per chat runs the fixed sequence: fetch diff, check rules, reply | _to fill in_ |
| User input via chat | Chat UI served by the Worker | `src/app.tsx` |
| Memory or state | Rules and past checks stored in the Durable Object's SQLite storage | _to fill in_ |

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

## Deployed

_To fill in: the workers.dev link._

## Known limits

- Very large diffs exceed the model's context. They are cut down, and the reply says so.
- GitHub allows 60 unauthenticated API requests an hour. A GitHub token stored as a Worker secret lifts that.

## Prompts

AI-assisted coding was used. The prompts are in [PROMPTS.md](PROMPTS.md).

Built from Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter) template (MIT).
