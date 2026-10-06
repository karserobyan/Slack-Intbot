# IntegrationsBot — Functionality Overview

_Last surveyed: 2026-05-19_

An internal Slack bot for ServiceTitan integrations support people who own the case. It answers customer-integration questions by running an always-on pipeline (Intake → Research → Resolver → optional Reply) over Slack history, Confluence, Jira, the public Knowledge Base (help.servicetitan.com), and a team-curated knowledge file. Responses are structured Block Kit messages with diagnosis, troubleshooting steps, involvement guidance, optional customer-ready text, and sourced references.

## Quick facts

- **Entry points:** `src/index.js` (Bolt app startup) + `src/handlers/mention.js` (shared query handler)
- **Model:** `claude-sonnet-4-6` (override via `ANTHROPIC_MODEL`)
- **Stack:** Node.js ESM, `@slack/bolt` v4, `@anthropic-ai/sdk`, dotenv
- **Search sources:** Confluence REST, Jira REST, Slack MCP (optional), Anthropic `web_search` scoped to `help.servicetitan.com` (KB), local `data/knowledge.md`
- **In scope:** Zapier, Angi, Reserve with Google, ServiceChannel, Thumbtack, Procore, Chat-to-Text, generic webhooks/API
- **Out of scope:** All accounting integrations (QuickBooks, Sage Intacct, NetSuite, Xero, Viewpoint Vista) — auto-redirected

---

## 1. Query entry points

### Mention handler — channel mentions
- **Trigger:** Agent types `@IntegrationsBot <question>` in a channel
- **Files:** `src/handlers/mention.js` (event registration) → `handleQuery()`
- **External services:** None at entry; downstream calls happen inside `handleQuery`
- **State:** Adds to per-thread conversation history (4hr TTL, max 20 messages)

### DM handler — direct messages
- **Trigger:** Agent DMs the bot or replies in a DM thread
- **Files:** `src/handlers/dm.js`
- **Slack interactions handled here:**
  - `app_home_opened` → welcome card
  - `new_chat` button → fresh session card
  - `start_chat_thread` button → seeded thread prompt
- **Top-level messages** start a new conversation; thread replies are follow-ups. Both call the shared `handleQuery()`.

Both entry points funnel into the shared query flow (see §13).

---

## 2. Fast-path features (no Claude call)

### Accounting integration redirect
- **What it does:** Detects accounting topics and points agents to `#ask-partner-enabled-accounting-integrations` without calling Claude
- **Trigger:** Query matches the keyword regex (QuickBooks, NetSuite, Xero, "accounts payable", "GL accounts", etc.)
- **How:** Keyword check via `isAccountingTopic(query)` before the pipeline runs
- **Files:** `src/utils/accounting-filter.js`, `src/slack/blocks.js:buildAccountingRedirectBlocks()`
- **State:** None

### Rate limiting
- **What it does:** Caps each user at 5 queries / 60s; posts a brief "slow down" message if exceeded
- **Files:** `src/utils/rate-limiter.js` (in-memory per-user tracker, cleaned up every 5min)
- **Env tuning:** `RATE_LIMIT_MAX` (default 5), `RATE_LIMIT_WINDOW_MS` (default 60000)

### Empty query & help
- **Empty query:** Bot posts a greeting with example questions (channel only; silent in DMs)
- **`help` command:** Posts a help card (ephemeral in channels, visible in DMs). One audience — no CSA vs Specialist split.
- **Files:** `src/handlers/mention.js`, `src/slack/blocks.js:buildHelpBlocks()`

---

## 3. Response caching

### In-memory LRU cache
- **What it does:** Stores Claude responses keyed by normalized query (lowercased, whitespace-collapsed). Identical queries within the TTL return instantly without calling Claude
- **TTL:** 1 hour (`CACHE_TTL_MS`)
- **Max entries:** 50; oldest evicted on overflow
- **Files:** `src/slack/cache.js`, lookup in `src/handlers/mention.js`
- **Invalidation:** Cleared when feedback corrections are approved (so stale answers don't replay)

---

## 4. Conversation history & follow-ups

### Thread-level conversation memory
- **What it does:** Tracks up to 20 messages per thread so agents can ask diagnostic follow-ups without repeating context
- **TTL:** 4 hours; resets on each append
- **Files:** `src/slack/conversation.js` (store), `src/handlers/mention.js` (follow-up branch)
- **Behavior:** Follow-ups re-enter `runPipeline` with thread history (`allowClarify=false` so the bot answers best-effort instead of re-asking).

### Streaming progress display
- **What it does:** Updates the "Checking…" placeholder with rolling status: which pipeline stage is running, result counts, "Now: writing answer…" when Resolver/Reply start emitting
- **Files:** `src/slack/blocks.js:buildProgressBlocks()`, progress emission in `src/claude/pipeline.js`
- **External:** Multiple `chat.update` calls (rate-limited to ~1s cadence)

---

## 5. Question understanding & source selection

### Pipeline Research stage
- **What it does:** Intake builds a search plan; Research runs each source in parallel, then an evaluator may refine the plan once
- **Sources:**
  - **KB (Anthropic `web_search`, scoped to `help.servicetitan.com`)** — `src/claude/kb-search.js`
  - **Confluence (REST)** — `src/claude/atlassian-search.js`
  - **Jira (REST)** — `src/claude/atlassian-search.js`
  - **Team knowledge** — `data/knowledge.md` via `src/slack/knowledge.js` (5-min cache)
  - **Slack** — via search executor / optional Slack MCP (`SLACK_USER_TOKEN`)
- **How they're combined:** Gathered results plus team knowledge and past corrections are passed into Resolver (and Reply when a customer was mentioned)
- **External services:** Anthropic API (Claude + `web_search` for KB), Confluence REST, Jira REST, Slack search/MCP

### One audience
- No CSA vs Specialist prompt split. Everyone who owns the case gets the same Resolver card.
- Involvement (when needed) points to engineering (`#ask-integrations`), a partner, or leads (`#ask-leads-integration`) — not an Integrations Specialist.

---

## 6. Full-response Claude pipeline

### `runPipeline()` — the live inference path
- **Files:** `src/claude/pipeline.js`
- **Stages:**
  1. **Intake (Interpreter)** — understand the question; may emit a clarifying question
  2. **Research** — execute search plan; evaluator may refine once
  3. **Resolver** (`runResolver` in `answerer.js`) — diagnosis, steps, involvement, refs
  4. **Reply** (`runReply` in `answerer.js`) — only when Intake set `entities.customer_mentioned`; adds `customer_message`
- **Hard cap:** 60s for the whole pipeline
- **Per-call timeout:** `CLAUDE_TIMEOUT_MS` (default 90s) still applies to individual Anthropic calls within the cap

### Response JSON schema (Resolver + optional Reply)

```json
{
  "issue_title": "string",
  "integration_type": "Zapier | Angi | RwG | ServiceChannel | Thumbtack | Procore | Chat-to-Text | General",
  "confidence": "high | medium | low",
  "diagnosis": "string (one sentence)",
  "steps": [
    { "num": 1, "title": "string", "detail": "string", "tag": "action|backend|verify|escalate" }
  ],
  "involvement": {
    "needed": false,
    "who": null,
    "reason": "string",
    "channel": null
  },
  "slack_refs":     [ { "url": "...", "channel": "...", "title": "..." } ],
  "atlassian_refs": [ { "type": "confluence|jira", "url": "...", "title": "..." } ],
  "kb_refs":        [ { "url": "...", "title": "...", "snippet": "..." } ],
  "sources_used": ["slack","confluence","jira","kb"],
  "customer_message": "string, paste-ready — only when a customer was mentioned"
}
```

When Intake confidence is low and clarification is still allowed, the pipeline returns:

```json
{ "clarifying_question": "yes/no question for the agent" }
```

Accounting is a keyword gate before the pipeline (`isAccountingTopic`); it is not a model field.

---

## 7. Response rendering & user interaction

### Block Kit response builder
- **Files:** `src/slack/blocks.js:buildResponseBlocks()`
- **Pieces of the response card:**
  1. Header with issue title and confidence icon
  2. Research summary: diagnosis, then Slack, Confluence, Jira, and KB sources as links when the host is allowlisted
  3. Color-coded steps (blue=action, orange=backend, green=verify, red=escalate). A thread follow-up labels these "Still open"
  4. Involvement (who / channel / reason) when another team is needed
  5. Action buttons: **Wrong Answer**, **Diagnosis + Sources** when refs exist, **New chat** in DMs
  7. Nomination suggestion if the response qualifies for the knowledge base

### Wrong-answer feedback flow
- **Trigger:** Click "Wrong Answer" → modal opens
- **Flow:**
  1. Modal collects feedback type (wrong_answer / partially_correct / outdated / wrong_integration) + correction text
  2. Saved to `data/feedback-pending.json`
  3. Review card posted to `FEEDBACK_REVIEW_CHANNEL_ID` with Approve / Reject buttons
  4. **Approve** → moves to `data/feedback.json`, DMs the agent, **invalidates the response cache**, future similar queries inject the correction
  5. **Reject** → record deleted, agent DM'd
- **Files:** `src/slack/feedback.js`, `src/slack/blocks.js:buildFeedbackModal()`, `src/index.js`, injection in `src/handlers/mention.js`
- **Caps:** 500 active / 200 pending

### Knowledge nomination system
- **Trigger:** Bot self-nominates a response if it meets criteria (has refs, no escalation, has steps, took >30s, not a clarifying question)
- **Flow:**
  1. `handleQuery` posts a nomination card to the feedback review channel
  2. **Approve** → `appendBotResponse()` writes to `data/knowledge.md` under the integration section; knowledge cache cleared
  3. **Reject** → discarded
- **Files:** `src/slack/nominations.js`, `src/slack/knowledge-writer.js`, handlers in `src/index.js`
- **Steward:** Wrong-answer corrections and knowledge.md nominations stay human-approved.

---

## 8. Knowledge base management

### Team knowledge file (`data/knowledge.md`)
- **What it is:** A Markdown file organized by integration, containing high-value fixes accumulated over time
- **Format:**
  ```
  ## Zapier
  - [kb, 2026-05-19] Title — https://url — snippet
  - [auto, 2026-05-19] Issue title: step1; step2. Confirmed in Slack + Confluence.
  ```
- **Cache:** Loaded on startup, refreshed every 5 minutes (warns if file >20KB)
- **Files:** `src/slack/knowledge.js` (loader), `src/slack/knowledge-writer.js` (append with dedupe)
- **Writes are serialized** via a Promise queue so concurrent writes don't race

### KB auto-save
- **What it does:** When Research returns `help.servicetitan.com` articles, the bot appends them to `knowledge.md` if not already present (dedupe by URL)
- **Trigger:** Automatic at end of `runPipeline`
- **Files:** `src/slack/knowledge-writer.js:appendKbArticle()`, hook in `src/claude/pipeline.js`

---

## 9. Health & monitoring

### Health-check endpoint
- **What:** `GET /health` (HTTP mode only) returns uptime, cache stats, source availability
- **Files:** `src/index.js`

### Periodic pruning
- **What:** Every 15 minutes — remove expired cache entries and expired thread histories
- **Files:** `src/index.js`, `src/slack/cache.js:pruneExpired()`, `src/slack/conversation.js:pruneConversations()`

### Startup validation
- Required env vars present (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`)
- Feedback review channel configured and bot is a member
- Slack MCP and Atlassian REST credentials check
- Re-posts any pending feedback entries that got stuck across a restart

### Answer Evidence quality shadow layer
- **What:** Optional shadow-mode metadata layer that maps current answers and refs into an internal evidence contract.
- **Default:** Disabled unless `QUALITY_LAYER_ENABLED=true`.
- **Safety:** Fail-open. If metadata recording fails, the Slack answer and existing nomination behavior continue unchanged.
- **Storage:** Sanitized bounded JSONL under `data/quality-shadow.jsonl`; no full raw snippets, secrets, PII, or large customer payloads.
- **Current limitation:** PR 1 evidence mappings are approximate; long-term answerer output may emit explicit evidence IDs.

---

## 10. CLI simulator & tests

### `cli.js`
- **What:** Interactive REPL for testing without Slack. Calls `runPipeline({ rawQuery })`, prints color-coded diagnosis, steps, involvement, and optional customer message
- **Commands:** plain text (submit query), `/wrong` (file feedback), `/feedback` (list recent), `quit`
- **Run:** `ANTHROPIC_API_KEY=... node cli.js`

### `test.js`
- **What:** Plain `assert()` test suite, no framework. Assertions across cache, conversation, feedback, knowledge writer, accounting filter, parsers, all Block Kit builders, modals, progress blocks
- **Run:** `node test.js` — must pass 0 failures before any PR
- **Convention from `CLAUDE.md`:** All tests must pass before a PR is opened

---

## 11. Data persistence

### `data/feedback.json` + `data/feedback-pending.json`
- **Schema:** Array of `{ id, timestamp, query, issueTitle, integrationType, feedbackType, correction, agentId, agentName, reviewMessageTs, reviewChannelId }`
- **Caps:** 500 active / 200 pending — oldest silently dropped on overflow
- **Writes:** Serialized via Promise chain
- **Read-cache:** Both files held in memory; updates reflected immediately

### `data/knowledge.md`
- **Format:** Markdown sections per integration; entries tagged `[kb|auto, YYYY-MM-DD]`
- **Reads:** 5-min memory cache
- **Writes:** Dedupe + serialized; Slack notification sent on every write success/failure

All three live in `data/` and are **gitignored**.

---

## 12. Environment variables

### Required
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`

### Recommended
- `SLACK_USER_TOKEN` — enables Slack MCP search (else Research has no live Slack tool)
- `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` — Confluence + Jira REST (Basic Auth)
- `FEEDBACK_REVIEW_CHANNEL_ID` — moderation queue channel

### Optional
- `SLACK_APP_TOKEN` — Socket Mode for local dev (blank → HTTP mode)
- `ATLASSIAN_BASE_URL` — override default `servicetitan.atlassian.net`
- `ANTHROPIC_MODEL`, `CLAUDE_TIMEOUT_MS`, `CACHE_TTL_MS`, `CACHE_MIN_MS`, `CONVERSATION_TTL_MS`, `KNOWLEDGE_MIN_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `PORT`, `LOG_LEVEL`

---

## 13. The query flow

When a `@mention` or DM arrives, both entry points call `handleQuery()` in `src/handlers/mention.js`. The flow is deterministic and early-exits at the first fast path:

1. Strip `<@U…>` bot mention from text
2. Empty query → greeting + return
3. Rate limit check (5/min/user) → "slow down" + return if exceeded
4. Accounting keyword check → fast redirect + return
5. `help` command → help card + return
6. Cache hit → return cached
7. Post "Checking…" placeholder
8. **`runPipeline({ rawQuery })`** — Intake → Research (search + evaluator, one refine) → Resolver → Reply only when `entities.customer_mentioned` (60s hard cap)
9. Attach metadata, conditionally cache
10. Clarifying-question early-return (if Intake couldn't answer confidently)
11. Deliver final response card
12. Seed conversation history (for follow-ups)
13. Nominate response for the knowledge base if it qualifies (human-approved Steward)

Thread follow-ups re-enter the same pipeline with history and `allowClarify=false`.

---

## 14. Data flow at a glance

```
User query
   │
   ▼
[Fast paths: empty / help / accounting / rate limit] ── early exit
   │
   ▼
Cache hit? ── serve cached, return
   │
   ▼
runPipeline (60s hard cap):
   ├─ Intake (Interpreter) — search plan / clarifying question
   ├─ Research — parallel search + evaluator (one refine)
   ├─ Resolver — diagnosis, steps, involvement, refs
   └─ Reply — customer_message only if customer_mentioned
   │
   ▼
Render Block Kit response
   ├─ Header + confidence
   ├─ Diagnosis
   ├─ Color-coded steps
   ├─ Involvement (who / channel / reason)
   ├─ Source chips
   └─ Buttons: Wrong Answer, Sources, Copy Message
   │
   ▼
Post to Slack → seed thread history → nominate to KB if eligible
```

---

## 15. MCP architecture

- **Slack MCP:** Optional. With `SLACK_USER_TOKEN` set, Slack search tools are available to the Research stage search executor
- **Atlassian:** REST Basic Auth (migrated from MCP in PR #11). Confluence + Jira are searched directly via REST in `src/claude/atlassian-search.js`
- **KB:** Anthropic `web_search_20250305` scoped to `help.servicetitan.com` (see `src/claude/kb-search.js`). No MCP, no separate API key

---

## Summary in one paragraph

IntegrationsBot is a Slack-native, Node ESM, single-process bot for integrations support people who own the case. Channel mentions and DMs converge on a shared handler that walks fast paths (empty / help / accounting keyword redirect / rate limit / cache) before running the always-on pipeline: Intake → Research (search + evaluator, one refine) → Resolver → Reply only when a customer was mentioned, under a 60s hard cap. The response is a Block Kit card with diagnosis, color-coded steps, involvement (engineering / partner / leads), optional customer message, source chips, and Steward actions (Wrong Answer, knowledge nominations — human-approved). There is no NEW_PIPELINE flag and no legacy single-call path.
