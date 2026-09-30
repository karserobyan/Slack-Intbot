---
name: integrationsbot
description: Use when changing IntegrationsBot (this Slack bot), its pipeline, answer schema, Block Kit cards, prompts, search, feedback, or tests. Read before editing src/, test.js, or docs that describe the bot.
---

# IntegrationsBot

Internal Slack bot for ServiceTitan integrations support people who own the case. One audience. There is no CSA mode and no Specialist mode.

## Runtime

Node.js ESM (`import` / `export`). Entry `src/index.js`. Tests are plain `assert` in `test.js`.

```bash
node test.js
```

Zero failures before a PR. `npm test` is the same command.

## Pipeline

`runPipeline({ rawQuery, threadHistory, onProgress, allowClarify })` in `src/claude/pipeline.js`. No `role` argument.

1. **Intake** — `runInterpreter` (Haiku). May return a clarifying question only when `allowClarify` is true and `question_confidence` is `low`.
2. **Research** — `executeSearchPlan`, then `runEvaluator`. At most one refined search.
3. **Resolver** — `runResolver`. Diagnosis, steps, confidence, involvement.
4. **Reply** — `runReply` only when `customerWasMentioned(interpreterResult)` is true (`entities.customer_mentioned === true`). Reply emits `customer_message` only, and only from facts Resolver and Research already produced. A Reply throw fails the request.

Hard cap is 60 seconds (`HARD_CAP_MS`). One `AbortController` covers the whole run. Each model call uses `AbortSignal.any` with its own timeout. Anthropic clients set `maxRetries: 0`. Resolver may retry once on a transient error if the pipeline signal is still live. Follow-ups pass `allowClarify: false`. If that capped Resolver is missing `issue_title` or `steps`, coerce to issue title `Not enough detail to resolve`, confidence `low`, one escalate step, involvement engineering / `#ask-integrations`.

Models already chosen:

- Interpreter, evaluator, KB web search: `claude-haiku-4-5-20251001`
- Resolver and Reply: `process.env.ANTHROPIC_MODEL` or `claude-sonnet-4-6`

Do not switch these to Opus, adaptive thinking, or streaming unless the task says so. Do not add SDK retries. KB search calls the Messages API with `web_search_20250305` scoped to `help.servicetitan.com`; leave that tool type unless a task is specifically about KB search.

Accounting is `isAccountingTopic` in `src/utils/accounting-filter.js`, before any model call. Redirect channel is `#ask-partner-enabled-accounting-integrations`.

## Answer contract

`src/claude/answer-schema.js` is the field list. Import it. Do not invent names.

Resolver fields: `issue_title`, `integration_type`, `confidence` (`high`|`medium`|`low`), `diagnosis`, `steps` (`num`, `title`, `detail`, `tag` of `action`|`backend`|`verify`|`escalate`), `involvement` (`needed`, `who`, `reason`, `channel`), `slack_refs`, `atlassian_refs`, `kb_refs`, `sources_used`.

`involvement.needed === false` means `who` and `channel` are null. `needed === true` means `who` is `engineering`, `partner`, or `leads`. Engineering channel is `#ask-integrations`. Leads channel is `#ask-leads-integration`. Partner uses a partner channel.

Reply field: `customer_message` only. Resolver must not emit it. The pipeline attaches it after Reply.

Retired, and tests fail if present: `role`, `escalate_decision`, `channel_recommendation`, `agent_steps`, `findings_summary`, `suggested_channel_post`, `intro_message`.

Not model output: `customer_message` on the Resolver, `is_accounting_topic`, `clarifying_question`. Clarifying stays on Intake.

`src/claude/query.js` and `NEW_PIPELINE` are gone. Do not restore them.

## Slack card

`buildResponseBlocks(data, { isDm = false })` in `src/slack/blocks.js`. Order: header, diagnosis, steps (cap 20), involvement, customer draft when `customer_message` is non-empty, source chips, actions. Actions: Wrong Answer, Diagnosis + Sources when any refs exist, Channel post when `involvement.needed`, New chat in DMs. No Show Specialist Detail. No role filter on sources. `filterRefsForRole` does not exist.

Escape user and model text with `escapeMrkdwn`. Stay well under Slack's 50-block limit. Button values stay small.

Mention handler is `src/handlers/mention.js`. It does not read Slack titles or detect a role. Help is `buildHelpBlocks` for everyone. Steward (wrong answer and `knowledge.md`) stays human-approved.

There is one audience. Quality shadow records do not store a role. Sources that used to be marked `specialist_only` are `internal`: they still show on the card, and they do not become customer-facing knowledge by themselves. Old shadow rows that still say `specialist_only` are read as `internal`.

## Where to edit

| Change | File |
|---|---|
| Field names | `src/claude/answer-schema.js` first, then every consumer |
| Resolver / Reply prompts | `src/claude/prompts/resolver.js`, `src/claude/prompts/reply.js` |
| Model calls for those stages | `src/claude/answerer.js` |
| Stage order, cap, Reply gate | `src/claude/pipeline.js` |
| Channel / DM delivery | `src/handlers/mention.js`, `src/handlers/dm.js` |
| Cards | `src/slack/blocks.js` |
| Assertions | `test.js`, `test/fixtures/` |

A new answer field lands in the schema, the prompt, the pipeline, the card, and tests in the same change. A new stage shares the pipeline abort signal and the 60s cap.

## Style

No comments unless the WHY is non-obvious. No error handling for cases that cannot happen. No CommonJS.
