# Knowledge Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `data/knowledge.md` from a static file into a living knowledge base — the bot auto-saves high-quality KB article hits and nominates bot responses for moderator review, with a Tier 2 fast-lookup that answers from knowledge.md before firing MCP searches.

**Architecture:** Three new modules (`knowledge-writer.js`, `nominations.js`, `queryWithKnowledge` in `query.js`) wired together via changes to `mention.js` and `index.js`. All disk writes are serialised through a `Promise` chain (same pattern as `feedback.js`). Tier 2 lookup calls Claude without MCP servers, falls through on low-confidence or error. Action handlers for `approve_nomination`/`reject_nomination` follow the exact same pattern as the existing `approve_feedback`/`reject_feedback` handlers.

**Tech Stack:** Node.js ESM, `@slack/bolt` v4, `node:fs/promises`, `node:path`, Anthropic SDK, no new npm deps.

---

## File Map

| File | Change |
|------|--------|
| `src/slack/knowledge-writer.js` | New — append KB articles and bot responses to `knowledge.md`, dedup, send Slack alert |
| `src/slack/nominations.js` | New — build nomination Slack messages with Approve/Reject buttons, `approveNomination`, `rejectNomination` |
| `src/claude/query.js` | Add `queryWithKnowledge()` for Tier 2 fast-lookup; add KB auto-save after `searchKnowledgeBase()` |
| `src/handlers/mention.js` | Add Step 2.5 (Tier 2 fast-lookup) between cache check and full Claude call; add nomination check after result |
| `src/claude/prompts.js` | Add instruction to both prompts: answer from `[TEAM KNOWLEDGE]` before running Phase 1 if match found |
| `src/index.js` | Register `approve_nomination` and `reject_nomination` action handlers |
| `test.js` | Tests for knowledge-writer (dedup, format, section creation) and nominations (block structure) |

---

## Task 1: `src/slack/knowledge-writer.js`

**Files:**
- Create: `src/slack/knowledge-writer.js`
- Modify: `test.js`

- [ ] **Step 1: Add imports and failing tests to `test.js`**

Add to the imports block at the top of `test.js` (with the other imports):

```js
import {
  appendKbArticle,
  appendBotResponse,
  hasKbUrl,
  hasIssueTitle,
} from './src/slack/knowledge-writer.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
```

Add after the last test section (before the summary `console.log` lines):

```js
// ── 14. Knowledge Writer ─────────────────────────────────────────────────────
console.log('\n🔹 Knowledge Writer');

const TEST_KB = join(process.cwd(), 'data', '__test-knowledge.md');
try { await writeFile(TEST_KB, '', 'utf-8'); } catch { /* ok */ }

assert(await hasKbUrl('https://help.servicetitan.com/zapier', TEST_KB) === false, 'hasKbUrl returns false on empty file');

await appendKbArticle('Zapier', 'https://help.servicetitan.com/zapier-setup', 'Setting Up Zapier', 'Enable API access first.', TEST_KB);
const kb1 = await readFile(TEST_KB, 'utf-8');
assert(kb1.includes('## Zapier'), 'appendKbArticle creates integration section');
assert(kb1.includes('[kb,'), 'appendKbArticle writes [kb, ...] tag');
assert(kb1.includes('https://help.servicetitan.com/zapier-setup'), 'appendKbArticle writes URL');
assert(kb1.includes('Setting Up Zapier'), 'appendKbArticle writes title');
assert(kb1.includes('Enable API access first.'), 'appendKbArticle writes snippet');

assert(await hasKbUrl('https://help.servicetitan.com/zapier-setup', TEST_KB) === true, 'hasKbUrl returns true after write');

await appendKbArticle('Zapier', 'https://help.servicetitan.com/zapier-setup', 'Setting Up Zapier Again', 'Different snippet.', TEST_KB);
const kb2 = await readFile(TEST_KB, 'utf-8');
assert((kb2.match(/zapier-setup/g) ?? []).length === 1, 'appendKbArticle deduplicates by URL');

await appendBotResponse('Zapier', 'API access resets after migration', ['Re-enable via ST backend', 'Verify in admin panel'], ['Slack #ask-integrations'], TEST_KB);
const kb3 = await readFile(TEST_KB, 'utf-8');
assert(kb3.includes('[auto,'), 'appendBotResponse writes [auto, ...] tag');
assert(kb3.includes('API access resets after migration'), 'appendBotResponse writes issue title');
assert(kb3.includes('Re-enable via ST backend'), 'appendBotResponse includes steps');

assert(await hasIssueTitle('Zapier', 'API access resets after migration', TEST_KB) === true, 'hasIssueTitle returns true after write');

await appendBotResponse('Zapier', 'API access resets after migration', ['Different step'], [], TEST_KB);
const kb4 = await readFile(TEST_KB, 'utf-8');
assert((kb4.match(/API access resets after migration/g) ?? []).length === 1, 'appendBotResponse deduplicates by issue title within section');

await appendKbArticle('Angi', 'https://help.servicetitan.com/angi-setup', 'Angi Leads Setup', 'Check booking provider IDs.', TEST_KB);
const kb5 = await readFile(TEST_KB, 'utf-8');
assert(kb5.includes('## Angi'), 'appendKbArticle creates new section for unknown integration');
assert(kb5.includes('## Zapier'), 'appendKbArticle preserves existing sections');

try { await writeFile(TEST_KB, '', 'utf-8'); } catch { /* ok */ }
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
node test.js 2>&1 | tail -10
```

Expected: FAIL with "Cannot find module './src/slack/knowledge-writer.js'"

- [ ] **Step 3: Create `src/slack/knowledge-writer.js`**

```js
/**
 * Knowledge base writer.
 * Appends entries to data/knowledge.md with deduplication.
 *
 * Entry types:
 *   [kb, YYYY-MM-DD]   — auto-saved KB article from Google Custom Search
 *   [auto, YYYY-MM-DD] — moderator-approved bot response nomination
 *
 * All writes serialised via _writeQueue to prevent concurrent write races.
 * Slack alert sent to FEEDBACK_CHANNEL on every successful write.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
export const DEFAULT_KB_FILE = join(DATA_DIR, 'knowledge.md');
const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL || process.env.FEEDBACK_REVIEW_CHANNEL_ID || null;

let _writeQueue = Promise.resolve();

async function readKb(filePath = DEFAULT_KB_FILE) {
  try { return await readFile(filePath, 'utf-8'); } catch { return ''; }
}

async function writeKb(content, filePath = DEFAULT_KB_FILE) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function insertUnderSection(content, integration, line) {
  const sectionHeader = `## ${integration}`;
  const sectionIdx = content.indexOf(`\n${sectionHeader}`);

  if (sectionIdx !== -1) {
    const afterHeader = sectionIdx + sectionHeader.length + 1;
    const nextSectionIdx = content.indexOf('\n## ', afterHeader);
    const insertAt = nextSectionIdx !== -1 ? nextSectionIdx : content.length;
    const before = content.slice(0, insertAt).trimEnd();
    const after = content.slice(insertAt);
    return `${before}\n${line}${after}`;
  }

  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${sectionHeader}\n\n${line}\n`;
}

/**
 * Returns true if the given URL already appears anywhere in the KB file.
 */
export async function hasKbUrl(url, filePath = DEFAULT_KB_FILE) {
  return (await readKb(filePath)).includes(url);
}

/**
 * Returns true if an entry with the given issue title already exists
 * under the integration's section.
 */
export async function hasIssueTitle(integration, title, filePath = DEFAULT_KB_FILE) {
  const content = await readKb(filePath);
  const sectionRegex = new RegExp(`## ${escapeRegex(integration)}\\s*([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(sectionRegex);
  return match ? match[1].includes(title) : false;
}

/**
 * Appends a KB article entry. Deduplicates by URL.
 * @param {string} integration
 * @param {string} url
 * @param {string} title
 * @param {string} snippet
 * @param {string} [filePath]
 * @param {object} [client] - Slack WebClient for alert
 * @returns {Promise<boolean>} true if written, false if skipped
 */
export async function appendKbArticle(integration, url, title, snippet, filePath = DEFAULT_KB_FILE, client = null) {
  let written = false;
  _writeQueue = _writeQueue.then(async () => {
    if (await hasKbUrl(url, filePath)) return;
    const line = `- [kb, ${today()}] ${title} — ${url} — ${snippet}`;
    await writeKb(insertUnderSection(await readKb(filePath), integration, line), filePath);
    written = true;
    if (client && FEEDBACK_CHANNEL) {
      await client.chat.postMessage({ channel: FEEDBACK_CHANNEL, text: `📚 KB article auto-saved to knowledge.md: ${integration} — ${title}` })
        .catch((err) => console.warn('[knowledge-writer] Slack alert failed:', err.message));
    }
  }).catch((err) => {
    console.error('[knowledge-writer] appendKbArticle failed:', err.message);
    if (client && FEEDBACK_CHANNEL) {
      client.chat.postMessage({ channel: FEEDBACK_CHANNEL, text: `⚠️ knowledge.md write failed: ${integration} — ${title}. ${err.message}` }).catch(() => {});
    }
  });
  await _writeQueue;
  return written;
}

/**
 * Appends an approved bot-response entry. Deduplicates by issue title within section.
 * @param {string} integration
 * @param {string} issueTitle
 * @param {string[]} steps
 * @param {string[]} refs
 * @param {string} [filePath]
 * @param {object} [client] - Slack WebClient for alert
 * @returns {Promise<boolean>} true if written, false if skipped
 */
export async function appendBotResponse(integration, issueTitle, steps, refs, filePath = DEFAULT_KB_FILE, client = null) {
  let written = false;
  _writeQueue = _writeQueue.then(async () => {
    if (await hasIssueTitle(integration, issueTitle, filePath)) return;
    const refsText = refs.length > 0 ? ` Confirmed in ${refs.join(' + ')}.` : '';
    const line = `- [auto, ${today()}] ${issueTitle}: ${steps.join('; ')}.${refsText}`;
    await writeKb(insertUnderSection(await readKb(filePath), integration, line), filePath);
    written = true;
    if (client && FEEDBACK_CHANNEL) {
      await client.chat.postMessage({ channel: FEEDBACK_CHANNEL, text: `✅ Knowledge entry approved and saved: ${integration} — ${issueTitle}` })
        .catch((err) => console.warn('[knowledge-writer] Slack alert failed:', err.message));
    }
  }).catch((err) => {
    console.error('[knowledge-writer] appendBotResponse failed:', err.message);
    if (client && FEEDBACK_CHANNEL) {
      client.chat.postMessage({ channel: FEEDBACK_CHANNEL, text: `⚠️ knowledge.md write failed: ${integration} — ${issueTitle}. ${err.message}` }).catch(() => {});
    }
  });
  await _writeQueue;
  return written;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node test.js 2>&1 | grep -E "Knowledge Writer|✅|❌|Results:"
```

Expected: all Knowledge Writer assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/slack/knowledge-writer.js test.js
git commit -m "feat: add knowledge-writer module with appendKbArticle, appendBotResponse, dedup checks"
```

---

## Task 2: `src/slack/nominations.js`

**Files:**
- Create: `src/slack/nominations.js`
- Modify: `test.js`

- [ ] **Step 1: Add import and failing tests to `test.js`**

Add to the imports block at the top of `test.js`:

```js
import { buildNominationBlocks } from './src/slack/nominations.js';
```

Add after the Knowledge Writer test section (before the summary lines):

```js
// ── 15. Nominations ──────────────────────────────────────────────────────────
console.log('\n🔹 Nominations');

const nomRecord = {
  id: 'nom_test_001',
  timestamp: '2026-04-22T10:00:00.000Z',
  integration: 'Zapier',
  issueTitle: 'API access resets after tenant migration',
  steps: ['Re-enable via ST backend admin panel', 'Verify in admin portal'],
  refs: ['Slack #ask-integrations', 'Confluence Zapier guide'],
  proposedEntry: '- [auto, 2026-04-22] API access resets after tenant migration: Re-enable via ST backend admin panel; Verify in admin portal. Confirmed in Slack #ask-integrations + Confluence Zapier guide.',
};

const nomBlocks = buildNominationBlocks(nomRecord);

assert(Array.isArray(nomBlocks), 'buildNominationBlocks returns array');
assert(nomBlocks.length > 0, 'buildNominationBlocks returns non-empty array');

const hasTitle = nomBlocks.some(b =>
  (b.type === 'header' || b.type === 'section') && b.text?.text?.includes('Zapier')
);
assert(hasTitle, 'buildNominationBlocks includes integration name');

const hasEntry = nomBlocks.some(b => b.text?.text?.includes('API access resets after tenant migration'));
assert(hasEntry, 'buildNominationBlocks shows proposed entry text');

const actionsBlock = nomBlocks.find(b => b.type === 'actions');
assert(actionsBlock !== undefined, 'buildNominationBlocks has actions block');

const approveBtn = actionsBlock?.elements?.find(e => e.action_id === 'approve_nomination');
assert(approveBtn !== undefined, 'buildNominationBlocks has approve_nomination button');
assert(approveBtn?.style === 'primary', 'approve_nomination button has primary style');

const rejectBtn = actionsBlock?.elements?.find(e => e.action_id === 'reject_nomination');
assert(rejectBtn !== undefined, 'buildNominationBlocks has reject_nomination button');
assert(rejectBtn?.style === 'danger', 'reject_nomination button has danger style');

const approvePayload = JSON.parse(approveBtn.value);
assert(approvePayload.nominationId === 'nom_test_001', 'approve button value encodes nominationId');
const rejectPayload = JSON.parse(rejectBtn.value);
assert(rejectPayload.nominationId === 'nom_test_001', 'reject button value encodes nominationId');

const contextBlock = nomBlocks.find(b => b.type === 'context');
assert(contextBlock !== undefined, 'buildNominationBlocks has context footer');
assert(contextBlock.elements[0].text.includes('nom_test_001'), 'context footer includes nomination ID');
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
node test.js 2>&1 | tail -10
```

Expected: FAIL with "Cannot find module './src/slack/nominations.js'"

- [ ] **Step 3: Create `src/slack/nominations.js`**

```js
/**
 * Nomination system for bot-response knowledge entries.
 *
 * Flow:
 *   1. nominateResponse() posts to FEEDBACK_CHANNEL with Approve/Reject buttons.
 *   2. Moderator clicks Approve → approveNomination() writes to knowledge.md, posts confirmation.
 *   3. Moderator clicks Reject → rejectNomination() removes from pending, no write.
 *
 * Pending nominations are stored in-memory — they do not survive bot restarts.
 */

import { appendBotResponse } from './knowledge-writer.js';

const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL || process.env.FEEDBACK_REVIEW_CHANNEL_ID || null;

/** @type {Map<string, object>} nominationId → record */
const _pending = new Map();

/**
 * Builds Block Kit blocks for a nomination review card.
 * @param {object} record
 * @returns {Array}
 */
export function buildNominationBlocks(record) {
  const refsText = record.refs?.length > 0
    ? `*References:* ${record.refs.join(', ')}`
    : '_No references_';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📝 Knowledge Nomination — ${record.integration}*\n_${record.issueTitle}_`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Proposed entry:*\n\`\`\`${record.proposedEntry}\`\`\`` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: refsText },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve', emoji: true },
          action_id: 'approve_nomination',
          style: 'primary',
          value: JSON.stringify({ nominationId: record.id }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject', emoji: true },
          action_id: 'reject_nomination',
          style: 'danger',
          value: JSON.stringify({ nominationId: record.id }),
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${record.id} • ${record.timestamp}_` }],
    },
  ];
}

/**
 * Nominates a bot response for knowledge base inclusion.
 * Posts a review card to FEEDBACK_CHANNEL. No-op if channel not configured.
 * @param {object} client - Slack WebClient
 * @param {object} record - { integration, issueTitle, steps, refs }
 * @returns {Promise<object|null>}
 */
export async function nominateResponse(client, record) {
  if (!FEEDBACK_CHANNEL) {
    console.warn('[nominations] FEEDBACK_CHANNEL not set — nomination skipped.');
    return null;
  }

  const date = new Date().toISOString().slice(0, 10);
  const refsText = record.refs?.length > 0 ? ` Confirmed in ${record.refs.join(' + ')}.` : '';
  const proposedEntry = `- [auto, ${date}] ${record.issueTitle}: ${record.steps.join('; ')}.${refsText}`;

  const nomination = {
    id: `nom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    integration: record.integration,
    issueTitle: record.issueTitle,
    steps: record.steps,
    refs: record.refs ?? [],
    proposedEntry,
    reviewMessageTs: null,
    reviewChannelId: FEEDBACK_CHANNEL,
  };

  _pending.set(nomination.id, nomination);

  try {
    const msg = await client.chat.postMessage({
      channel: FEEDBACK_CHANNEL,
      text: `📝 Knowledge Nomination — ${record.integration}: ${record.issueTitle}`,
      blocks: buildNominationBlocks(nomination),
    });
    nomination.reviewMessageTs = msg.ts;
  } catch (err) {
    console.error('[nominations] Failed to post nomination card:', err.message);
    _pending.delete(nomination.id);
    return null;
  }

  return nomination;
}

/**
 * Approves a pending nomination — writes to knowledge.md, updates review card.
 * Idempotent: no-op if nomination not found.
 * @param {string} id
 * @param {object} client
 * @param {string} [reviewerName]
 * @returns {Promise<object|null>}
 */
export async function approveNomination(id, client, reviewerName = 'Moderator') {
  const record = _pending.get(id);
  if (!record) return null;
  _pending.delete(id);

  try {
    await appendBotResponse(record.integration, record.issueTitle, record.steps, record.refs, undefined, client);
  } catch (err) {
    console.error('[nominations] appendBotResponse failed during approve:', err.message);
  }

  if (record.reviewMessageTs && client) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `✅ Approved by ${reviewerName}`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ *Approved by ${reviewerName}*\n_${record.id} — ${record.integration}: ${record.issueTitle}_` },
      }],
    }).catch((err) => console.warn('[nominations] Failed to update review card:', err.message));
  }

  return record;
}

/**
 * Rejects a pending nomination — removes it without writing, updates review card.
 * Idempotent: no-op if nomination not found.
 * @param {string} id
 * @param {object} client
 * @param {string} [reviewerName]
 * @returns {Promise<object|null>}
 */
export async function rejectNomination(id, client, reviewerName = 'Moderator') {
  const record = _pending.get(id);
  if (!record) return null;
  _pending.delete(id);

  if (record.reviewMessageTs && client) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `❌ Rejected by ${reviewerName}`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `❌ *Rejected by ${reviewerName}*\n_${record.id} — ${record.integration}: ${record.issueTitle}_` },
      }],
    }).catch((err) => console.warn('[nominations] Failed to update review card:', err.message));
  }

  return record;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node test.js 2>&1 | grep -E "Nominations|✅|❌|Results:"
```

Expected: all Nominations assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/slack/nominations.js test.js
git commit -m "feat: add nominations module with buildNominationBlocks, nominateResponse, approve/rejectNomination"
```

---

## Task 3: Add `queryWithKnowledge` to `src/claude/query.js`

**Files:**
- Modify: `src/claude/query.js`

- [ ] **Step 1: Add `queryWithKnowledge` export after `queryChat`**

In `src/claude/query.js`, after the closing `}` of `queryChat` (after line 147), add:

```js
/**
 * Tier 2 fast-lookup — calls Claude with knowledge.md content only, no MCP servers.
 * Used in mention.js before the full MCP search.
 * Falls through (caller checks) if result has clarifying_question or confidence === 'low'.
 *
 * @param {string} userQuery
 * @param {string} knowledgeContent - Full contents of knowledge.md
 * @param {{ role?: string, agentName?: string|null }} [options]
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithKnowledge(userQuery, knowledgeContent, { role = 'csa', agentName = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const userContent = `Issue: ${userQuery}\n\n[TEAM KNOWLEDGE]\n${knowledgeContent}\n[/TEAM KNOWLEDGE]`;
  const basePrompt = role === 'specialist' ? SYSTEM_PROMPT_SPECIALIST : SYSTEM_PROMPT_CSA;
  const systemPrompt = agentName
    ? `${basePrompt}\n\nThe agent's display name is: ${agentName}. Use this name in intro_message.`
    : basePrompt;

  let fullText = '';
  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      // No mcp_servers — fast path, no tool calls
      betas: ['mcp-client-2025-04-04'],
    }, { signal: controller.signal });

    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Knowledge fast-lookup timed out after ${Math.round(TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return parseClaudeResponse(fullText);
}
```

- [ ] **Step 2: Run tests**

```bash
node test.js 2>&1 | tail -5
```

Expected: no regressions, same count as before.

- [ ] **Step 3: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: add queryWithKnowledge for Tier 2 fast-lookup (no MCP servers)"
```

---

## Task 4: KB auto-save in `src/claude/query.js`

**Files:**
- Modify: `src/claude/query.js`

- [ ] **Step 1: Add import for `appendKbArticle`**

At the top of `src/claude/query.js`, after the existing imports (after line 4), add:

```js
import { appendKbArticle } from '../slack/knowledge-writer.js';
```

- [ ] **Step 2: Add auto-save trigger after `parseClaudeResponse`**

Find this block in `queryWithContext` (currently around lines 100–103):

```js
  const result = parseClaudeResponse(fullText);
  if (kbResult?.refs?.length > 0) result.kb_refs = kbResult.refs;
  return result;
```

Replace with:

```js
  const result = parseClaudeResponse(fullText);
  if (kbResult?.refs?.length > 0) {
    result.kb_refs = kbResult.refs;
    // Auto-save KB articles using the integration_type we now have from Claude's response
    const integration = result.integration_type || 'General';
    for (const ref of kbResult.refs) {
      appendKbArticle(integration, ref.url, ref.title, ref.snippet ?? '').catch((err) => {
        console.warn('[query] KB auto-save failed for', ref.url, ':', err.message);
      });
    }
  }
  return result;
```

- [ ] **Step 3: Run tests**

```bash
node test.js 2>&1 | tail -5
```

Expected: no regressions (`searchKnowledgeBase` returns null in tests because `GOOGLE_CSE_API_KEY` is unset, so the auto-save block never fires).

- [ ] **Step 4: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: auto-save KB article refs to knowledge.md after searchKnowledgeBase() returns results"
```

---

## Task 5: Update system prompts in `src/claude/prompts.js`

**Files:**
- Modify: `src/claude/prompts.js`

- [ ] **Step 1: Update `SYSTEM_PROMPT_CSA`**

Find this text in `SYSTEM_PROMPT_CSA` (around line 190):

```
A [TEAM KNOWLEDGE] block may also be present — treat it as authoritative.
A [KB RESULTS] block may also be present — treat it as authoritative.
```

Replace with:

```
A [TEAM KNOWLEDGE] block may also be present — treat it as authoritative. If [TEAM KNOWLEDGE] contains a specific, matching entry for this integration AND this symptom — answer from it immediately. Do not run Phase 1 searches.
A [KB RESULTS] block may also be present — treat it as authoritative.
```

- [ ] **Step 2: Update `SYSTEM_PROMPT_SPECIALIST`**

Find this text in `SYSTEM_PROMPT_SPECIALIST` (around line 360):

```
A [TEAM KNOWLEDGE] block may be present — treat it as authoritative.
A [KB RESULTS] block may be present — treat it as authoritative.
```

Replace with:

```
A [TEAM KNOWLEDGE] block may be present — treat it as authoritative. If [TEAM KNOWLEDGE] contains a specific, matching entry for this integration AND this symptom — answer from it immediately. Do not run Phase 1 searches.
A [KB RESULTS] block may be present — treat it as authoritative.
```

- [ ] **Step 3: Run tests**

```bash
node test.js 2>&1 | tail -5
```

Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: instruct Claude to answer from [TEAM KNOWLEDGE] immediately when a specific match exists"
```

---

## Task 6: Tier 2 fast-lookup + nomination check in `src/handlers/mention.js`

**Files:**
- Modify: `src/handlers/mention.js`

- [ ] **Step 1: Add imports**

At the top of `src/handlers/mention.js`, after the existing imports, add:

```js
import { queryWithKnowledge } from '../claude/query.js';
import { nominateResponse } from '../slack/nominations.js';
```

- [ ] **Step 2: Add Step 2.5 — Tier 2 fast-lookup**

In `handleQuery`, find the cache check block ending with `return;` (the block starting with `// 2. Check cache`). After that `return;` and before `// 3.` (the role detection comment), insert:

```js
  // 2.5 — Tier 2: knowledge.md fast-lookup (no MCP, answer from stored knowledge)
  try {
    const knowledge = await getKnowledge();
    if (knowledge) {
      let fastResult = null;
      try {
        fastResult = await queryWithKnowledge(query, knowledge, { role, agentName });
      } catch (err) {
        console.warn('[mention] Knowledge fast-lookup failed, falling through:', err.message);
      }

      if (fastResult && !fastResult.clarifying_question && fastResult.confidence !== 'low') {
        console.info(`[query] knowledge-hit confidence=${fastResult.confidence ?? 'unknown'} integration=${(fastResult.integration_type ?? 'unknown').slice(0, 50)}`);

        fastResult._originalQuery = query;
        if (role === 'csa') {
          fastResult._showSpecialistValue = JSON.stringify({ threadTs, channelId, query: query.slice(0, 800) });
        }

        const targetTs = thinkingTs ?? null;
        if (targetTs) {
          await client.chat.update({
            channel: channelId,
            ts: targetTs,
            blocks: buildResponseBlocks(fastResult),
            text: `Troubleshooting steps for: ${fastResult.issue_title}`,
          });
        } else {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            blocks: buildResponseBlocks(fastResult),
            text: `Troubleshooting steps for: ${fastResult.issue_title}`,
          });
        }

        appendToHistory(threadTs, [
          { role: 'user', content: query },
          { role: 'assistant', content: summarizeResultForHistory(fastResult) },
        ]);

        return;
      }
      // Low confidence or clarifying question — fall through to full MCP search
    }
  } catch (err) {
    console.warn('[mention] Step 2.5 unexpected error, continuing to full search:', err.message);
  }
```

Note: `role` and `agentName` are not yet resolved at this point in the function. Look at where `role` is first set in the function. If it's set after Step 2 (cache check), move the fast-lookup after `role` and `agentName` are known. Check `mention.js` carefully and place this block after both `role` and `agentName` are resolved.

- [ ] **Step 3: Add nomination check after result**

Find the `appendToHistory` call near the end of `handleQuery` (the final one, after the full MCP result is served). After it, add:

```js
  // Nomination check — nominate high-quality bot responses for knowledge base
  const KNOWLEDGE_MIN_MS = parseInt(process.env.KNOWLEDGE_MIN_MS ?? '30000', 10);
  const hasRefs = (result.slack_refs?.length > 0) || (result.atlassian_refs?.length > 0);
  const noEscalation = result.escalate_decision?.should_escalate !== true;
  const hasSteps = (result.agent_steps?.length ?? 0) > 0;

  if (
    (Date.now() - _queryStart) >= KNOWLEDGE_MIN_MS &&
    hasRefs &&
    noEscalation &&
    hasSteps &&
    !result.clarifying_question
  ) {
    const steps = (result.agent_steps ?? []).map((s) => `${s.title}: ${s.detail}`.slice(0, 200));
    const refs = [
      ...(result.slack_refs ?? []).slice(0, 2).map((r) => `Slack ${r.channel ?? ''} ${r.title ?? ''}`.trim()),
      ...(result.atlassian_refs ?? []).slice(0, 2).map((r) => `${r.type ?? 'Atlassian'}: ${r.title ?? ''}`.trim()),
    ].filter(Boolean);

    nominateResponse(client, {
      integration: result.integration_type ?? 'General',
      issueTitle: result.issue_title ?? query.slice(0, 80),
      steps,
      refs,
    }).catch((err) => console.warn('[mention] nominateResponse failed (non-critical):', err.message));
  }
```

- [ ] **Step 4: Run tests**

```bash
node test.js 2>&1 | tail -5
```

Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/mention.js
git commit -m "feat: add Tier 2 knowledge fast-lookup (Step 2.5) and nomination check after result"
```

---

## Task 7: Register action handlers in `src/index.js`

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add import**

After the feedback.js import line in `src/index.js`, add:

```js
import { approveNomination, rejectNomination } from './slack/nominations.js';
```

- [ ] **Step 2: Add `approve_nomination` handler**

After the `reject_feedback` handler block, add:

```js
// ── Approve nomination ────────────────────────────────────────────────────────
app.action('approve_nomination', async ({ ack, body, client, action }) => {
  await ack();
  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  const { nominationId } = payload;
  if (!nominationId) return;

  let reviewerName = body.user.name;
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch { /* use fallback */ }

  const record = await approveNomination(nominationId, client, reviewerName);
  if (!record) return;
  app.logger.info(`[nominations] ${nominationId} approved by ${reviewerName} (${record.integration}: ${record.issueTitle})`);
});

// ── Reject nomination ─────────────────────────────────────────────────────────
app.action('reject_nomination', async ({ ack, body, client, action }) => {
  await ack();
  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  const { nominationId } = payload;
  if (!nominationId) return;

  let reviewerName = body.user.name;
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch { /* use fallback */ }

  const record = await rejectNomination(nominationId, client, reviewerName);
  if (!record) return;
  app.logger.info(`[nominations] ${nominationId} rejected by ${reviewerName}`);
});
```

- [ ] **Step 3: Run tests**

```bash
node test.js 2>&1 | tail -5
```

Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: register approve_nomination and reject_nomination action handlers"
```

---

## Task 8: Final verification

**Files:** none (read-only checks)

- [ ] **Step 1: Full test suite**

```bash
node test.js
```

Expected: all tests pass with higher count than before (new Knowledge Writer + Nominations sections).

- [ ] **Step 2: Grep checks**

```bash
grep -n "queryWithKnowledge" src/claude/query.js src/handlers/mention.js
grep -n "appendKbArticle\|appendBotResponse\|hasKbUrl\|hasIssueTitle" src/slack/knowledge-writer.js
grep -n "nominateResponse\|approveNomination\|rejectNomination" src/slack/nominations.js src/index.js src/handlers/mention.js
grep -n "approve_nomination\|reject_nomination" src/index.js src/slack/nominations.js
grep -n "answer from it immediately" src/claude/prompts.js
grep -n "knowledge-hit" src/handlers/mention.js
```

All must return matches.

- [ ] **Step 3: Commit if any cleanup needed, then done**

```bash
git log --oneline -8
```
