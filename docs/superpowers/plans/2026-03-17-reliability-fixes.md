# IntegrationsBot Reliability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all identified reliability, correctness, and production-quality issues in IntegrationsBot across three severity tiers.

**Architecture:** Fixes are applied directly to the existing ESM Node.js source files with no new dependencies. The three tiers map to three commits. Tier 1 eliminates crash and misdirection risks. Tier 2 closes reliability gaps in the core query pipeline. Tier 3 hardens supporting systems and adds test coverage.

**Tech Stack:** Node.js (ESM), @slack/bolt v4, @anthropic-ai/sdk, no test framework (custom assert in test.js)

---

## File Map

| File | Changes |
|---|---|
| `src/index.js` | Tier 1: wrap `private_metadata` parse in try/catch |
| `src/utils/accounting-filter.js` | Tier 1: convert keywords to word-boundary regexes |
| `src/claude/query.js` | Tier 2: AbortController timeout + model env var |
| `src/claude/prompts.js` | Tier 2: debug/error logging before JSON parse |
| `src/slack/feedback.js` | Tier 2+3: write queue, unconditional mkdir, in-memory cache, size cap, cache invalidation |
| `src/slack/cache.js` | Tier 2: export `deleteCache` function |
| `src/slack/blocks.js` | Tier 2: length caps on button values; Tier 3: fix orphaned JSDoc |
| `src/handlers/mention.js` | Tier 3: lightweight Socket Mode dedup guard |
| `src/handlers/dm.js` | Tier 3: lightweight Socket Mode dedup guard |
| `.env.example` | Tier 3: add FEEDBACK_CHANNEL_ID, ANTHROPIC_MODEL, CLAUDE_TIMEOUT_MS |
| `test.js` | Tier 1+2+3: new assertions for all changed behaviour |

---

## Task 1 — Tier 1: Fix `xero` false positive in accounting filter

**Files:**
- Modify: `src/utils/accounting-filter.js`
- Modify: `test.js`

- [ ] **Step 1: Add failing tests for the false positive and confirm existing tests still cover true positives**

Add to `test.js` after the existing accounting filter assertions:

```js
// False positive guard — these must NOT trigger accounting redirect
assert(isAccountingTopic('customer has zero Angi leads syncing') === false, 'zero does not match xero');
assert(isAccountingTopic('reset to zero') === false, '"zero" not matched as xero');
assert(isAccountingTopic('net suite of tools') === false, 'net suite as generic phrase not matched');
```

- [ ] **Step 2: Run tests and confirm the new ones fail**

```bash
node test.js
```

Expected: `zero does not match xero` and `"zero" not matched as xero` show ❌

- [ ] **Step 3: Rewrite `accounting-filter.js` to use word-boundary regexes**

Replace the entire file content:

```js
/**
 * Detects whether a query relates to accounting integrations,
 * which are out of scope for this team.
 */

// Each entry is a RegExp with word boundaries to prevent substring false positives.
// e.g. "xero" must not match "zero", "netsuite" must not match "netsuitething".
const ACCOUNTING_PATTERNS = [
  /\bquickbooks\b/i,
  /\bquick\s+books\b/i,
  /\bsage\s+intacct\b/i,
  /\bsage\s+intact\b/i,   // common misspelling
  /\bnetsuite\b/i,
  /\bnet\s+suite\b/i,
  /\bxero\b/i,
  /\bviewpoint\s+vista\b/i,
  /\baccounts\s+payable\b/i,
  /\baccounts\s+receivable\b/i,
  /\bgl\s+accounts\b/i,
  /\bgeneral\s+ledger\b/i,
  /\baccounting\s+integration\b/i,
  /\baccounting\s+sync\b/i,
  /\bchart\s+of\s+accounts\b/i,
  /\bjournal\s+entr(y|ies)\b/i,
  /\bqbo\b/i,   // QuickBooks Online
  /\bqbd\b/i,   // QuickBooks Desktop
];

/**
 * Returns true if the query contains accounting-related patterns.
 * Uses word-boundary regex matching to avoid substring false positives.
 * @param {string} text
 * @returns {boolean}
 */
export function isAccountingTopic(text) {
  return ACCOUNTING_PATTERNS.some((re) => re.test(text));
}

export const ACCOUNTING_REDIRECT_CHANNEL = '#ask-partner-enabled-accounting-integrations';
```

- [ ] **Step 4: Run all tests and confirm all pass**

```bash
node test.js
```

Expected: all assertions ✅, including the 3 new false-positive guards

---

## Task 2 — Tier 1: Fix `private_metadata` crash in feedback modal submission

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Locate the handler and wrap the parse**

In `src/index.js`, find the `feedback_submission` view handler (line ~75). Replace:

```js
const context = JSON.parse(view.private_metadata || '{}');
```

With:

```js
let context = {};
try {
  context = JSON.parse(view.private_metadata || '{}');
} catch {
  app.logger.warn('[feedback] Could not parse private_metadata — proceeding with empty context');
}
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
node test.js
```

Expected: all ✅

- [ ] **Step 3: Commit Tier 1**

```bash
git add src/index.js src/utils/accounting-filter.js test.js
git commit -m "fix(tier1): word-boundary accounting filter and private_metadata crash guard"
```

---

## Task 3 — Tier 2: Add Claude API call timeout

**Files:**
- Modify: `src/claude/query.js`
- Modify: `.env.example`

- [ ] **Step 1: Add AbortController timeout to `queryWithMcp`**

Replace the entire `src/claude/query.js`:

```js
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Configurable timeout — Claude with MCP tools can take 30-90s
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10);

// Model is configurable so you can test with cheaper models locally
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

// MCP server configurations — connections are declared per-request as per SDK spec
const MCP_SERVERS = [
  {
    type: 'url',
    url: 'https://mcp.slack.com/mcp',
    name: 'slack',
    authorization_token: process.env.SLACK_MCP_TOKEN || process.env.SLACK_BOT_TOKEN,
  },
  {
    type: 'url',
    url: 'https://mcp.atlassian.com/v1/sse',
    name: 'atlassian',
    authorization_token: process.env.ATLASSIAN_MCP_TOKEN,
  },
];

/**
 * Determines which MCP servers are configured and available.
 * Falls back gracefully if tokens are missing.
 */
function getAvailableMcpServers() {
  return MCP_SERVERS.filter((s) => s.authorization_token);
}

/**
 * Runs a single Claude API call with both MCP servers active simultaneously.
 * Aborts automatically after TIMEOUT_MS (default 90s).
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @param {Function} [onToken] - Optional callback fired with each streamed text chunk
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithMcp(userQuery, onToken) {
  const mcpServers = getAvailableMcpServers();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Issue: ${userQuery}` }],
  };

  if (mcpServers.length > 0) {
    requestParams.mcp_servers = mcpServers;
  }

  let fullText = '';

  try {
    if (typeof onToken === 'function') {
      const stream = await anthropic.messages.stream(requestParams, { signal: controller.signal });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          const token = chunk.delta.text;
          fullText += token;
          onToken(token);
        }
      }
    } else {
      const response = await anthropic.messages.create(requestParams, { signal: controller.signal });
      fullText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
  } finally {
    clearTimeout(timer);
  }

  return parseClaudeResponse(fullText);
}
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
node test.js
```

Expected: all ✅

---

## Task 4 — Tier 2: Add debug/error logging to Claude response parser

**Files:**
- Modify: `src/claude/prompts.js`

- [ ] **Step 1: Add logging around JSON parse**

Replace `parseClaudeResponse` in `src/claude/prompts.js`:

```js
/**
 * Parses Claude's JSON response string into an object.
 * Strips any accidental markdown fences before parsing.
 * Logs the raw text at debug level always, and at error level on parse failure.
 * @param {string} text
 * @returns {object}
 */
export function parseClaudeResponse(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  if (process.env.LOG_LEVEL === 'debug') {
    console.debug('[claude] Raw response (first 500 chars):', stripped.slice(0, 500));
  }

  try {
    return JSON.parse(stripped);
  } catch (err) {
    console.error('[claude] JSON parse failed. Raw response was:\n', stripped);
    throw err;
  }
}
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
node test.js
```

Expected: all ✅

---

## Task 5 — Tier 2: Add `deleteCache` export to cache module

**Files:**
- Modify: `src/slack/cache.js`
- Modify: `test.js`

- [ ] **Step 1: Add `deleteCache` to the existing cache import at the top of `test.js`**

`test.js` is an ESM module. All `import` statements must be at the top of the file — never mid-file.

Find the existing import line at the top of `test.js` (line 14):

```js
import { getCached, setCached, cacheStats, pruneExpired } from './src/slack/cache.js';
```

Replace it with:

```js
import { getCached, setCached, cacheStats, pruneExpired, deleteCache } from './src/slack/cache.js';
```

- [ ] **Step 2: Add the `deleteCache` test assertions after the existing cache tests**

Add after the existing `// ── 4. Cache` section assertions:

```js
// deleteCache
setCached('delete test query', sampleJson);
assert(getCached('delete test query') !== null, 'Entry exists before delete');
deleteCache('delete test query');
assert(getCached('delete test query') === null, 'deleteCache removes the entry');
// Key normalisation applies to delete too
setCached('normalise delete', sampleJson);
deleteCache('  NORMALISE   DELETE  ');
assert(getCached('normalise delete') === null, 'deleteCache normalises key');
```

- [ ] **Step 3: Run tests and confirm the new ones fail**

```bash
node test.js
```

Expected: `deleteCache removes the entry` shows ❌ (function doesn't exist yet)

- [ ] **Step 4: Add `deleteCache` to `src/slack/cache.js`**

Add after `setCached`:

```js
/**
 * Removes a specific entry from the cache.
 * Used to invalidate stale responses when feedback is submitted for a query.
 * @param {string} query
 */
export function deleteCache(query) {
  store.delete(cacheKey(query));
}
```

- [ ] **Step 5: Run tests and confirm all pass**

```bash
node test.js
```

Expected: all ✅

---

## Task 6 — Tier 2: Feedback module — write queue, mkdir fix, in-memory cache, size cap, cache invalidation

**Files:**
- Modify: `src/slack/feedback.js`
- Modify: `test.js`

This task rewrites `feedback.js` with five improvements bundled together since they all touch the same internal data flow:
1. Unconditional `mkdir` (removes `existsSync`)
2. Write queue (serialises concurrent writes)
3. In-memory array cache (avoid disk read on every query)
4. Max 500 entries with FIFO eviction
5. Cache invalidation — delete matching cache entry on feedback save

- [ ] **Step 1: Rewrite `src/slack/feedback.js`**

```js
/**
 * Feedback storage — persists "wrong answer" corrections to a local JSON file
 * and optionally posts to a Slack channel for team visibility.
 *
 * Design:
 * - Write queue: all writes are serialised via a Promise chain to prevent concurrent
 *   write races that could corrupt or lose entries.
 * - In-memory cache: feedback array is kept in memory after first load; invalidated
 *   on every write. Avoids a disk read on every query.
 * - Size cap: max 500 entries; oldest are evicted to keep the file manageable.
 * - Cache invalidation: when feedback is saved for a query, the bot's response cache
 *   entry for that query is deleted so the next identical query goes back to Claude
 *   with the correction injected.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteCache } from './cache.js';

const FEEDBACK_DIR = join(process.cwd(), 'data');
const FEEDBACK_FILE = join(FEEDBACK_DIR, 'feedback.json');
const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL_ID || null;
const MAX_ENTRIES = 500;

// In-memory cache of the feedback array. null = not yet loaded.
let _cache = null;

// Write queue — all writes are chained onto this Promise to prevent races.
let _writeQueue = Promise.resolve();

/**
 * Loads feedback from disk (or returns the in-memory cache if populated).
 * @returns {Promise<Array>}
 */
async function loadFeedback() {
  if (_cache !== null) return _cache;
  try {
    const raw = await readFile(FEEDBACK_FILE, 'utf-8');
    _cache = JSON.parse(raw);
  } catch {
    _cache = [];
  }
  return _cache;
}

/**
 * Persists the current in-memory cache to disk.
 * Must only be called from within the write queue.
 */
async function persistFeedback(entries) {
  await mkdir(FEEDBACK_DIR, { recursive: true }); // safe to call even if dir exists
  await writeFile(FEEDBACK_FILE, JSON.stringify(entries, null, 2));
}

/**
 * Saves a new feedback entry.
 * Writes are serialised via the write queue to prevent concurrent write races.
 *
 * @param {object} entry
 * @param {string} entry.query
 * @param {string} entry.issueTitle
 * @param {string} entry.integrationType
 * @param {string} entry.feedbackType
 * @param {string} entry.correction
 * @param {string} entry.agentId
 * @param {string} entry.agentName
 * @returns {Promise<object>} The saved record
 */
export async function saveFeedback(entry) {
  const record = {
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    query: entry.query,
    issueTitle: entry.issueTitle,
    integrationType: entry.integrationType,
    feedbackType: entry.feedbackType,
    correction: entry.correction,
    agentId: entry.agentId,
    agentName: entry.agentName,
  };

  // Serialise the write. The .catch() on the chain prevents a failed write
  // from permanently poisoning the queue — each write's error is handled
  // independently so future writes still proceed.
  _writeQueue = _writeQueue
    .then(async () => {
      const feedback = await loadFeedback();
      feedback.push(record);

      // Evict oldest entries if over the cap
      if (feedback.length > MAX_ENTRIES) {
        feedback.splice(0, feedback.length - MAX_ENTRIES);
      }

      _cache = feedback;
      await persistFeedback(feedback);
    })
    .catch((err) => {
      console.error('[feedback] Write failed, queue continues:', err.message);
    });

  await _writeQueue;

  // Invalidate the bot's response cache so the next identical query
  // goes back to Claude with this correction injected.
  deleteCache(record.query);

  return record;
}

/**
 * Posts a feedback notification to the team channel.
 *
 * @param {object} client - Slack WebClient
 * @param {object} record - Saved feedback record
 */
export async function notifyFeedbackChannel(client, record) {
  if (!FEEDBACK_CHANNEL) return;

  try {
    await client.chat.postMessage({
      channel: FEEDBACK_CHANNEL,
      text: `📝 Feedback received from ${record.agentName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*📝 Bot Feedback — ${record.feedbackType.replace(/_/g, ' ')}*`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Agent:*\n<@${record.agentId}>` },
            { type: 'mrkdwn', text: `*Integration:*\n${record.integrationType}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Original query:*\n>${record.query}` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Bot said:*\n>${record.issueTitle}` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Correction:*\n>${record.correction}` },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `_${record.id} • ${record.timestamp}_` },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('[feedback] Failed to post to feedback channel:', err.message);
  }
}

/**
 * Returns all feedback entries.
 * @returns {Promise<Array>}
 */
export async function getAllFeedback() {
  return loadFeedback();
}

/**
 * Returns recent feedback entries relevant to a query (keyword-scored).
 * Used to inject corrections into the Claude prompt.
 *
 * Scoring: each query word (>3 chars) that appears in the feedback entry's
 * combined text earns 1 point. Longer matching words earn a bonus point,
 * biasing toward specific technical terms over common short words.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array>}
 */
export async function getRelevantFeedback(query, limit = 5) {
  const all = await loadFeedback();
  if (all.length === 0) return [];

  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (queryWords.length === 0) return [];

  const scored = all.map((entry) => {
    const text = `${entry.query} ${entry.integrationType} ${entry.correction}`.toLowerCase();
    const score = queryWords.reduce((acc, w) => {
      if (!text.includes(w)) return acc;
      return acc + 1 + (w.length > 6 ? 1 : 0); // bonus for longer, more specific words
    }, 0);
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
node test.js
```

Expected: all existing assertions ✅

- [ ] **Step 3: Add feedback module import at the top of `test.js` and test assertions in the body**

**IMPORTANT — ESM rule:** All `import` statements must be at the very top of the file before any executable code. Do NOT add imports mid-file.

**Part A — Add to the imports at the top of `test.js`:**

Find the existing import block at the top of `test.js` and add this line alongside the others:

```js
import { getRelevantFeedback } from './src/slack/feedback.js';
```

**Part B — Add a new test section in the body of `test.js`** (after the Edge Cases section, before the Summary `console.log`):

```js
// ── 7. Feedback Module ───────────────────────────────────────────────────────
console.log('\n🔹 Feedback Module');

// Test: getRelevantFeedback returns an array (empty when no feedback on disk)
const emptyFeedback = await getRelevantFeedback('zapier api access not working');
assert(Array.isArray(emptyFeedback), 'getRelevantFeedback returns array');

// Test: query with only short words (≤3 chars) — all words filtered, returns empty
const shortWordFeedback = await getRelevantFeedback('it is ok');
assert(Array.isArray(shortWordFeedback), 'Short-word query returns array');
assert(shortWordFeedback.length === 0, 'Short-word query matches nothing (all words ≤3 chars filtered)');

// Note: saveFeedback writes to the real data/ directory. Full write-path tests
// would require a file path injection mechanism — that's a future improvement.
// The write queue and in-memory cache correctness is verified by code inspection.
```

Note: `test.js` already uses top-level `await` patterns via the ESM `"type": "module"` in `package.json`. The `await getRelevantFeedback(...)` calls at top level are valid.

- [ ] **Step 4: Run all tests and confirm they pass**

```bash
node test.js
```

Expected: all ✅

---

## Task 7 — Tier 2: Fix button value length caps in Block Kit

**Files:**
- Modify: `src/slack/blocks.js`
- Modify: `test.js`

- [ ] **Step 1: Add failing test for button value length**

Add to `test.js` (Edge Cases section):

```js
// Button value length guard — Slack's limit is 2000 chars
const longTitle = buildResponseBlocks({
  ...sampleJson,
  issue_title: 'A'.repeat(200),
  integration_type: 'B'.repeat(100),
  _originalQuery: 'C'.repeat(600),
});
const actionsBlock = longTitle.find(b => b.type === 'actions');
const wrongBtn = actionsBlock?.elements?.find(e => e.action_id === 'wrong_answer_modal');
assert(wrongBtn !== undefined, 'wrong_answer_modal button exists even with long values');
assert(wrongBtn.value.length <= 2000, `wrong_answer_modal value within 2000 chars (got ${wrongBtn?.value?.length})`);
```

- [ ] **Step 2: Run tests and confirm new ones fail**

```bash
node test.js
```

Expected: `wrong_answer_modal value within 2000 chars` shows ❌

- [ ] **Step 3: Add length caps to the `wrong_answer_modal` button value in `blocks.js`**

Find the `wrong_answer_modal` button value in `buildResponseBlocks` and replace:

```js
value: JSON.stringify({
  query: (data._originalQuery ?? '').slice(0, 500),
  issueTitle: data.issue_title,
  integrationType: data.integration_type,
}),
```

With:

```js
value: JSON.stringify({
  query: (data._originalQuery ?? '').slice(0, 400),
  issueTitle: (data.issue_title ?? '').slice(0, 100),
  integrationType: (data.integration_type ?? '').slice(0, 50),
}),
```

- [ ] **Step 4: Fix the orphaned JSDoc comment**

In `src/slack/blocks.js` around line 250, remove the misplaced JSDoc block that sits above `buildFeedbackModal` but describes `buildEmailModal`. Add a proper JSDoc to `buildEmailModal` at line ~309:

Remove:
```js
/**
 * Builds the modal view shown when an agent clicks "Copy Email Draft".
 *
 * @param {string} subject
 * @param {string} body
 * @returns {object} Slack view payload
 */
/**
 * Builds the modal for "Wrong Answer" feedback.
```

Replace with:
```js
/**
 * Builds the modal for "Wrong Answer" feedback.
```

And add above `buildEmailModal`:
```js
/**
 * Builds the modal view shown when an agent clicks "Copy Email Draft".
 *
 * @param {string} subject
 * @param {string} body
 * @returns {object} Slack view payload
 */
```

- [ ] **Step 5: Run all tests and confirm they pass**

```bash
node test.js
```

Expected: all ✅

- [ ] **Step 6: Commit Tier 2**

```bash
git add src/claude/query.js src/claude/prompts.js src/slack/cache.js src/slack/feedback.js src/slack/blocks.js test.js
git commit -m "fix(tier2): timeout, write queue, cache invalidation, button caps, parse logging"
```

---

## Task 8 — Tier 3: Socket Mode dedup guard

**Files:**
- Modify: `src/handlers/mention.js`
- Modify: `src/handlers/dm.js`

In Socket Mode the retry-storm risk is low, but duplicate events can still arrive if the WebSocket reconnects mid-delivery. A lightweight in-flight `Set` prevents double-processing the same message.

- [ ] **Step 1: Add dedup guard to `mention.js`**

**IMPORTANT:** `mention.js` contains two exports: `handleQuery` (lines 32–165) and `registerMentionHandler` (lines 171–183). Only modify `registerMentionHandler` — do NOT touch `handleQuery`.

Replace only the `registerMentionHandler` function (the final export at the bottom of the file):

```js
/**
 * Registers the app_mention event handler on the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerMentionHandler(app) {
  // Lightweight dedup — prevents double-processing if Socket Mode reconnects
  // mid-delivery and replays an in-flight event.
  const _inFlight = new Set();

  app.event('app_mention', async ({ event, client, logger }) => {
    if (_inFlight.has(event.ts)) {
      logger.warn(`[mention] Duplicate event ${event.ts} — skipping`);
      return;
    }
    _inFlight.add(event.ts);

    logger.info(`[mention] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);

    try {
      await handleQuery({
        rawText: event.text ?? '',
        channelId: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        client,
        userId: event.user,
      });
    } finally {
      // Remove after 60s — keeps the Set from growing forever while still
      // covering Slack's retry window (well under 60s).
      setTimeout(() => _inFlight.delete(event.ts), 60_000);
    }
  });
}
```

- [ ] **Step 2: Add dedup guard to `dm.js`**

Replace the entire `registerDmHandler` function in `dm.js`:

```js
/**
 * Registers the direct message handler on the Bolt app.
 * DMs arrive as message events in an im channel type.
 * We skip bot_message subtypes to avoid echo loops.
 *
 * @param {import('@slack/bolt').App} app
 */
export function registerDmHandler(app) {
  // Lightweight dedup — same pattern as mention.js
  const _inFlight = new Set();

  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype === 'bot_message' || message.bot_id) return;

    if (_inFlight.has(message.ts)) {
      logger.warn(`[dm] Duplicate event ${message.ts} — skipping`);
      return;
    }
    _inFlight.add(message.ts);

    logger.info(`[dm] ${message.user}: ${message.text?.slice(0, 80)}`);

    try {
      await handleQuery({
        rawText: message.text ?? '',
        channelId: message.channel,
        threadTs: message.thread_ts ?? message.ts,
        client,
        userId: message.user,
      });
    } finally {
      setTimeout(() => _inFlight.delete(message.ts), 60_000);
    }
  });
}
```

- [ ] **Step 3: Run tests to confirm nothing broke**

```bash
node test.js
```

Expected: all ✅

---

## Task 9 — Tier 3: Environment variable additions and .env.example updates

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add missing env vars to `.env.example`**

Add to the `Optional` section:

```
# Feedback channel — post a Slack notification here when an agent submits wrong-answer feedback
# Must be a channel ID (e.g. C012ABCDEFG), not a channel name
# FEEDBACK_CHANNEL_ID=C012ABCDEFG

# Claude model override — defaults to claude-sonnet-4-20250514
# Useful for switching to a cheaper model during development/testing
# ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Claude API timeout in milliseconds (default: 90000 = 90 seconds)
# Increase if you see frequent timeout errors with complex queries
# CLAUDE_TIMEOUT_MS=90000
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
node test.js
```

Expected: all ✅

- [ ] **Step 3: Commit Tier 3**

```bash
git add src/handlers/mention.js src/handlers/dm.js .env.example
git commit -m "fix(tier3): socket mode dedup guard, env var docs, feedback test coverage"
```

---

## Final Verification

- [ ] **Run the full test suite one last time**

```bash
node test.js
```

Expected output:
```
🔹 Accounting Filter
  ✅ ... (all accounting assertions including new false-positive guards)

🔹 Claude Response Parsing
  ✅ ...

🔹 Block Kit Builders
  ✅ ... (including new button value length assertion)

🔹 Cache
  ✅ ... (including new deleteCache assertions)

🔹 End-to-End Flow Simulation
  ✅ ...

🔹 Edge Cases
  ✅ ... (including button value length guards)

🔹 Feedback Module
  ✅ ...

Results: N passed, 0 failed out of N tests
✅ All tests passed!
```

- [ ] **Review the three commits**

```bash
git log --oneline -5
```

Expected: three clean fix commits on top of the existing history.
