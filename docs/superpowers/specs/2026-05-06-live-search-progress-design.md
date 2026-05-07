# Live Search Progress Design

## Goal

Replace the static "Checking…" / "Thinking…" placeholder with a live-updating message that shows the bot's search activity in real time — which sources are being searched, and how many results each returned.

## User-Facing Behaviour

When the bot posts its thinking placeholder, that message evolves in place as Claude works:

**Stage 1 — Just posted:**
```
🔍 Checking…
"Zapier stopped syncing after we enabled API access"
```

**Stage 2 — First tool fires:**
```
🔍 Checking…
"Zapier stopped syncing after we enabled API access"
⟳ Confluence  searching…
```

**Stage 3 — Mid-search:**
```
🔍 Checking…
"Zapier stopped syncing after we enabled API access"
✓ Confluence  · 3 results
⟳ Jira  searching…
```

**Stage 4 — All searches done, writing:**
```
🔍 Checking…
"Zapier stopped syncing after we enabled API access"
✓ Confluence  · 3 results
–  Jira  · 0 results
✓ Slack  · 1 result
✏️ Writing answer…
```

**Stage 5 — Final card replaces the message** (unchanged from today)

The result count is shown as dimmed secondary text (`· N results`). A source that returned nothing shows a grey dash (`–`) instead of a green tick. The stages apply to both the initial query path ("Checking…") and the follow-up chat path ("Thinking…").

## Architecture

### 1. Streaming switch in query.js

Both `queryWithContext` and `queryChat` switch from `anthropic.beta.messages.create` to `anthropic.beta.messages.stream`. The stream emits raw SSE events; we listen for:

- `content_block_start` with `content_block.type === 'tool_use'` → a search has started. `content_block.name` is the MCP tool name (e.g. `confluence_search`, `slack_search_messages`).
- `content_block_start` with `content_block.type === 'tool_result'` → a search has returned. The content is a JSON string we parse to count results.
- After all tool calls, text generation begins → emit `phase: 'writing'`.

The stream is drained to completion with `stream.finalMessage()`, which returns the same `Message` object as `.create()` did. The rest of the function (parsing, KB auto-save) is unchanged.

### 2. onProgress callback

Both functions gain an optional third-party argument:

```js
// queryWithContext
export async function queryWithContext(userQuery, { role, agentName, onProgress } = {})

// queryChat
export async function queryChat(userQuery, history, { kbContext, onProgress } = {})
```

`onProgress` is called with a plain object:

```js
// tool started
onProgress({ phase: 'tool_start', tool: 'confluence' })

// tool completed
onProgress({ phase: 'tool_done', tool: 'confluence', count: 3 })

// all tools done, text generation starting
onProgress({ phase: 'writing' })
```

`tool` is a normalised label derived from the raw MCP tool name:

| MCP tool name | Normalised label |
|---|---|
| `confluence_search` / `search_confluence` | `confluence` |
| `jira_*` | `jira` |
| `slack_search_*` / `search_slack_*` | `slack` |
| anything else | raw tool name (truncated to 20 chars) |

If `onProgress` is not provided, the streaming call still runs — callers that don't need progress get the same behaviour as before.

### 3. buildProgressBlocks

New exported function in `src/slack/blocks.js`:

```js
buildProgressBlocks(query, steps)
```

`steps` is an array of step objects accumulated by the caller:

```js
{ tool: 'confluence', phase: 'tool_start' | 'tool_done', count: number | null }
```

The function renders the Block Kit equivalent of the staged mockups above. It is called by mention.js in place of `buildThinkingBlocks` once the first progress event arrives.

Rules:
- `phase: 'tool_start'` → `⟳ Confluence  searching…` (blue, italic dim text)
- `phase: 'tool_done'` with `count > 0` → `✓ Confluence  · N results` (green tick, dimmed count)
- `phase: 'tool_done'` with `count === 0` → `–  Confluence  · 0 results` (grey dash)
- A `writing` entry in steps → `✏️ Writing answer…` appended at the bottom
- The query is shown italicised below the header, truncated to 120 chars

### 4. mention.js wiring

In `handleQuery`, for both the initial query path (step 9, `queryWithContext`) and the follow-up path (step 5, `queryChat`):

```js
const steps = [];
let lastUpdateMs = 0;

const onProgress = async (event) => {
  if (event.phase === 'tool_start') {
    steps.push({ tool: event.tool, phase: 'tool_start', count: null });
  } else if (event.phase === 'tool_done') {
    const existing = steps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
    if (existing) existing.phase = 'tool_done';
    if (existing) existing.count = event.count;
  } else if (event.phase === 'writing') {
    steps.push({ tool: null, phase: 'writing', count: null });
  }

  const now = Date.now();
  if (thinkingTs && now - lastUpdateMs >= 1000) {
    lastUpdateMs = now;
    await client.chat.update({
      channel: channelId,
      ts: thinkingTs,
      blocks: buildProgressBlocks(query, steps),
      text: 'Checking…',
    }).catch(() => {});
  }
};
```

The `.catch(() => {})` on `chat.update` is intentional — a failed progress update is non-critical; the final card will still replace it.

### 5. Result count extraction

When a `tool_result` content block arrives, its content is a string (often JSON). We attempt:

```js
function extractResultCount(content) {
  try {
    const obj = JSON.parse(content);
    const arr = obj.results ?? obj.items ?? obj.messages ?? obj.pages ?? [];
    return Array.isArray(arr) ? arr.length : null;
  } catch {
    return null;
  }
}
```

If parsing fails or no known array key is found, `count` is `null` and the step renders without a count: `✓ Confluence` (no dimmed text). This is a graceful fallback — result counts are a nice-to-have.

## Files Changed

| File | Change |
|---|---|
| `src/claude/query.js` | Switch to streaming; add `onProgress` param to `queryWithContext` and `queryChat`; add `extractResultCount` helper |
| `src/slack/blocks.js` | Add `buildProgressBlocks(query, steps)` |
| `src/handlers/mention.js` | Wire `onProgress` in both the initial query path and follow-up path |
| `test.js` | Tests for `buildProgressBlocks` |

## Error Handling

- If `onProgress` throws, the error is swallowed — progress updates are non-critical.
- If `chat.update` fails (rate limit, network), the error is swallowed.
- Timeout and abort behaviour in `queryWithContext` / `queryChat` is unchanged — the `AbortController` still works with the stream via `stream.controller.abort()`.
- If streaming is not available (unexpected SDK version), callers fall back gracefully because `onProgress` is optional and the `.create()` path still exists as a fallback (the plan includes a fallback guard).

## What Does Not Change

- `buildThinkingBlocks` stays — it is still used for the initial post before any progress event arrives.
- `queryWithKnowledge` (Tier 2 fast-lookup) — no MCP tools, no streaming needed. Unchanged.
- `queryAuditLog` — separate flow, unchanged.
- DM handler (`dm.js`) — calls `handleQuery` in mention.js, which already handles both paths. No DM-specific changes needed.
- All existing tests continue to pass unchanged.
