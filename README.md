# IntegrationsBot — ServiceTitan Integrations Support

Internal Slack bot for ServiceTitan integrations support agents. Given a customer issue, the bot simultaneously searches Slack history, Confluence, Jira, and the ServiceTitan KB — then returns two outputs: step-by-step agent troubleshooting instructions and a ready-to-send customer email draft.

---

## How It Works

1. An agent mentions `@IntegrationsBot <question>` in a channel, or DMs the bot directly
2. The bot posts a "searching…" placeholder immediately
3. A single Claude API call (with both MCP servers active simultaneously) searches all knowledge sources in parallel
4. The placeholder is replaced with a structured Block Kit response:
   - **🔧 Agent Troubleshooting** — numbered steps tagged `action`, `backend`, `verify`, or `escalate`
   - **✉️ Customer Email Draft** — subject + body with a "Copy Email" button
   - **📎 Sources** — which Slack threads, Confluence pages, and Jira tickets were referenced

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
| `ATLASSIAN_MCP_TOKEN` | Recommended | Atlassian API token for Confluence/Jira search |
| `SLACK_MCP_TOKEN` | Optional | Defaults to `SLACK_BOT_TOKEN` if not set |
| `PORT` | Optional | HTTP port (default: `3000`) |
| `CACHE_TTL_MS` | Optional | Cache TTL in ms (default: `3600000` = 1 hour) |
| `LOG_LEVEL` | Optional | `info` or `debug` |

---

## Project Structure

```
src/
├── index.js                  # Slack Bolt app — startup + action handlers
├── handlers/
│   ├── mention.js            # @mention handler + shared handleQuery()
│   └── dm.js                 # Direct message handler
├── claude/
│   ├── query.js              # Single Claude API call with both MCP servers
│   └── prompts.js            # System prompt + JSON response parser
├── slack/
│   ├── blocks.js             # Block Kit builders (response, redirect, error, modal)
│   └── cache.js              # In-memory LRU cache with TTL
└── utils/
    └── accounting-filter.js  # Keyword-based accounting topic detection
```

---

## Response Structure

Claude returns a structured JSON object:

```json
{
  "issue_title": "Zapier API Access Not Enabled",
  "integration_type": "Zapier",
  "is_accounting_topic": false,
  "agent_steps": [
    {
      "num": 1,
      "title": "Enable Zapier API access on the tenant",
      "detail": "Go to the ST Admin portal > Tenant Settings > Integrations. Find the tenant by ID and enable Zapier API access under the Integrations tab.",
      "tag": "backend"
    }
  ],
  "customer_email": {
    "subject": "Re: Zapier Integration Setup — ServiceTitan",
    "body": "Hi [Customer Name],\n\nThank you for reaching out...",
    "kb_links": [
      { "label": "How to set up Zapier with ServiceTitan", "url": "https://help.servicetitan.com/how-to/zapier" }
    ]
  },
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"]
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
