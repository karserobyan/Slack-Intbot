# Conversation Memory Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bot per-thread conversation memory so agents can ask follow-up questions, brainstorm, and iterate on email drafts instead of getting a fresh structured response every time.

**Architecture:** A new `conversation.js` store (mirrors `cache.js` pattern) tracks message history per Slack thread with a 4-hour TTL and 20-message cap. `mention.js` checks for history on every message — first messages go through the existing structured flow and save history; follow-ups skip search, pass history to Claude, and get a conversational plain-text reply. A new `CHAT_SYSTEM_PROMPT` and `queryChat()` function handle the follow-up mode.

**Tech Stack:** Existing `@anthropic-ai/sdk`, existing Slack Bolt client, no new dependencies.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/slack/conversation.js` | Thread history store: get/append/prune, 4hr TTL, 20-msg cap |
| Modify | `src/claude/prompts.js` | Add `CHAT_SYSTEM_PROMPT` for conversational follow-up mode |
| Modify | `src/claude/query.js` | Add `queryChat(userQuery, history)` — skips search, returns plain text |
| Modify | `src/handlers/mention.js` | Route first messages vs follow-ups; save/pass history |
| Modify | `test.js` | Add tests for conversation module |

> **Note on `dm.js`:** `dm.js` delegates entirely to `handleQuery` in `mention.js` — it requires no changes and gets conversation memory for free.

---

## Task 1: Conversation History Store

**Files:**
- Create: `src/slack/conversation.js`

### What this does
Stores per-thread message history as an array of `{role, content}` objects (Claude's messages format). Keyed by `threadTs`. TTL: 4 hours. Max 20 messages per thread — oldest messages are dropped when the cap is hit to keep token costs bounded.

- [ ] **Step 1: Add conversation tests to `test.js`**

Add `import { getHistory, appendToHistory, hasHistory, pruneConversations } from './src/slack/conversation.js';` to the import block at the **top** of `test.js`.

Then add this section before the summary block:

```js
// ── 11. Conversation History ──────────────────────────────────────────────────
console.log('\n🔹 Conversation History');

// Miss — no history yet
assert(getHistory('ts-999') === null, 'getHistory returns null for unknown thread');
assert(hasHistory('ts-999') === false, 'hasHistory returns false for unknown thread');

// Append and retrieve
appendToHistory('ts-001', [
  { role: 'user', content: 'Zapier not working' },
  { role: 'assistant', content: '{"issue_title":"Zapier API Access"}' },
]);
const h1 = getHistory('ts-001');
assert(h1 !== null, 'getHistory returns history after append');
assert(h1.length === 2, 'History has 2 messages after one append');
assert(h1[0].role === 'user', 'First message is user');
assert(h1[1].role === 'assistant', 'Second message is assistant');
assert(hasHistory('ts-001') === true, 'hasHistory returns true after append');

// Append again (follow-up)
appendToHistory('ts-001', [
  { role: 'user', content: 'Can you rewrite the email?' },
  { role: 'assistant', content: 'Sure, here is a revised version...' },
]);
const h2 = getHistory('ts-001');
assert(h2.length === 4, 'History grows with subsequent appends');

// Max messages cap — adding 20 more should trim to 20
for (let i = 0; i < 10; i++) {
  appendToHistory('ts-cap', [
    { role: 'user', content: `msg ${i}` },
    { role: 'assistant', content: `reply ${i}` },
  ]);
}
const hCap = getHistory('ts-cap');
assert(hCap.length === 20, `Max 20 messages enforced (got ${hCap?.length})`);

// pruneConversations does not remove fresh entries
pruneConversations();
assert(getHistory('ts-001') !== null, 'pruneConversations keeps fresh entries');
```

- [ ] **Step 2: Run tests — confirm they FAIL**

```bash
npm test
```

Expected: FAIL — `getHistory` not defined.

- [ ] **Step 3: Create `src/slack/conversation.js`**

```js
/**
 * Per-thread conversation history store.
 *
 * Key design:
 * - TTL: 4 hours (covers a full support interaction)
 * - Max messages: 20 per thread (caps token cost on long conversations)
 * - Key: Slack thread timestamp (threadTs)
 * - Message format: { role: 'user' | 'assistant', content: string }
 *   — matches the Anthropic messages API format directly
 */

const TTL_MS = parseInt(process.env.CONVERSATION_TTL_MS ?? String(4 * 60 * 60 * 1000), 10) || 4 * 60 * 60 * 1000;
const MAX_MESSAGES = 20;

/** @type {Map<string, { messages: Array<{role: string, content: string}>, expiresAt: number }>} */
const store = new Map();

/**
 * Returns the message history for a thread, or null if none exists / expired.
 * @param {string} threadTs - Slack thread timestamp
 * @returns {Array<{role: string, content: string}>|null}
 */
export function getHistory(threadTs) {
  const entry = store.get(threadTs);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(threadTs);
    return null;
  }
  return entry.messages;
}

/**
 * Returns true if a thread has active (non-expired) history.
 * @param {string} threadTs
 * @returns {boolean}
 */
export function hasHistory(threadTs) {
  return getHistory(threadTs) !== null;
}

/**
 * Appends new messages to a thread's history.
 * Creates the entry if it doesn't exist. Resets TTL on each append.
 * Trims to MAX_MESSAGES by dropping the oldest messages when the cap is hit.
 *
 * @param {string} threadTs - Slack thread timestamp
 * @param {Array<{role: string, content: string}>} messages - New messages to append
 */
export function appendToHistory(threadTs, messages) {
  const existing = getHistory(threadTs) ?? [];
  const combined = [...existing, ...messages];
  // Trim to cap — drop oldest messages first
  const trimmed = combined.length > MAX_MESSAGES
    ? combined.slice(combined.length - MAX_MESSAGES)
    : combined;
  store.set(threadTs, { messages: trimmed, expiresAt: Date.now() + TTL_MS });
}

/**
 * Removes all expired thread histories. Call periodically to keep memory tidy.
 */
export function pruneConversations() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}
```

- [ ] **Step 4: Run tests — confirm they PASS**

```bash
npm test
```

Expected: all tests pass including new section 11.

- [ ] **Step 5: Commit**

```bash
git add src/slack/conversation.js test.js
git commit -m "feat: add per-thread conversation history store"
```

---

## Task 2: Chat System Prompt + queryChat

**Files:**
- Modify: `src/claude/prompts.js`
- Modify: `src/claude/query.js`

### What this does
Adds a second system prompt (`CHAT_SYSTEM_PROMPT`) for follow-up mode, and a `queryChat(userQuery, history)` function that passes thread history to Claude and returns plain text (not JSON).

- [ ] **Step 1: Add `CHAT_SYSTEM_PROMPT` to `src/claude/prompts.js`**

Add this after the closing backtick of `SYSTEM_PROMPT` (after line 90):

```js
/**
 * System prompt for conversational follow-up mode.
 * Used when a thread already has history — Claude replies in plain text,
 * not JSON, and helps the agent iterate on the issue.
 */
export const CHAT_SYSTEM_PROMPT = `You are IntegrationsBot — an internal assistant for ServiceTitan integrations support agents, in conversational mode.

You are continuing a support conversation. The conversation history contains the original issue the agent submitted and your initial structured analysis (troubleshooting steps and customer email draft).

Your job now is to help the agent further:
- Answer follow-up questions about the issue
- Help brainstorm alternative approaches
- Iterate on or improve the customer email draft
- Clarify any of your previous troubleshooting steps
- Suggest next actions if the issue is not yet resolved

Reply in plain, helpful text. Do NOT return JSON. Be concise and practical — agents are busy.
Keep responses under 300 words unless the agent asks for something detailed.

HARD RULE — ACCOUNTING EXCLUSION: If the follow-up involves accounting integrations (QuickBooks, NetSuite, Xero, Sage Intacct, Viewpoint Vista, etc.), redirect the agent to #ask-partner-enabled-accounting-integrations.`;
```

- [ ] **Step 2: Add `queryChat` to `src/claude/query.js`**

**Replace** the existing import line at the top of `query.js` (do not add a second import line — modify the existing one):
```js
// Before:
import { SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';
// After:
import { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';
```

Then add this function after `queryWithContext`:

```js
/**
 * Conversational follow-up query — uses thread history, returns plain text.
 * Does NOT run search (Slack/Confluence) — relies on history for context.
 * Aborts automatically after TIMEOUT_MS.
 *
 * @param {string} userQuery - The agent's follow-up message
 * @param {Array<{role: string, content: string}>} history - Prior messages in the thread
 * @returns {Promise<string>} Plain text response
 */
export async function queryChat(userQuery, history) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const messages = [...history, { role: 'user', content: userQuery }];

  const requestParams = {
    model: MODEL,
    max_tokens: 2048,
    system: CHAT_SYSTEM_PROMPT,
    messages,
  };

  let fullText = '';

  try {
    const response = await anthropic.messages.create(requestParams, { signal: controller.signal });
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return fullText;
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all 88 tests pass (no new tests for this task — `queryChat` is integration-only).

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts.js src/claude/query.js
git commit -m "feat: add CHAT_SYSTEM_PROMPT and queryChat for conversational follow-ups"
```

---

## Task 3: Wire Conversation into handleQuery

**Files:**
- Modify: `src/handlers/mention.js`

### What this does
Updates `handleQuery` to check thread history before processing. First messages go through the existing structured flow and save history afterward. Follow-up messages skip search, call `queryChat`, post a plain text reply, and append to history.

- [ ] **Step 1: Update imports in `src/handlers/mention.js`**

Add to the existing imports at the top:
```js
import { getHistory, hasHistory, appendToHistory } from '../slack/conversation.js';
import { queryChat } from '../claude/query.js';
```

- [ ] **Step 2: Seed history in the cache-hit path**

In `handleQuery`, the cache-hit block (lines 68–77) returns early after posting the cached response. An agent whose first message hits cache would never seed history, so follow-up messages would incorrectly re-run the full structured flow.

Inside the cache-hit block, after `client.chat.postMessage` and before `return`, add:
```js
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: JSON.stringify(cached) },
    ]);
```

- [ ] **Step 3: Add the follow-up path to `handleQuery`**

In `handleQuery`, after the rate-limit check (after line 54) and before the accounting check (before line 56), insert the follow-up path:

```js
  // 1b. Follow-up path — thread has prior history
  if (hasHistory(threadTs)) {
    const history = getHistory(threadTs);

    // Post thinking placeholder
    let thinkingTs;
    try {
      const thinkingMsg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Thinking…',
      });
      thinkingTs = thinkingMsg.ts;
    } catch (err) {
      console.error('[mention] Failed to post thinking message:', err.message);
    }

    let replyText;
    try {
      replyText = await queryChat(query, history);
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
      await client.chat.update({ channel: channelId, ts: thinkingTs, text: replyText });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: replyText });
    }
    return;
  }
```

- [ ] **Step 5: Save history after first-message structured response is delivered**

History must only be seeded after the structured response is actually delivered to the user — not before the `is_accounting_topic` guard, which returns early for AI-detected accounting topics.

In `handleQuery`, at the very end of step 8 (after the final `client.chat.update`/`postMessage` block that delivers `responseBlocks`), add:

```js
  // Save initial exchange to conversation history for follow-up support.
  // Placed here (after delivery) so accounting redirects never seed history.
  appendToHistory(threadTs, [
    { role: 'user', content: query },
    { role: 'assistant', content: JSON.stringify(result) },
  ]);
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all 88 tests pass.

- [ ] **Step 6: Wire `pruneConversations` into the periodic cleanup in `src/index.js`**

In `src/index.js`, add the import:
```js
import { pruneConversations } from './slack/conversation.js';
```

In the existing `setInterval` cache prune block, add one line:
```js
pruneConversations();
```

- [ ] **Step 7: Run tests**

```bash
npm test
```

Expected: all 88 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/handlers/mention.js src/index.js
git commit -m "feat: wire conversation memory into handleQuery — follow-up chat mode"
```

---

## Task 4: Live Test

- [ ] **Step 1: Start the bot**

```bash
npm run dev
```

- [ ] **Step 2: Send a first message in Slack**

DM the bot or mention it: `Customer's Zapier integration isn't working — they say API access was never enabled.`

Expected: Structured response with troubleshooting steps and email draft (same as before).

- [ ] **Step 3: Reply in the same thread**

In the same thread, send: `Can you rewrite the email to be shorter and more friendly?`

Expected: Plain conversational reply with a revised email — NOT a new structured block. The bot should remember the context from the first message.

- [ ] **Step 4: Ask another follow-up**

In the same thread: `What if enabling API access doesn't fix it — what should I check next?`

Expected: Conversational answer building on the prior context.

---

## Done

All 4 tasks complete. The bot now:
- Remembers each Slack thread for 4 hours (up to 20 messages)
- Gives structured troubleshooting + email on first message
- Switches to natural conversational replies for follow-ups
- Agents can brainstorm, iterate on email drafts, and ask follow-up questions
- `dm.js` gets conversation memory for free (delegates to `handleQuery`)
