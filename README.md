# IntegrationsBot — ServiceTitan Integrations Support

Internal Slack bot for ServiceTitan integrations support agents. Given a customer issue, the bot searches Slack history, Confluence, Jira, and the ServiceTitan KB — then returns a structured response: escalation decision, step-by-step troubleshooting, a ready-to-paste customer message, and referenced sources.

---

## How It Works

1. An agent mentions `@IntegrationsBot <question>` in a channel, or DMs the bot directly
2. The bot posts a "searching…" placeholder immediately
3. A single Claude API call (with both MCP servers active simultaneously) searches all knowledge sources in parallel
4. The placeholder is replaced with a structured Block Kit response:
   - **Escalation signal** — should the CSA handle it or route to a specialist?
   - **💬 Customer message** — ready-to-paste message for the customer ticket
   - **🔧 Agent steps** — numbered steps tagged `action`, `backend`, `verify`, or `escalate`
   - **📎 Sources** — Slack threads, Confluence pages, Jira tickets, and KB articles referenced

Accounting integration topics (QuickBooks, Sage Intacct, NetSuite, Xero, etc.) are automatically redirected to `#ask-partner-enabled-accounting-integrations`.

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo>
cd Slack-Intbot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your tokens
```

See [Environment Variables](#environment-variables) below for details on each variable.

### 3. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.

**Required OAuth scopes (Bot Token):**
- `app_mentions:read` — receive mention events
- `channels:history` — read channel messages
- `chat:write` — post messages
- `im:history` — receive DMs
- `im:read` — read DM channels
- `im:write` — open DM channels

**Required Event Subscriptions:**
- `app_mention` — bot is mentioned in a channel
- `message.im` — direct message to the bot

**Additional setup for auto-answer channel watcher:**
- Bot scopes: `channels:read`, `channels:history`, `chat:write`
- Event subscription: `message.channels`
- `AUTO_ANSWER_SOURCE_CHANNEL` and `AUTO_ANSWER_TARGET_CHANNEL` must be Slack channel IDs, not names
- The bot must be a member of both channels
- Auto-answer remains off unless `AUTO_ANSWER_ENABLED=true`

**For Socket Mode** (recommended for development):
- Enable Socket Mode in your app settings
- Generate an App-Level Token with `connections:write` scope
- Set `SLACK_APP_TOKEN` in `.env`

**For HTTP Mode** (production):
- Set a public Request URL: `https://your-domain.com/slack/events`
- Leave `SLACK_APP_TOKEN` blank

### 4. Run

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Bot token (`xoxb-...`) from OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | ✅ | From Basic Information |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key |
| `SLACK_APP_TOKEN` | Socket Mode only | App-level token (`xapp-...`) |
| `ATLASSIAN_EMAIL` | Recommended | Atlassian account email — paired with `ATLASSIAN_API_TOKEN` for Basic Auth |
| `ATLASSIAN_API_TOKEN` | Recommended | Atlassian API token for Confluence/Jira REST search (from `id.atlassian.com/manage-profile/security/api-tokens`) |
| `ATLASSIAN_BASE_URL` | Optional | Atlassian site URL (default: `https://servicetitan.atlassian.net`) |
| `SLACK_USER_TOKEN` | Recommended | User token (`xoxp-...`) for Slack MCP history search |
| `AUTO_ANSWER_ENABLED` | Optional | Set to `true` to enable the channel-watcher that auto-drafts answers for new posts in `AUTO_ANSWER_SOURCE_CHANNEL`. Default off. |
| `AUTO_ANSWER_SOURCE_CHANNEL` | If auto-answer enabled | Channel ID the bot watches (e.g. `C0123ABCD`). Bot must be a member. |
| `AUTO_ANSWER_TARGET_CHANNEL` | If auto-answer enabled | Channel ID where drafts are posted. Typically a private channel only you are in. |
| `FEEDBACK_REVIEW_CHANNEL_ID` | Optional | Channel ID for feedback and nomination review cards (canonical name). Bot must be a member of this channel. |
| `MODERATOR_USER_IDS` | Required for review actions | Comma-separated Slack user IDs allowed to approve/reject feedback and knowledge nominations. If unset, review actions fail closed. |
| `FEEDBACK_CHANNEL`, `FEEDBACK_CHANNEL_ID` | Optional | Legacy aliases for `FEEDBACK_REVIEW_CHANNEL_ID` — honored for backwards compatibility. |
| `ANTHROPIC_MODEL` | Optional | Claude model override (default: `claude-sonnet-4-6`) |
| `CLAUDE_TIMEOUT_MS` | Optional | API timeout in ms (default: `90000`) |
| `CACHE_TTL_MS` | Optional | Response cache TTL in ms (default: `3600000` = 1 hour) |
| `RATE_LIMIT_MAX` | Optional | Max requests per user per window (default: `5`) |
| `RATE_LIMIT_WINDOW_MS` | Optional | Rate limit window in ms (default: `60000` = 1 min) |
| `PORT` | Optional | HTTP port when not using Socket Mode (default: `3000`) |
| `LOG_LEVEL` | Optional | `info` or `debug` |

---

## New pipeline rollout

The bot runs a four-stage query pipeline (Interpreter → Search → Evaluator → Refine → Answerer) controlled by the `NEW_PIPELINE` feature flag. **Default is ON** as of the Phase-2 flip.

- `NEW_PIPELINE=true` (default) — `handleQuery` routes to `src/claude/pipeline.js`, which understands the question first (Haiku Interpreter), then searches each source with a targeted plan, evaluates the results, optionally refines once, and only then calls Sonnet for the final answer.
- `NEW_PIPELINE=false` — rolls back to the legacy `queryWithContext` / `queryChat` single-call path. Strict comparison: only the literal string `false` (case-insensitive) disables; typos do not roll back.

Both initial channel mentions and DM follow-ups respect the flag. Rollback is a single env-var change — no code redeploy required. The legacy path remains in place during Phase 2 stabilization; it will be removed in Phase 3 after the new pipeline is stable for ≥1 week.

See `docs/superpowers/specs/2026-05-19-query-understanding-redesign.md` for the full design.

---

## Project Structure

```
src/
├── index.js                     # Bolt app startup, all action/view handlers
├── handlers/
│   ├── mention.js               # @mention handler + shared handleQuery()
│   └── dm.js                    # Direct message handler
├── claude/
│   ├── query.js                 # queryWithContext, queryChat (legacy single-call path)
│   ├── pipeline.js              # 4-stage NEW_PIPELINE orchestrator (gated by NEW_PIPELINE env)
│   ├── interpreter.js           # Stage 1 — Haiku question understanding + search plan
│   ├── search-executor.js       # Stage 2 — runs each source in parallel
│   ├── evaluator.js             # Stage 3 — sufficient? refine plan once if not
│   ├── answerer.js              # Stage 4 — Sonnet final answer from gathered context
│   ├── prompts.js               # CSA / Specialist / Chat system prompts + parsers
│   ├── prompts/                 # Per-stage NEW_PIPELINE prompts (interpreter, evaluator, answerer)
│   ├── kb-search.js             # KB lookup via Anthropic web_search (help.servicetitan.com)
│   └── atlassian-search.js      # Confluence + Jira REST search
├── slack/
│   ├── blocks.js                # Block Kit builders (response, modals, error, progress)
│   ├── cache.js                 # In-memory LRU response cache with TTL
│   ├── conversation.js          # Per-thread history store for follow-up mode
│   ├── feedback.js              # Wrong Answer feedback queue + moderation
│   ├── knowledge.js             # knowledge.md loader with 5-min cache
│   ├── knowledge-writer.js      # knowledge.md append with deduplication
│   ├── modal.js                 # Channel-post modal builder
│   ├── nominations.js           # Bot-response nomination system
│   └── search-client.js         # Slack search.messages helper (uses SLACK_USER_TOKEN)
└── utils/
    ├── accounting-filter.js     # Keyword-based accounting topic detection
    ├── feature-flags.js         # isNewPipelineEnabled()
    └── rate-limiter.js          # Per-user rate limiter
scripts/
├── run-interpreter-fixtures.js  # Pre-flight gate — 10 golden interpreter fixtures
├── run-evaluator-fixtures.js    # Pre-flight gate — evaluator fixtures
├── run-answerer-fixtures.js     # Pre-flight gate — answerer fixtures
├── smoke-kb-search.js           # Live KB search smoke (Anthropic web_search)
├── smoke-atlassian.js           # Live Atlassian REST smoke
├── test-mcp.js                  # Slack MCP connectivity diagnostic
└── watch-pipeline.js            # Tail pipeline logs in real time
```

---

## Response Structure

Claude returns a structured JSON object:

```json
{
  "issue_title": "Zapier API Access Not Enabled",
  "integration_type": "Zapier",
  "is_accounting_topic": false,
  "confidence": "high",
  "customer_message": "Hey [Name], I can see the issue — Zapier API access hasn't been enabled for your tenant yet. Getting that sorted now.",
  "escalate_decision": {
    "should_escalate": false,
    "reason": "CSA can resolve with a single backend enable — no specialist needed"
  },
  "channel_recommendation": {
    "channel": "ks-integration",
    "reason": "Known fix, 1-step resolution, high confidence"
  },
  "agent_steps": [
    {
      "num": 1,
      "title": "Enable Zapier API access on the tenant",
      "detail": "In the ST Admin portal, locate the tenant and enable Zapier API access under the Integrations tab.",
      "tag": "backend"
    },
    {
      "num": 2,
      "title": "Verify the connection",
      "detail": "Ask the customer to re-authenticate in Zapier and confirm the trigger fires.",
      "tag": "verify"
    }
  ],
  "findings_summary": {
    "diagnosis": "Zapier cannot authenticate because API access was never enabled on this tenant.",
    "actions": ["Enable Zapier API access", "Re-authenticate in Zapier"]
  },
  "slack_refs": [
    { "url": "https://servicetitan.slack.com/archives/...", "channel": "#ask-integrations", "title": "Zapier API access enable steps" }
  ],
  "atlassian_refs": [
    { "type": "confluence", "url": "https://...", "title": "Zapier Integration Setup Guide" }
  ],
  "kb_refs": [
    { "url": "https://help.servicetitan.com/...", "title": "Connecting Zapier to ServiceTitan", "snippet": "API access must be enabled before Zapier can authenticate." }
  ],
  "sources_used": ["slack", "confluence", "kb"]
}
```

---

## Deployment

### Railway (recommended)

1. Push to GitHub
2. Create a new Railway project from the repo
3. Add all environment variables in Railway's dashboard
4. Railway auto-detects Node.js and runs `npm start`
5. Set your Slack app's Request URL to the Railway-provided domain

### Fly.io

```bash
fly launch
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... ANTHROPIC_API_KEY=sk-ant-...
fly deploy
```

### Local development with Socket Mode

Socket Mode doesn't need a public URL — ideal for local dev:

```bash
# Set SLACK_APP_TOKEN in .env, then:
npm run dev
```

---

## Scope — What This Bot Handles

| In scope | Out of scope |
|---|---|
| Zapier | QuickBooks |
| Angi / Angi Leads | Sage Intacct |
| Reserve with Google | NetSuite |
| ServiceChannel | Xero |
| Thumbtack | Viewpoint Vista |
| Procore | Any accounting integration |
| Chat-to-Text widget | Salesforce (future) |
| Webhooks / API | Customer-facing use |

Accounting questions are automatically redirected to `#ask-partner-enabled-accounting-integrations`.
