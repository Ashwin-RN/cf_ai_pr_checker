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
