# Slack-Intbot — ServiceTitan Integrations Support Assistant

An internal Slack bot that helps ServiceTitan support agents troubleshoot integrations issues and draft customer-facing emails, powered by **Claude AI**.

## How It Works

1. An agent submits a support ticket/issue description via Slack.
2. The bot sends it to Claude with a strict system prompt.
3. Claude returns a structured JSON response with **two sections**:
   - **Agent Troubleshooting** — internal-only diagnosis, verification steps, escalation guidance, and KB article links.
   - **Customer Email Draft** — a polished, customer-facing email ready to copy/paste.
4. The bot renders both sections as a formatted Slack message (ephemeral by default).

## Usage

### Slash command
```
/support <describe the customer issue here>
```

### App mention (in a channel)
```
@intbot <describe the customer issue here>
```

### Direct message
Send the issue description directly to the bot in a DM.

## Setup

### 1. Clone & install
```bash
git clone <repo-url>
cd Slack-Intbot
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your credentials
```

Required variables:

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot OAuth token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | From Slack app settings |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `SLACK_APP_TOKEN` | *(Optional)* App token for Socket Mode (`xapp-…`) |

### 3. Slack App Configuration

In your [Slack App settings](https://api.slack.com/apps):

**OAuth & Permissions — Bot Token Scopes:**
- `chat:write`
- `commands`
- `app_mentions:read`
- `im:history`
- `im:read`
- `im:write`

**Event Subscriptions — Subscribe to bot events:**
- `app_mention`
- `message.im`

**Slash Commands:**
- `/support`

### 4. Run
```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

## Project Structure

```
src/
  index.js        — Slack Bolt app, event/command handlers
  claude.js       — Anthropic SDK wrapper, calls Claude
  systemPrompt.js — System prompt defining bot behaviour and output format
  formatSlack.js  — Converts Claude JSON to Slack Block Kit blocks
```

## Output Format

The bot always outputs a JSON object (rendered as Slack blocks):

```json
{
  "agentTroubleshooting": {
    "summary": "...",
    "likelyCauses": ["..."],
    "verificationSteps": ["..."],
    "escalation": { "required": true, "team": "...", "reason": "..." },
    "kbArticles": ["KB-XXXX: title"],
    "internalNotes": "..."
  },
  "customerEmailDraft": {
    "subject": "...",
    "greeting": "Hi [Customer Name],",
    "body": "...",
    "closing": "Best regards,\nServiceTitan Integrations Support"
  }
}
```

> **Internal use only.** Never share `agentTroubleshooting` content with customers.
