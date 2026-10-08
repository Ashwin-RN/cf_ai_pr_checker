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
