# MCP Integration Design

## Goal
Replace the bot-side keyword search layer (`src/search/`) with Anthropic's Model Context Protocol (MCP). Claude drives its own searches against Atlassian (Confluence + Jira) and Slack, producing smarter, more contextual answers without keyword guessing.

## Architecture

### What gets removed
- `src/search/slack-search.js`
- `src/search/confluence-search.js`
- `src/search/index.js`
- All related imports and tests in `test.js`

### What gets changed
- `src/claude/query.js` — `queryWithContext` switches to `anthropic.beta.messages.create` with `mcp_servers` config. `queryChat` is unchanged.
- `src/claude/prompts.js` — `SYSTEM_PROMPT` updated to tell Claude it has MCP tools available (Atlassian + Slack) and to use them before answering. The `[CONTEXT]` block instructions are replaced with MCP tool usage instructions.
- `test.js` — search module imports and their tests removed.

### MCP Servers
```
Atlassian MCP:
  url: https://mcp.atlassian.com/v1/sse
  token: ATLASSIAN_MCP_TOKEN (already in .env, confirmed working)
  provides: Confluence page search, Jira ticket lookup

Slack MCP:
  url: https://mcp.slack.com/mcp
  token: SLACK_USER_TOKEN
  provides: message search across all channels (no bot membership required)
  conditional: skipped if SLACK_USER_TOKEN is missing or placeholder
```

### Timeout
Increased from 45s to 90s (`CLAUDE_TIMEOUT_MS` default) to cover MCP round-trips. Configurable via env var.

### Thinking message
Updated to reflect MCP activity: *"Checking Confluence, Jira, and past Slack threads…"* instead of generic "Searching knowledge sources…"

### queryChat unchanged
Follow-up conversation mode does not use MCP — conversation history already provides context. No changes to `queryChat` or `CHAT_SYSTEM_PROMPT`.

## Data Flow
1. Agent sends query
2. `handleQuery` posts thinking placeholder
3. `queryWithContext(query)` called
4. Anthropic API call made with `mcp_servers` config and `betas: ['mcp-client-2025-04-04']`
5. Claude decides what to search, calls MCP tools (handled by Anthropic infrastructure — no client-side loop)
6. Claude generates structured JSON response
7. `parseClaudeResponse` extracts and parses JSON
8. Response delivered to agent

## Error Handling
- If Atlassian MCP is unreachable: Claude falls back to training knowledge + team knowledge file. Logs warning.
- If Slack MCP token missing/invalid: Slack MCP server omitted from config entirely. Atlassian MCP still active.
- If both fail: existing error block shown to agent.

## Environment Variables
| Variable | Description |
|----------|-------------|
| `ATLASSIAN_MCP_TOKEN` | Atlassian API token (already set) |
| `SLACK_USER_TOKEN` | User token with `search:read` scope (xoxp-...) |
| `CLAUDE_TIMEOUT_MS` | Default now 90000 (was 45000) |

## Testing
- Remove search module tests from `test.js`
- Verify remaining 88 tests (minus search tests) still pass
- Manual live test: query bot, confirm Confluence and Jira results appear in `atlassian_refs`
