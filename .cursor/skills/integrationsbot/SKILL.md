---
name: integrationsbot
description: Use when changing IntegrationsBot (this Slack bot), its pipeline, answer schema, Block Kit cards, prompts, search, feedback, or tests. Read before editing src/, test.js, or docs that describe the bot.
---

# IntegrationsBot

Internal Slack bot for ServiceTitan integrations support people who own the case. One audience. There is no CSA mode and no Specialist mode.

## Standing plan

Memorized 2026-10-02. Full writeup: `docs/superpowers/plans/2026-10-02-no-channel-posts.md`.

The bot answers in the thread or DM where someone asked. It does not post into any other channel. It names the channel that should receive the issue, or a few suggestions when no single channel owns it. A person posts there.

Do not add a button or action that calls `chat.postMessage` into a destination channel or back into a source thread. There is no Send handoff button and no Post to thread button.

Channel choice stays. Haiku reads the issue against `conversations.list`. One clear listed channel is `channel`, with `suggestions` empty. When several listed channels could receive it, `channel` is null and `suggestions` holds up to 3 of them. Unlisted names are dropped. A failed choice or no fit means both are empty. Channel names are not hardcoded.

Follow-ups pass `[PRIOR CASE]` and must not repeat steps already given. In the thread, the placeholder says it is checking the follow-up, and the card continues that case. It does not open like a new investigation.

Accounting stays a keyword redirect in the asking thread. The bot does not post into that channel.

Auto-answer may still post a private draft into `AUTO_ANSWER_TARGET_CHANNEL`. It must not post into the original thread.

Parked, and not to be started unless the user asks again: audit logs, CSA or Specialist roles, step-level source lines. If Reply fails and the 60s cap has not fired, return the Resolver answer with no customer draft. If the cap has fired, the request still fails.

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
3. **Resolver** — `runResolver`. Diagnosis, steps, confidence, involvement. It sets `channel` to null.
4. **Handoff channel** — one Haiku call (`claude-haiku-4-5-20251001`, 15s, `maxRetries: 0`) reads the issue against every channel `conversations.list` returned. It may name one listed channel, or up to 3 suggestions when no single channel owns the issue. A throw leaves both empty and does not fail the request. The call shares the pipeline abort signal. It runs only when involvement is needed and the channel list is non-empty.
5. **Reply** — `runReply` only when `customerWasMentioned(interpreterResult)` is true (`entities.customer_mentioned === true`). Reply emits `customer_message` only, and only from facts Resolver and Research already produced. If Reply fails and the 60s cap has not fired, return the Resolver answer with no customer draft. If the cap has fired, the request still fails.

Hard cap is 60 seconds (`HARD_CAP_MS`). One `AbortController` covers the whole run. Each model call uses `AbortSignal.any` with its own timeout. Anthropic clients set `maxRetries: 0`. Resolver may retry once on a transient error if the pipeline signal is still live. Follow-ups pass `allowClarify: false`. If that capped Resolver is missing `issue_title` or `steps`, coerce to issue title `Not enough detail to resolve`, confidence `low`, one escalate step, and involvement engineering. Channel stays null unless the handoff choice names a listed channel.

Models already chosen:

- Interpreter, evaluator, handoff channel, KB web search: `claude-haiku-4-5-20251001`
- Resolver and Reply: `process.env.ANTHROPIC_MODEL` or `claude-sonnet-4-6`

Do not switch these to Opus, adaptive thinking, or streaming unless the task says so. Do not add SDK retries. KB search calls the Messages API with `web_search_20250305` scoped to `help.servicetitan.com`; leave that tool type unless a task is specifically about KB search.

Accounting is `isAccountingTopic` in `src/utils/accounting-filter.js`, before any model call. Redirect channel is `#ask-partner-enabled-accounting-integrations`.

## Answer contract

`src/claude/answer-schema.js` is the field list. Import it. Do not invent names.

Resolver fields: `issue_title`, `integration_type`, `confidence` (`high`|`medium`|`low`), `diagnosis`, `steps` (`num`, `title`, `detail`, `tag` of `action`|`backend`|`verify`|`escalate`), `involvement` (`needed`, `who`, `reason`, `channel`), `slack_refs`, `atlassian_refs`, `kb_refs`, `sources_used`.

`involvement.needed === false` means `who` and `channel` are null. `needed === true` means `who` is `engineering`, `partner`, or `leads`. `channel` is not stored. After the Resolver, Haiku reads the issue and the live channel list. One clear listed channel is `channel`. When no single channel owns the issue, `suggestions` holds up to 3 listed channels and `channel` is null. The card shows the name, or "Could go to" those suggestions. The bot does not post it. Resolver sets `channel` to null. Follow-ups pass `[PRIOR CASE]` into the Resolver and must not repeat steps already given.

Reply field: `customer_message` only. Resolver must not emit it. The pipeline attaches it after Reply.

Retired, and tests fail if present: `role`, `escalate_decision`, `channel_recommendation`, `agent_steps`, `findings_summary`, `suggested_channel_post`, `intro_message`.

Not model output: `customer_message` on the Resolver, `is_accounting_topic`, `clarifying_question`. Clarifying stays on Intake.

`src/claude/query.js` and `NEW_PIPELINE` are gone. Do not restore them.

## Slack card

`buildResponseBlocks(data, { isDm = false, followUp = false })` in `src/slack/blocks.js`. Order: header, research summary, steps (cap 20), involvement, actions. The research summary is the diagnosis plus Slack, Confluence, Jira, and KB sources as `safeSlackLink` hyperlinks when the host is allowlisted. The answer card and the auto-answer review card do not render `customer_message` or word-only source chips. Both lead with the research summary. Search hits are attached when the Resolver leaves that ref list empty. A follow-up adds `_Continuing this thread_`, labels steps `*Still open*`, and uses the placeholder `Checking your follow-up…`. Actions: Wrong Answer, Diagnosis + Sources when any refs exist, New chat in DMs. No button posts into another channel. No Show Specialist Detail. No role filter on sources. `filterRefsForRole` does not exist.

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

## Parked

Audit logs are parked. Do not build them unless the user asks again.

`docs/superpowers/specs/2026-04-23-kibana-audit-log-design.md` is the old writeup. It is not the plan. It puts a routing button in front of every new mention and calls `query.js`, which is gone. If this is resumed, Intake gets an `audit` intent, that path calls Elasticsearch MCP, and troubleshooting stays on Resolver and Reply. Reserved env names, unread by the bot: `ES_MCP_URL` (`https://es-aux-mcp.st.dev/mcp`) and `ES_MCP_TOKEN` (unset).

## Style

No comments unless the WHY is non-obvious. No error handling for cases that cannot happen. No CommonJS.
