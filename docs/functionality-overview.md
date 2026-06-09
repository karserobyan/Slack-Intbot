# IntegrationsBot — Functionality Overview

_Last surveyed: 2026-05-19_

An internal Slack bot for ServiceTitan integrations support agents. It answers customer-integration questions by searching and synthesizing knowledge from Slack history, Confluence, Jira, the public Knowledge Base (help.servicetitan.com), and a team-curated knowledge file. Responses are structured Block Kit messages with escalation signals, troubleshooting steps, customer-ready text, and sourced references.

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
- **Files:** `src/handlers/mention.js:439-459` (event registration) → `handleQuery()` at `src/handlers/mention.js:49`
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

Both entry points funnel into a deterministic **16-step flow** (see §13).

---

## 2. Fast-path features (no Claude call)

### Accounting integration redirect
- **What it does:** Detects accounting topics and points agents to `#ask-partner-enabled-accounting-integrations` without calling Claude
- **Trigger:** Query matches the keyword regex (QuickBooks, NetSuite, Xero, "accounts payable", "GL accounts", etc.)
- **How:** Step 3 calls `isAccountingTopic(query)`; step 12 double-checks Claude's response for `is_accounting_topic: true` as a safety net
- **Files:** `src/utils/accounting-filter.js`, `src/slack/blocks.js:buildAccountingRedirectBlocks()`
- **State:** None

### Rate limiting
- **What it does:** Caps each user at 5 queries / 60s; posts a brief "slow down" message if exceeded
- **Files:** `src/utils/rate-limiter.js` (in-memory per-user tracker, cleaned up every 5min)
- **Env tuning:** `RATE_LIMIT_MAX` (default 5), `RATE_LIMIT_WINDOW_MS` (default 60000)

### Empty query & help
- **Empty query:** Bot posts a greeting with example questions (channel only; silent in DMs)
- **`help` command:** CSAs get a short help card; Specialists get an extended reference (ephemeral in channels, visible in DMs)
- **Role detection:** Reads Slack profile title; "Specialist" + "Integrat" → specialist, else CSA
- **Files:** `src/handlers/mention.js:52-115`, `src/slack/blocks.js:buildHelpBlocks()`, `buildHelpDetailBlocks()`

---

## 3. Response caching

### In-memory LRU cache
- **What it does:** Stores Claude responses keyed by normalized query (lowercased, whitespace-collapsed). Identical queries within the TTL return instantly without calling Claude
- **TTL:** 1 hour (`CACHE_TTL_MS`)
- **Max entries:** 50; oldest evicted on overflow
- **Files:** `src/slack/cache.js`, lookup at `src/handlers/mention.js:215`
- **Invalidation:** Cleared when feedback corrections are approved (so stale answers don't replay)

---

## 4. Conversation history & follow-ups

### Thread-level conversation memory
- **What it does:** Tracks up to 20 messages per thread so agents can ask diagnostic follow-ups without repeating context
- **TTL:** 4 hours; resets on each append
- **Files:** `src/slack/conversation.js` (store), `src/handlers/mention.js:118-212` (follow-up branch), `src/claude/query.js:182-249` (`queryChat`)
- **Behavior switch:** When `hasHistory(threadTs)` is true, the handler routes to `queryChat()` (state-machine: `diagnosing` or `resolved`) instead of the full `queryWithContext()`. This is how multi-turn diagnostics work — bot asks "Is API access enabled?", agent says "No", bot follows up.

### Streaming progress display
- **What it does:** Updates the "Checking…" placeholder with rolling status: which sources are searching, result counts, "Now: writing answer…" when Claude starts emitting
- **Files:** `src/slack/blocks.js:buildProgressBlocks()`, progress emission in `src/claude/query.js`
- **External:** Multiple `chat.update` calls (rate-limited to ~1s cadence)

---

## 5. Question understanding & source selection

### Multi-source knowledge fetch
- **What it does:** Pre-fetches three sources in parallel before the Claude call, then optionally lets Claude search Slack live during inference via MCP
- **Sources:**
  - **KB (Anthropic `web_search`, scoped to `help.servicetitan.com`)** — `src/claude/kb-search.js`, 15s timeout
  - **Confluence (REST)** — `src/claude/atlassian-search.js`, text-search, limit 5, 8s timeout
  - **Jira (REST)** — `src/claude/atlassian-search.js`, JQL search, limit 5, 8s timeout
  - **Team knowledge** — `data/knowledge.md` via `src/slack/knowledge.js` (5-min cache)
  - **Slack MCP** — Live, during Claude inference (optional; requires `SLACK_USER_TOKEN`)
- **How they're combined:** Results are injected into the user message as `[KB RESULTS]`, `[CONFLUENCE RESULTS]`, `[JIRA RESULTS]`, `[TEAM KNOWLEDGE]`, and optional `[FEEDBACK CORRECTIONS]` blocks
- **External services:** Anthropic API (used for both Claude inference and `web_search` for KB), Confluence REST, Jira REST, Slack MCP

### Role-based prompts (CSA vs. Specialist)
- **CSA prompt** (`prompts.js:SYSTEM_PROMPT_CSA`, ~200 lines):
  - Escalation-first; simpler troubleshooting steps
  - Filters out refs marked `sensitive: true` from the response
  - Hard rules: never invent, ground every claim in search results
- **Specialist prompt** (`prompts.js:SYSTEM_PROMPT_SPECIALIST`, ~200 lines):
  - Full technical depth; shows all refs
  - No "should I escalate?" decision (specialists already own the case)
  - Same hard rules

---

## 6. Full-response Claude pipeline

### `queryWithContext()` — the main inference path
- **Files:** `src/claude/query.js:51-157`
- **Steps:**
  1. Pick system prompt (CSA or Specialist)
  2. Build user message with all pre-fetched context blocks
  3. Stream Claude with MCP servers attached (Slack only, if token present)
  4. Collect full text output
  5. `parseClaudeResponse()` strips markdown fences and extracts the JSON object
  6. Attach KB refs, auto-save new KB articles to `knowledge.md`
- **Timeout:** 90s (`CLAUDE_TIMEOUT_MS`)
- **Max tokens:** 4096 output

### Response JSON schema (CSA / Specialist)

```json
{
  "issue_title": "string, max 6 words",
  "integration_type": "Zapier | Angi | RwG | ServiceChannel | Thumbtack | Procore | Chat-to-Text | General",
  "is_accounting_topic": false,
  "confidence": "high | medium | low",
  "customer_message": "string, paste-ready",
  "escalate_decision": { "should_escalate": false, "reason": "string" },
  "channel_recommendation": { "channel": "#channel-name", "reason": "string" },
  "agent_steps": [
    { "num": 1, "title": "string", "detail": "string", "tag": "action|backend|verify|escalate" }
  ],
  "findings_summary": { "diagnosis": "string (one sentence)", "actions": ["string"] },
  "slack_refs":     [ { "url": "...", "channel": "...", "title": "...", "sensitive": true } ],
  "atlassian_refs": [ { "type": "confluence|jira", "url": "...", "title": "...", "sensitive": true } ],
  "kb_refs":        [ { "url": "...", "title": "...", "snippet": "..." } ],
  "sources_used": ["slack","confluence","jira","kb"]
}
```

When the bot is uncertain, it returns a simpler fallback:

```json
{ "clarifying_question": "yes/no question for the agent" }
```

---

## 7. Response rendering & user interaction

### Block Kit response builder
- **Files:** `src/slack/blocks.js:buildResponseBlocks()`
- **Pieces of the response card:**
  1. Header with issue title and confidence icon
  2. Compact info line: escalation signal + channel recommendation
  3. Diagnosis context (if available)
  4. Color-coded steps (blue=action, orange=backend, green=verify, red=escalate)
  5. Source chips showing which source types contributed (📄 Confluence / Jira, 💬 Slack, 📖 KB)
  6. Action buttons: **Wrong Answer**, **Sources**, **Copy Message**, (CSA only) **Show Specialist Detail**
  7. Nomination suggestion if the response qualifies for the knowledge base

### Wrong-answer feedback flow
- **Trigger:** Click "Wrong Answer" → modal opens
- **Flow:**
  1. Modal collects feedback type (wrong_answer / partially_correct / outdated / wrong_integration) + correction text
  2. Saved to `data/feedback-pending.json`
  3. Review card posted to `FEEDBACK_REVIEW_CHANNEL_ID` with Approve / Reject buttons
  4. **Approve** → moves to `data/feedback.json`, DMs the agent, **invalidates the response cache**, future similar queries inject the correction
  5. **Reject** → record deleted, agent DM'd
- **Files:** `src/slack/feedback.js`, `src/slack/blocks.js:buildFeedbackModal()`, `src/index.js:212-336`, injection at `src/handlers/mention.js:254-273`
- **Caps:** 500 active / 200 pending

### Knowledge nomination system
- **Trigger:** Bot self-nominates a response if it meets criteria (has refs, no escalation, has steps, took >30s, not a clarifying question)
- **Flow:**
  1. Step 16 of `handleQuery` (`mention.js:408-433`) posts a nomination card to `FEEDBACK_CHANNEL`
  2. **Approve** → `appendBotResponse()` writes to `data/knowledge.md` under the integration section; knowledge cache cleared
  3. **Reject** → discarded
- **Files:** `src/slack/nominations.js`, `src/slack/knowledge-writer.js`, handlers at `src/index.js:338-374`

### Specialist detail view
- **Trigger:** CSA clicks "Show Specialist Detail" on a response
- **Flow:** Re-runs `queryWithContext(query, { role: 'specialist' })` and posts the result in-thread. All refs shown (no sensitivity filter)
- **Files:** Handler at `src/index.js:144-209`; button value set up at `src/handlers/mention.js:250`

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
- **What it does:** When Claude's answer cites a `help.servicetitan.com` article, the bot appends it to `knowledge.md` if not already present (dedupe by URL)
- **Trigger:** Automatic at end of `queryWithContext`
- **Files:** `src/slack/knowledge-writer.js:appendKbArticle()`, hook in `src/claude/query.js`

---

## 9. Health & monitoring

### Health-check endpoint
- **What:** `GET /health` (HTTP mode only) returns uptime, cache stats, source availability
- **Files:** `src/index.js:388-399`

### Periodic pruning
- **What:** Every 15 minutes — remove expired cache entries and expired thread histories
- **Files:** `src/index.js:376-385`, `src/slack/cache.js:pruneExpired()`, `src/slack/conversation.js:pruneConversations()`

### Startup validation
- Required env vars present (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`)
- `users:read` scope works (so role detection won't fail)
- Feedback review channel configured and bot is a member
- Slack MCP and Atlassian REST credentials check
- Re-posts any pending feedback entries that got stuck across a restart

---

## 10. CLI simulator & tests

### `cli.js`
- **What:** Interactive REPL for testing without Slack. Calls the full pipeline, prints color-coded output
- **Commands:** plain text (submit query), `/wrong` (file feedback), `/feedback` (list recent), `quit`
- **Run:** `ANTHROPIC_API_KEY=... node cli.js`

### `test.js`
- **What:** Plain `assert()` test suite, no framework. 419 assertions across cache, conversation, feedback, knowledge writer, accounting filter, parsers, all Block Kit builders, modals, progress blocks
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
- `SLACK_USER_TOKEN` — enables Slack MCP search (else Claude has no live Slack tool)
- `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` — Confluence + Jira REST (Basic Auth)
- `FEEDBACK_REVIEW_CHANNEL_ID` — moderation queue channel

### Optional
- `SLACK_APP_TOKEN` — Socket Mode for local dev (blank → HTTP mode)
- `ATLASSIAN_BASE_URL` — override default `servicetitan.atlassian.net`
- `ANTHROPIC_MODEL`, `CLAUDE_TIMEOUT_MS`, `CACHE_TTL_MS`, `CACHE_MIN_MS`, `CONVERSATION_TTL_MS`, `KNOWLEDGE_MIN_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `NEW_PIPELINE`, `PORT`, `LOG_LEVEL`

---

## 13. The 16-step query flow

When a `@mention` or DM arrives, both entry points call `handleQuery()` in `src/handlers/mention.js:49`. The flow is deterministic and early-exits at the first fast path:

1. Strip `<@U…>` bot mention from text
2. Empty query → greeting + return
3. Rate limit check (5/min/user) → "slow down" + return if exceeded
4. Accounting keyword check → fast redirect + return
5. `help` command → help card + return
6. **Thread has history** → follow-up branch (`queryChat` state machine), return
7. Cache hit → return cached
8. Role detection + post "Checking…" placeholder (parallel)
9. Inject sanitized feedback corrections
10. **Full Claude query** (`queryWithContext`) — pre-fetch KB/Confluence/Jira, stream Claude with Slack MCP, parse JSON
11. Attach metadata, conditionally cache
12. Accounting double-check on Claude's response (safety net)
13. Clarifying-question early-return (if Claude couldn't answer confidently)
14. Deliver final response card
15. Seed conversation history (for follow-ups)
16. Nominate response for the knowledge base if it qualifies

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
Thread has history? ── queryChat (state machine), return
   │
   ▼
Full query:
   ├─ Pre-fetch in parallel: KB, Confluence, Jira  (8s timeout each)
   ├─ Inject: data/knowledge.md, past corrections, search results
   ├─ Claude Sonnet 4.6 (+ optional Slack MCP) → JSON
   ├─ Parse, attach KB refs, auto-save KB articles
   └─ Conditionally cache the result
   │
   ▼
Render Block Kit response
   ├─ Header + confidence
   ├─ Escalation signal + channel recommendation
   ├─ Color-coded steps
   ├─ Source chips
   └─ Buttons: Wrong Answer, Sources, Copy Message, Show Specialist Detail
   │
   ▼
Post to Slack → seed thread history → nominate to KB if eligible
```

---

## 15. MCP architecture

- **Slack MCP:** Optional. With `SLACK_USER_TOKEN` set, Claude can call Slack search tools during inference (used both inside `queryChat` and as one of the search sources in the NEW_PIPELINE search executor)
- **Atlassian:** REST Basic Auth (migrated from MCP in PR #11). Confluence + Jira are searched directly via REST in `src/claude/atlassian-search.js`
- **KB:** Anthropic `web_search_20250305` scoped to `help.servicetitan.com` (see `src/claude/kb-search.js`). No MCP, no separate API key

---

## 16. Sensitivity & ref filtering

Some references are marked `"sensitive": true` (internal escalation channels, Jira tickets with PII, engineering-only docs). CSAs see only non-sensitive refs; Specialists see everything. This is enforced inside `buildResponseBlocks()` based on the detected role.

---

## Summary in one paragraph

IntegrationsBot is a Slack-native, Node ESM, single-process bot. Channel mentions and DMs converge on a single 16-step handler that walks fast paths (empty / help / accounting / rate limit / cache / thread follow-up) before doing the heavy work: parallel pre-fetch from Confluence + Jira (REST) + KB (Anthropic `web_search` scoped to `help.servicetitan.com`) + the local `data/knowledge.md`, an injected past-corrections block, then a single Claude Sonnet 4.6 call (with optional Slack MCP) that returns a structured JSON response. The response is rendered as a Block Kit card with confidence, escalation signal, color-coded steps, source chips, and action buttons (Wrong Answer, Sources, Copy Message, Show Specialist Detail). A feedback-and-nomination loop curates `data/knowledge.md` over time. The bot also supports a four-stage NEW_PIPELINE (Interpreter → Search → Evaluator → Answerer) gated by an env flag.
