# Live Search Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static "Checking…" placeholder with a live-updating Slack message that shows which sources are being searched and how many results each returned.

**Architecture:** Switch `queryWithContext` and `queryChat` to `anthropic.beta.messages.stream()`, emitting `onProgress` events on each `content_block_start` for `tool_use`, `tool_result`, and `text` blocks. `mention.js` wires an `onProgress` closure that accumulates `steps[]` and debounces `chat.update` calls (max 1/sec) to evolve the placeholder in place.

**Tech Stack:** Node.js ESM, Anthropic SDK (`anthropic.beta.messages.stream`), `@slack/bolt` `client.chat.update`

---

## File Map

| File | Change |
|---|---|
| `src/slack/blocks.js` | Add `buildProgressBlocks(query, steps)` |
| `src/claude/query.js` | Add `normalizeTool` + `extractResultCount` helpers; switch `queryWithContext` and `queryChat` to `.stream()`; add `onProgress` param to both |
| `src/handlers/mention.js` | Import `buildProgressBlocks`; wire `onProgress` in initial query path (step 10) and follow-up path (step 5) |
| `test.js` | Import `buildProgressBlocks`; add tests for it |

---

## Task 1: `buildProgressBlocks` — tests + implementation

**Files:**
- Modify: `src/slack/blocks.js` (add stub export, then full implementation)
- Modify: `test.js` (add import + tests)

- [ ] **Step 1: Add export stub to `blocks.js`**

At the bottom of `src/slack/blocks.js`, add:

```js
export function buildProgressBlocks(query, steps) {
  return [];
}
```

- [ ] **Step 2: Add import and failing tests to `test.js`**

In `test.js`, add `buildProgressBlocks` to the existing blocks import (top of file):

```js
import {
  buildResponseBlocks,
  buildWelcomeCard,
  buildSessionCard,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildSourcesModal,
  buildAuditBlocks,
  buildProgressBlocks,
} from './src/slack/blocks.js';
```

Then add this new section just before the `// ── Summary ──` block at the end of `test.js`:

```js
// ── buildProgressBlocks ───────────────────────────────────────────────────────
console.log('\n🔹 buildProgressBlocks');

// Basic structure — empty steps
const progEmpty = buildProgressBlocks('Zapier stopped syncing', []);
assert(Array.isArray(progEmpty), 'buildProgressBlocks returns array');
assert(progEmpty.length === 2, 'buildProgressBlocks returns 2 blocks');
assert(progEmpty[0].type === 'section', 'first block is section');
assert(progEmpty[0].text.type === 'mrkdwn', 'section uses mrkdwn');
assert(progEmpty[0].text.text.includes('🔍 Checking'), 'header includes 🔍 Checking');
assert(progEmpty[0].text.text.includes('Zapier stopped syncing'), 'query shown in block');
assert(progEmpty[1].type === 'context', 'second block is context');

// Query truncation at 120 chars
const longQueryProg = 'A'.repeat(200);
const progLong = buildProgressBlocks(longQueryProg, []);
assert(progLong[0].text.text.includes('…'), 'long query truncated with ellipsis');
assert(!progLong[0].text.text.includes('A'.repeat(125)), 'query capped at 120 chars');

// tool_start step → ⟳ Confluence  searching…
const progStart = buildProgressBlocks('test', [
  { tool: 'confluence', phase: 'tool_start', count: null },
]);
assert(progStart[0].text.text.includes('⟳'), 'tool_start shows ⟳');
assert(progStart[0].text.text.includes('Confluence'), 'tool name is capitalized');
assert(progStart[0].text.text.toLowerCase().includes('searching'), 'tool_start shows searching');

// tool_done count > 0 → ✓ Confluence  · 3 results
const progDone3 = buildProgressBlocks('test', [
  { tool: 'confluence', phase: 'tool_done', count: 3 },
]);
assert(progDone3[0].text.text.includes('✓'), 'tool_done count > 0 shows ✓');
assert(progDone3[0].text.text.includes('3 results'), 'count > 0 shows N results');

// tool_done count === 1 → singular "result"
const progDone1 = buildProgressBlocks('test', [
  { tool: 'confluence', phase: 'tool_done', count: 1 },
]);
assert(progDone1[0].text.text.includes('1 result'), 'count 1 uses singular "result"');
assert(!progDone1[0].text.text.includes('1 results'), 'count 1 does not say "1 results"');

// tool_done count === 0 → –  Jira  · 0 results (no ✓)
const progZero = buildProgressBlocks('test', [
  { tool: 'jira', phase: 'tool_done', count: 0 },
]);
assert(progZero[0].text.text.includes('–'), 'tool_done count 0 shows dash');
assert(progZero[0].text.text.includes('0 results'), 'tool_done count 0 shows 0 results');
assert(!progZero[0].text.text.includes('✓'), 'tool_done count 0 does not show ✓');

// tool_done count === null → ✓ Slack (no count text)
const progNullCount = buildProgressBlocks('test', [
  { tool: 'slack', phase: 'tool_done', count: null },
]);
assert(progNullCount[0].text.text.includes('✓'), 'tool_done null count still shows ✓');
assert(!progNullCount[0].text.text.includes('results'), 'tool_done null count shows no count text');

// writing step → ✏️ Writing answer…
const progWriting = buildProgressBlocks('test', [
  { tool: null, phase: 'writing', count: null },
]);
assert(progWriting[0].text.text.includes('✏️'), 'writing step shows ✏️');
assert(progWriting[0].text.text.toLowerCase().includes('writing'), 'writing step contains writing text');

// Multi-step: confluence done, jira 0, slack 1, writing
const progMulti = buildProgressBlocks('Zapier stopped syncing after API access enabled', [
  { tool: 'confluence', phase: 'tool_done', count: 3 },
  { tool: 'jira',       phase: 'tool_done', count: 0 },
  { tool: 'slack',      phase: 'tool_done', count: 1 },
  { tool: null,         phase: 'writing',   count: null },
]);
const multiText = progMulti[0].text.text;
assert(multiText.includes('✓') && multiText.includes('Confluence'), 'multi: confluence done ✓');
assert(multiText.includes('–') && multiText.includes('Jira'),       'multi: jira 0 shows –');
assert(multiText.includes('Slack') && multiText.includes('1 result'), 'multi: slack 1 result');
assert(multiText.includes('✏️'), 'multi: writing step present');
```

- [ ] **Step 3: Run tests — confirm `buildProgressBlocks` tests fail**

```bash
node test.js 2>&1 | tail -10
```

Expected: tests fail because `buildProgressBlocks` returns `[]`.

- [ ] **Step 4: Implement `buildProgressBlocks` in `blocks.js`**

Replace the stub with this full implementation. Insert a `capitalizeFirst` helper above the function (it is only used here):

```js
function capitalizeFirst(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function buildProgressBlocks(query, steps) {
  const truncated = query.length > 120 ? query.slice(0, 120) + '…' : query;
  let text = `*🔍 Checking…*\n_"${truncated}"_`;

  for (const step of steps) {
    if (step.phase === 'writing') {
      text += '\n✏️ _Writing answer…_';
    } else if (step.phase === 'tool_start') {
      text += `\n⟳ ${capitalizeFirst(step.tool)}  _searching…_`;
    } else if (step.phase === 'tool_done') {
      const label = capitalizeFirst(step.tool);
      if (step.count === null) {
        text += `\n✓ ${label}`;
      } else if (step.count === 0) {
        text += `\n–  ${label}  · 0 results`;
      } else {
        const countLabel = step.count === 1 ? '1 result' : `${step.count} results`;
        text += `\n✓ ${label}  · ${countLabel}`;
      }
    }
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '_IntegrationsBot is working on it…_' }] },
  ];
}
```

- [ ] **Step 5: Run tests — confirm all pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Results: N passed, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add buildProgressBlocks for live search progress display"
```

---

## Task 2: `normalizeTool` + `extractResultCount` + stream `queryWithContext`

**Files:**
- Modify: `src/claude/query.js`

- [ ] **Step 1: Add `normalizeTool` and `extractResultCount` helpers to `query.js`**

Add both functions after the `buildMcpServers` function (after line 44), before `queryWithContext`:

```js
function normalizeTool(name) {
  const n = (name ?? '').toLowerCase();
  if (/confluence/.test(n)) return 'confluence';
  if (/^jira/.test(n)) return 'jira';
  if (/slack/.test(n)) return 'slack';
  return (name ?? '').slice(0, 20);
}

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

- [ ] **Step 2: Switch `queryWithContext` to streaming with `onProgress`**

Change the function signature and the `try` block inside `queryWithContext`. The full updated function (lines 54–111 in the original):

```js
export async function queryWithContext(userQuery, { role = 'csa', agentName = null, onProgress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Run team knowledge fetch and KB search in parallel
  const [knowledge, kbResult] = await Promise.all([
    getKnowledge().catch(() => null),
    searchKnowledgeBase(userQuery),
  ]);

  let userContent = `Issue: ${userQuery}`;
  if (knowledge) userContent += `\n\n[TEAM KNOWLEDGE]\n${knowledge}\n[/TEAM KNOWLEDGE]`;
  if (kbResult?.text) userContent += `\n\n[KB RESULTS]\n${kbResult.text}\n[/KB RESULTS]`;
  const mcpServers = buildMcpServers();

  const basePrompt = role === 'specialist' ? SYSTEM_PROMPT_SPECIALIST : SYSTEM_PROMPT_CSA;
  const systemPrompt = agentName
    ? `${basePrompt}\n\nThe agent's display name is: ${agentName}. Use this name in customer_message.`
    : basePrompt;

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: ['mcp-client-2025-04-04'],
  };

  let fullText = '';

  try {
    const stream = anthropic.beta.messages.stream(requestParams, { signal: controller.signal });

    if (onProgress) {
      const pendingToolNames = [];
      let writingFired = false;

      stream.on('streamEvent', (event) => {
        if (event.type !== 'content_block_start') return;
        const cb = event.content_block;
        try {
          if (cb.type === 'tool_use') {
            const tool = normalizeTool(cb.name);
            pendingToolNames.push(tool);
            Promise.resolve(onProgress({ phase: 'tool_start', tool })).catch(() => {});
          } else if (cb.type === 'tool_result') {
            const tool = pendingToolNames.shift();
            if (tool != null) {
              const count = extractResultCount(typeof cb.content === 'string' ? cb.content : '');
              Promise.resolve(onProgress({ phase: 'tool_done', tool, count })).catch(() => {});
            }
          } else if (cb.type === 'text' && !writingFired) {
            writingFired = true;
            Promise.resolve(onProgress({ phase: 'writing' })).catch(() => {});
          }
        } catch {}
      });
    }

    const response = await stream.finalMessage();
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const result = parseClaudeResponse(fullText);
  if (kbResult?.refs?.length > 0) {
    result.kb_refs = kbResult.refs;
    const integration = result.integration_type || 'General';
    for (const ref of kbResult.refs) {
      appendKbArticle(integration, ref.url, ref.title, ref.snippet ?? '').catch((err) => {
        console.warn('[query] KB auto-save failed for', ref.url, ':', err.message);
      });
    }
  }
  return result;
}
```

- [ ] **Step 3: Run tests — confirm all still pass (no regression)**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Results: N passed, 0 failed`

- [ ] **Step 4: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: add normalizeTool/extractResultCount; stream queryWithContext with onProgress"
```

---

## Task 3: Stream `queryChat` with `onProgress`

**Files:**
- Modify: `src/claude/query.js`

- [ ] **Step 1: Switch `queryChat` to streaming with `onProgress`**

Replace the entire `queryChat` function (lines 123–157 in the original). The only changes from the original are: the `{ onProgress } = {}` third parameter, replacing `anthropic.beta.messages.create` with `anthropic.beta.messages.stream`, and adding the `streamEvent` listener:

```js
export async function queryChat(userQuery, history, { onProgress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const messages = [...history, { role: 'user', content: userQuery }];
  const mcpServers = buildMcpServers();

  const requestParams = {
    model: MODEL,
    max_tokens: 2048,
    system: CHAT_SYSTEM_PROMPT,
    messages,
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: ['mcp-client-2025-04-04'],
  };

  let fullText = '';

  try {
    const stream = anthropic.beta.messages.stream(requestParams, { signal: controller.signal });

    if (onProgress) {
      const pendingToolNames = [];
      let writingFired = false;

      stream.on('streamEvent', (event) => {
        if (event.type !== 'content_block_start') return;
        const cb = event.content_block;
        try {
          if (cb.type === 'tool_use') {
            const tool = normalizeTool(cb.name);
            pendingToolNames.push(tool);
            Promise.resolve(onProgress({ phase: 'tool_start', tool })).catch(() => {});
          } else if (cb.type === 'tool_result') {
            const tool = pendingToolNames.shift();
            if (tool != null) {
              const count = extractResultCount(typeof cb.content === 'string' ? cb.content : '');
              Promise.resolve(onProgress({ phase: 'tool_done', tool, count })).catch(() => {});
            }
          } else if (cb.type === 'text' && !writingFired) {
            writingFired = true;
            Promise.resolve(onProgress({ phase: 'writing' })).catch(() => {});
          }
        } catch {}
      });
    }

    const response = await stream.finalMessage();
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return fullText;
}
```

- [ ] **Step 2: Run tests — confirm all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Results: N passed, 0 failed`

- [ ] **Step 3: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: stream queryChat with onProgress"
```

---

## Task 4: Wire `onProgress` in `mention.js`

**Files:**
- Modify: `src/handlers/mention.js`

- [ ] **Step 1: Add `buildProgressBlocks` to the import in `mention.js`**

Change the blocks import (lines 7–13) to include `buildProgressBlocks`:

```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildProgressBlocks,
} from '../slack/blocks.js';
```

- [ ] **Step 2: Wire `onProgress` in the follow-up path (step 5)**

In `handleQuery`, find the follow-up path block (around line 115, the `if (hasHistory(threadTs))` block). Inside that block, `thinkingTs` is set after the `client.chat.postMessage` call (around line 127). Add the `steps` + `onProgress` setup between the thinking message and the `queryChat` call.

Replace this line:
```js
replyText = await queryChat(query, history);
```

With this block (keeping the surrounding try/catch structure intact — the `onProgress` definition goes BEFORE the try block that wraps `queryChat`):

```js
const steps = [];
let lastUpdateMs = 0;
const onProgress = async (event) => {
  if (event.phase === 'tool_start') {
    steps.push({ tool: event.tool, phase: 'tool_start', count: null });
  } else if (event.phase === 'tool_done') {
    const existing = steps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
    if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
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
      text: 'Thinking…',
    }).catch(() => {});
  }
};
replyText = await queryChat(query, history, { onProgress });
```

The full updated follow-up block (the whole `if (hasHistory(threadTs))` branch) should look like:

```js
// 5. Follow-up: active thread history → conversational mode
if (hasHistory(threadTs)) {
  const history = getHistory(threadTs);

  // Post thinking placeholder
  let thinkingTs;
  try {
    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildThinkingBlocks(query),
      text: 'Thinking…',
    });
    thinkingTs = thinkingMsg.ts;
  } catch (err) {
    console.error('[mention] Failed to post thinking message:', err.message);
  }

  const steps = [];
  let lastUpdateMs = 0;
  const onProgress = async (event) => {
    if (event.phase === 'tool_start') {
      steps.push({ tool: event.tool, phase: 'tool_start', count: null });
    } else if (event.phase === 'tool_done') {
      const existing = steps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
      if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
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
        text: 'Thinking…',
      }).catch(() => {});
    }
  };

  let replyText;
  try {
    replyText = await queryChat(query, history, { onProgress });
  } catch (err) {
    console.error('[mention] queryChat failed:', err.message);
    const errText = 'Something went wrong — please retry or escalate manually.';
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errText });
    }
    return;
  }

  // Append this exchange to history
  appendToHistory(threadTs, [
    { role: 'user', content: query },
    { role: 'assistant', content: replyText },
  ]);

  if (thinkingTs) {
    await client.chat.update({
      channel: channelId,
      ts: thinkingTs,
      blocks: buildFollowUpBlocks(replyText),
      text: replyText.slice(0, 200),
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildFollowUpBlocks(replyText),
      text: replyText.slice(0, 200),
    });
  }
  return;
}
```

- [ ] **Step 3: Wire `onProgress` in the initial query path (step 10)**

Find the step 10 block (around line 278):

```js
// 10. Full Claude query (MCP search — slowest path)
const queryStart = Date.now();
let result;
try {
  result = await queryWithContext(query + feedbackContext, { role, agentName });
} catch (err) { ...
```

Add `steps`, `lastUpdateMs`, and `onProgress` before the `try` block, and thread `onProgress` into the `queryWithContext` call:

```js
// 10. Full Claude query (MCP search — slowest path)
const queryStart = Date.now();
const steps = [];
let lastUpdateMs = 0;
const onProgress = async (event) => {
  if (event.phase === 'tool_start') {
    steps.push({ tool: event.tool, phase: 'tool_start', count: null });
  } else if (event.phase === 'tool_done') {
    const existing = steps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
    if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
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
let result;
try {
  result = await queryWithContext(query + feedbackContext, { role, agentName, onProgress });
} catch (err) {
  console.error('[mention] Claude query failed:', err.message);

  const updateTarget = thinkingTs ?? threadTs;
  if (thinkingTs) {
    await client.chat.update({
      channel: channelId,
      ts: updateTarget,
      blocks: buildErrorBlocks(query),
      text: 'Something went wrong — please retry or escalate manually.',
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildErrorBlocks(query),
      text: 'Something went wrong — please retry or escalate manually.',
    });
  }
  return;
}
```

- [ ] **Step 4: Run tests — confirm all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Results: N passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/handlers/mention.js
git commit -m "feat: wire onProgress in mention.js for live search progress"
```
