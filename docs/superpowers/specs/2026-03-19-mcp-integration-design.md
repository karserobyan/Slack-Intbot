# MCP Integration Design

## Goal
Replace the bot-side keyword search layer (`src/search/`) with Anthropic's Model Context Protocol (MCP). Claude drives its own searches against Atlassian (Confluence + Jira) and Slack, producing smarter, more contextual answers without keyword guessing.

## SDK Note
MCP with `anthropic.beta.messages.create` + `betas: ['mcp-client-2025-04-04']` has been tested and confirmed working with the current `@anthropic-ai/sdk` v0.39.0. No SDK upgrade required.

## Architecture

### What gets removed
- `src/search/slack-search.js`
- `src/search/confluence-search.js`
- `src/search/index.js`
- All related imports and tests in `test.js`

### What gets changed
| File | Change |
|------|--------|
| `src/claude/query.js` | `queryWithContext` switches to `anthropic.beta.messages.create` with `mcp_servers`. Hardcoded timeout fallback changed from `45000` to `90000`. Import of `gatherContext` removed. |
| `src/claude/prompts.js` | `SYSTEM_PROMPT` rewritten: `[CONTEXT]` block instructions replaced with MCP tool instructions. Hard rules updated for MCP world (Claude populates refs from tool results, not from injected context). `ATLASSIAN_EMAIL` no longer needed. |
| `src/slack/blocks.js` | `buildThinkingBlocks()` text updated from "Searching Slack channels, Confluence, Jira…" to "Checking Confluence, Jira, and past Slack threads…" |
| `src/handlers/mention.js` | Fallback `text:` property in thinking placeholder updated to match new wording. |
| `test.js` | Search module imports removed. Search module tests removed. Thinking block assertion updated to match new wording. |

### MCP Servers
```
Atlassian MCP:
  url: https://mcp.atlassian.com/v1/sse
  token: ATLASSIAN_MCP_TOKEN (already in .env, confirmed working)
  provides: Confluence page search, Jira ticket lookup
  always active when token is present

Slack MCP:
  url: https://mcp.slack.com/mcp
  token: SLACK_USER_TOKEN (xoxp-... user token with search:read scope)
  provides: message search across all channels without bot membership
  conditional: omitted from mcp_servers array if SLACK_USER_TOKEN is absent or equals 'xoxp-replace-me'
```

Note: `SLACK_MCP_TOKEN` (old commented-out variable in .env) is retired. `SLACK_USER_TOKEN` is the correct variable. `ATLASSIAN_EMAIL` is retired — the Atlassian MCP handles auth via token only.

### SYSTEM_PROMPT update direction
Remove all references to `[CONTEXT]` block. Replace with:
- Tell Claude it has two MCP tools: `atlassian` (search Confluence pages and Jira tickets) and `slack` (search past Slack threads)
- Instruct Claude to always search before answering
- Update hard rules: `slack_refs` and `atlassian_refs` are populated from MCP tool results, not from a pre-injected context block
- Keep all other hard rules (accounting exclusion, admit uncertainty, do not invent references)

### Timeout
- `CLAUDE_TIMEOUT_MS` default raised to `90000` in both the env var documentation and the hardcoded fallback in `query.js` (line: `parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10) || 90000`)

### queryChat unchanged
Follow-up conversation mode does not use MCP — conversation history already provides context. No changes to `queryChat` or `CHAT_SYSTEM_PROMPT`.

## Data Flow
1. Agent sends query
2. `handleQuery` posts thinking placeholder ("Checking Confluence, Jira, and past Slack threads…")
3. `queryWithContext(query)` called
4. Knowledge file injected (`[TEAM KNOWLEDGE]` block — unchanged)
5. Anthropic API call: `anthropic.beta.messages.create` with `mcp_servers` and `betas: ['mcp-client-2025-04-04']`
6. Claude calls MCP tools as needed (Anthropic infrastructure handles round-trips)
7. Claude generates structured JSON response
8. `parseClaudeResponse` extracts and parses JSON
9. Response delivered to agent

## Error Handling
- Atlassian MCP unreachable: Claude falls back to training knowledge + team knowledge file. Warning logged.
- Slack MCP token missing/placeholder: Slack MCP server omitted from `mcp_servers` array entirely. Atlassian still active.
- Both fail: existing error blocks shown to agent. No change from current behaviour.

## Environment Variables
| Variable | Status | Description |
|----------|--------|-------------|
| `ATLASSIAN_MCP_TOKEN` | Required | Atlassian API token (already set) |
| `SLACK_USER_TOKEN` | Optional | User token (xoxp-...) with search:read scope. Slack MCP skipped if missing. |
| `CLAUDE_TIMEOUT_MS` | Optional | Default now 90000 (raised from 45000) |
| `ATLASSIAN_EMAIL` | Retired | No longer needed — MCP handles auth via token |
| `SLACK_MCP_TOKEN` | Retired | Replaced by SLACK_USER_TOKEN |

## Testing
- Remove search module imports and all search-related tests from `test.js`
- Update thinking block test assertion to new wording
- Verify all remaining tests pass
- Manual live test: query bot, confirm Confluence and Jira sources appear in response
