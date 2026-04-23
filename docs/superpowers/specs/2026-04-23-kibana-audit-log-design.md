# Kibana Audit Log Integration — Design Spec

## Goal

Add audit log querying to IntegrationsBot so agents can ask "who changed what, when, and by whom" for a given tenant. The bot routes between integration questions and log requests using Slack buttons, collects tenant details via a modal, queries Elasticsearch via MCP, and renders Claude's analysis alongside a change timeline.

## Architecture

These files change or are created:

| File | What changes |
|---|---|
| `src/handlers/mention.js` + `dm.js` | Post routing buttons as first response; don't call `handleQuery()` immediately |
| `src/index.js` | Add `app.action('integration_question')`, `app.action('log_request')`, `app.view('audit_log_submission')` handlers |
| `src/slack/modal.js` | New — `buildAuditLogModal()` |
| `src/slack/blocks.js` | Add `buildAuditBlocks()` |
| `src/claude/query.js` | Add `queryAuditLog()` |
| `src/claude/prompts.js` | Add `AUDIT_LOG_PROMPT` |
| `.env` + `.env.example` | Add `ES_MCP_URL`, `ES_MCP_TOKEN` |

## Data Flow

```
Agent @mentions bot / DMs
  → mention.js / dm.js posts routing buttons
    (original query + channelId + threadTs stored in button value JSON)
    (only shown for new queries — !hasHistory(threadTs ?? ts))

Agent clicks "🔌 Integration Question"
  → app.action('integration_question') retrieves stored context
  → calls handleQuery() — existing flow, unchanged

Agent clicks "📋 Log Request"
  → app.action('log_request') opens buildAuditLogModal()

Agent fills modal (tenant name, question, time range) → Submit
  → app.view('audit_log_submission'):
      1. Posts thinking block in thread
      2. Calls queryAuditLog({ tenantName, question, timeRange })
      3. Claude drives ES MCP searches, returns structured JSON
      4. Posts buildAuditBlocks(result) — replaces thinking block
```

## Routing Buttons

Posted as the bot's first message for every new query (not thread follow-ups). The original query text, channelId, threadTs, and userId are stored in each button's `value` JSON so the action handler can recover them.

```
What kind of help do you need?
[ 🔌 Integration Question ]  [ 📋 Log Request ]
```

## Modal — `buildAuditLogModal()`

Triggered when agent clicks "Log Request". Three fields:

| Field | Type | Required | Default |
|---|---|---|---|
| Tenant name | Plain text input | Yes | — |
| What are you looking for? | Plain text input | No | Placeholder: "e.g. Zapier stopped working yesterday" |
| Time range | Static select | No | Last 14 days |

Time range options: Last 7 days / Last 14 days (default) / Last 30 days / Last 90 days.

`private_metadata` carries channelId + threadTs so the view submission handler knows where to post.

## `queryAuditLog()` — `src/claude/query.js`

New exported function alongside `queryWithContext()` and `queryChat()`.

- Uses only the Elasticsearch MCP server (`ES_MCP_URL` + `ES_MCP_TOKEN`) — no Slack/Atlassian MCP
- Sends `AUDIT_LOG_PROMPT` as system prompt
- User message: `"Tenant: {tenantName}\nTime range: {timeRange} days\nQuestion: {question}"`
- Claude drives ES MCP tool calls (`search`, `esql`) to find audit entries
- Parses Claude's response with a dedicated `parseAuditResponse()` helper (not `parseClaudeResponse` — the JSON schema is different)
- Same timeout + AbortController pattern as `queryWithContext()`

## `AUDIT_LOG_PROMPT` — `src/claude/prompts.js`

Instructs Claude to:
- Search the Elasticsearch audit index for changes on the given tenant within the time range
- Identify the most likely cause relative to the question asked
- Return structured JSON:

```json
{
  "tenant": "Acme Corp",
  "time_range_days": 14,
  "likely_cause": "One sentence: what most likely caused the issue",
  "summary": "2–3 sentence analysis of what changed and what it means",
  "changes": [
    {
      "timestamp": "2026-04-19T09:11:00Z",
      "user": "Sarah Lee",
      "source": "Admin Panel",
      "field": "zapier_api_enabled",
      "old_value": "true",
      "new_value": "false",
      "reason": "Disabled during scheduled maintenance window"
    }
  ],
  "integration": "Zapier",
  "confidence": "high | medium | low"
}
```

## `buildAuditBlocks()` — `src/slack/blocks.js`

Block order:

```
1. header       → 📋 {tenant} — Audit Log
2. context      → {N} changes · {date range} · Integration: {integration if known}
3. section      → ⚠️ Likely cause (from likely_cause field)
4. section × N  → one per change: timestamp · user · via source / field old→new / reason if present
5. section      → summary (Claude's 2–3 sentence analysis)
6. context      → confidence · Elasticsearch audit index
7. actions      → 👎 Wrong Answer  +  🔎 View in Kibana (links to kibana_url)
8. divider
```

Change rows use color-coded indicators:
- 🔴 disabling / reducing a value
- 🟡 modifying (neutral change)
- 🟢 enabling / increasing a value

The "View in Kibana" button always links to `https://kibana.st.dev/app/discover` — hardcoded in `buildAuditBlocks()`, not returned by Claude.

## Audit Index Schema Note

The exact field names in `changes[]` (`field`, `old_value`, `new_value`, `source`, `reason`) depend on the actual Elasticsearch audit index schema. During implementation, the `AUDIT_LOG_PROMPT` must instruct Claude to discover the index schema first (via the `get_mappings` MCP tool) before querying, so it uses the correct field names rather than assumed ones.

## Environment Variables

Added to both `.env` and `.env.example`:

```
ES_MCP_URL=https://es-mcp.st.dev/mcp
ES_MCP_TOKEN=<api-key>
```

The MCP server is public HTTPS (no Teleport required). Auth uses a bearer token passed as `authorization_token` in the MCP server config — same pattern as `ATLASSIAN_MCP_TOKEN`. If the token requires interactive OAuth, a service account token will need to be issued by the ES MCP team.

## Error Handling

- `ES_MCP_URL` not set → log request button still shows, but on submit bot replies: "Elasticsearch is not configured — ask your admin for `ES_MCP_URL` and `ES_MCP_TOKEN`."
- No changes found for tenant → render "No changes found for {tenant} in the last {N} days."
- Claude times out → same timeout error message as integration queries


## What Does Not Change

- Integration question flow (`handleQuery`, `queryWithContext`, `buildResponseBlocks`) — untouched
- Thread follow-up flow (`queryChat`) — untouched
- Routing buttons are only shown for new queries (`!hasHistory(threadTs ?? ts)`) — follow-ups go straight to `queryChat` as before
