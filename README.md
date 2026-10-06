# IntegrationsBot — ServiceTitan Integrations Support

Internal Slack bot for ServiceTitan integrations support people who own the case. Given a customer issue, the bot runs a fixed pipeline — Intake → Research → Resolver → (optional) Reply — searching Slack history, Confluence, Jira, and the ServiceTitan KB, then returns a structured response: a research summary with linked sources, step-by-step troubleshooting, and involvement guidance when another team is needed.

---

## How It Works

1. An agent mentions `@IntegrationsBot <question>` in a channel, or DMs the bot directly
2. The bot posts a "searching…" placeholder immediately
3. The always-on pipeline runs (60s hard cap):
   - **Intake (Interpreter)** — understands the question and builds a search plan
   - **Research** — every question searches Confluence, Jira, Slack, and the help center in parallel; an evaluator may refine the plan once. Pages and tickets that come back stay on the card.
   - **Resolver** — produces diagnosis, steps, and involvement
   - **Reply** — adds a paste-ready `customer_message` only when Intake set `entities.customer_mentioned`
4. The placeholder is replaced with a structured Block Kit response:
   - **Research** — the diagnosis, then the Slack, Confluence, Jira, and KB sources as links when the host is allowlisted
   - **Steps** — numbered steps tagged `action`, `backend`, `verify`, or `escalate`. A follow-up in the same thread is a chat reply: the summary only, with source links, and no new case card
   - **Involvement** — whether another team should take it. The card names the workspace channel that owns this issue, or a few channels it could go to when no single one does. The bot does not post into those channels. A person posts there.

One audience: integrations support people who own the case. There is no CSA vs Specialist mode split and no legacy single-call rollback path.

Accounting integration topics (QuickBooks, Sage Intacct, NetSuite, Xero, etc.) are a keyword check and redirect to `#ask-partner-enabled-accounting-integrations`.

Wrong-answer feedback and knowledge.md nominations stay human-approved (Steward).

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
| `CLAUDE_TIMEOUT_MS` | Optional | Per-call API timeout in ms (default: `90000`). The pipeline itself hard-caps at 60s. |
| `CACHE_TTL_MS` | Optional | Response cache TTL in ms (default: `3600000` = 1 hour) |
| `RATE_LIMIT_MAX` | Optional | Max requests per user per window (default: `5`) |
| `RATE_LIMIT_WINDOW_MS` | Optional | Rate limit window in ms (default: `60000` = 1 min) |
| `PORT` | Optional | HTTP port when not using Socket Mode (default: `3000`) |
| `LOG_LEVEL` | Optional | `info` or `debug` |

---

## Project Structure

```
src/
├── index.js                     # Bolt app startup, all action/view handlers
├── handlers/
│   ├── mention.js               # @mention handler + shared handleQuery()
│   └── dm.js                    # Direct message handler
├── claude/
│   ├── answer-schema.js         # Shared Resolver / Reply field contract
│   ├── pipeline.js              # Intake → Research → Resolver → Reply orchestrator (60s cap)
│   ├── interpreter.js           # Intake — question understanding + search plan
│   ├── search-executor.js       # Research — runs each source in parallel
│   ├── evaluator.js             # Research — sufficient? refine plan once if not
│   ├── answerer.js              # Exports runResolver and runReply
│   ├── prompts.js               # Shared parsers (parseClaudeResponse, summarizeResultForHistory)
│   ├── prompts/                 # Per-stage prompts (interpreter, evaluator, resolver, reply)
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

Resolver returns a structured JSON object. Reply adds `customer_message` only when Intake marked a customer as mentioned:

```json
{
  "issue_title": "Zapier API Access Not Enabled",
  "integration_type": "Zapier",
  "confidence": "high",
  "diagnosis": "Zapier cannot authenticate because API access was never enabled on this tenant.",
  "steps": [
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
  "involvement": {
    "needed": false,
    "who": null,
    "reason": "Case owner can enable API access and verify.",
    "channel": null
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
  "sources_used": ["slack", "confluence", "kb"],
  "customer_message": "Hey [Name], I can see the issue — Zapier API access hasn't been enabled for your tenant yet. Getting that sorted now."
}
```

When `involvement.needed` is true, `who` is one of `engineering`, `partner`, or `leads`. `channel` is the one listed workspace channel for this issue, or null. `suggestions` holds up to 3 listed channels when no single channel owns it. Channel names are not stored in the bot. The card shows them. The bot does not post the handoff.

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
