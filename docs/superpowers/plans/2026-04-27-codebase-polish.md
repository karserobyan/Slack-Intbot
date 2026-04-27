# Codebase Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full professional sweep — park routing buttons, fix step numbering, resolve Promise anti-patterns, standardise comment style, update stale docs and config.

**Architecture:** Pure refactor and cleanup — no behaviour changes to running bot. Each task is self-contained and independently committable.

**Tech Stack:** Node.js ESM, @slack/bolt v4, @anthropic-ai/sdk

---

## File Map

| File | Change |
|---|---|
| `src/slack/routing-buttons.js` | **Create** — parked routing-buttons feature, ready to re-enable |
| `src/slack/blocks.js` | Remove `buildRoutingButtons` (moved) |
| `src/handlers/dm.js` | Stage uncommitted cleanup (dead imports gone) |
| `src/handlers/mention.js` | Stage uncommitted cleanup (dead import gone) + fix step numbering + rename `_queryStart` |
| `src/claude/prompts.js` | Move `summarizeResultForHistory` to end of file; fix orphaned JSDoc |
| `src/slack/feedback.js` | Arrow function parens consistency |
| `src/slack/knowledge-writer.js` | Fix Promise deferred anti-pattern in both write functions |
| `src/index.js` | Standardise section banner widths to 80 chars |
| `.env.example` | Document `FEEDBACK_CHANNEL` env var |
| `.gitignore` | Add standard Node.js exclusions |
| `README.md` | Update project structure, response JSON, env vars table |

---

## Task 1 — Park routing buttons

**Files:**
- Create: `src/slack/routing-buttons.js`
- Modify: `src/slack/blocks.js` (remove `buildRoutingButtons`)

- [ ] **Step 1: Create `src/slack/routing-buttons.js`**

```js
/**
 * PARKED FEATURE — Routing buttons for the DM entry point.
 *
 * Re-enable by:
 *   1. In dm.js — import { registerDmHandlerWithRouting } from '../slack/routing-buttons.js'
 *      and call registerDmHandlerWithRouting(app) instead of registerDmHandler(app).
 *   2. Confirm index.js still registers action handlers for
 *      'integration_question' and 'log_request' (they are present by default).
 */

import { hasHistory } from './conversation.js';
import { handleQuery } from '../handlers/mention.js';

/**
 * Builds the routing prompt shown to agents on first DM contact.
 * Two options: Integration Question (→ handleQuery) or Log Request (→ audit modal).
 *
 * @param {{ query: string, channelId: string, threadTs: string, userId: string, isDm?: boolean }} params
 * @returns {Array} Slack blocks array
 */
export function buildRoutingButtons({ query, channelId, threadTs, userId, isDm = false }) {
  const value = JSON.stringify({
    query:     (query ?? '').slice(0, 1800),
    channelId,
    threadTs,
    userId,
    isDm,
  });
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*What kind of help do you need?*' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔌 Integration Question', emoji: true },
          action_id: 'integration_question',
          value,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Log Request', emoji: true },
          action_id: 'log_request',
          value,
        },
      ],
    },
  ];
}

/**
 * DM handler variant that presents routing buttons on first contact.
 * Drop-in replacement for registerDmHandler in dm.js.
 *
 * @param {import('@slack/bolt').App} app
 */
export function registerDmHandlerWithRouting(app) {
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

    const threadTs = message.thread_ts ?? message.ts;
    const text     = (message.text ?? '').toLowerCase().trim();
    const isHelp   = text === 'help' || text === 'help detail';

    try {
      if (isHelp || hasHistory(threadTs)) {
        await handleQuery({
          rawText:   message.text ?? '',
          channelId: message.channel,
          threadTs,
          client,
          userId:    message.user,
          isDm:      true,
        });
      } else {
        try {
          await client.chat.postMessage({
            channel:   message.channel,
            thread_ts: threadTs,
            blocks:    buildRoutingButtons({
              query:     message.text ?? '',
              channelId: message.channel,
              threadTs,
              userId:    message.user,
              isDm:      true,
            }),
            text: 'What kind of help do you need?',
          });
        } catch (err) {
          logger.error('[dm] Failed to post routing buttons:', err.message);
          await client.chat.postMessage({
            channel: message.channel,
            text:    'Something went wrong — please retry.',
          }).catch(() => {});
        }
      }
    } finally {
      setTimeout(() => _inFlight.delete(message.ts), 60_000);
    }
  });
}
```

- [ ] **Step 2: Remove `buildRoutingButtons` from `src/slack/blocks.js`**

Delete lines 464–495 (the `buildRoutingButtons` export). The function has no remaining callers.

- [ ] **Step 3: Verify no remaining imports of `buildRoutingButtons` from blocks.js**

```bash
grep -r "buildRoutingButtons" src/
```

Expected: zero results (the function lives in `routing-buttons.js` only now).

- [ ] **Step 4: Commit**

```bash
git add src/slack/routing-buttons.js src/slack/blocks.js
git commit -m "refactor: park routing-buttons feature in dedicated module"
```

---

## Task 2 — Stage and commit uncommitted handler changes

**Files:**
- Modify: `src/handlers/dm.js`
- Modify: `src/handlers/mention.js`

- [ ] **Step 1: Verify current working-tree state of dm.js**

The file should have no imports of `hasHistory` or `buildRoutingButtons`. Confirm:

```bash
head -5 src/handlers/dm.js
```

Expected first line: `import { handleQuery } from './mention.js';` with no other imports.

- [ ] **Step 2: Verify current working-tree state of mention.js**

```bash
grep "buildRoutingButtons" src/handlers/mention.js
```

Expected: no output.

- [ ] **Step 3: Stage and commit both files**

```bash
git add src/handlers/dm.js src/handlers/mention.js
git commit -m "refactor: remove routing-buttons from dm and mention handlers"
```

---

## Task 3 — Fix mention.js step numbering and naming

**Files:**
- Modify: `src/handlers/mention.js`

- [ ] **Step 1: Replace step comments in `handleQuery`**

In `src/handlers/mention.js`, replace all inline step comments inside `handleQuery` with a clean sequential numbering that matches the actual execution order:

| Old | New |
|---|---|
| `// Rate limit — prevent a single user from spamming Claude calls` | `// 2. Rate limit — prevent spam` |
| `// 1. Fast-path: accounting redirect (no Claude needed)` | `// 3. Fast-path: accounting redirect (keyword match, no Claude)` |
| `// 1c. Help command — "@bot help"...` | `// 4. Help command — all roles, bypasses history check` |
| `// 1b. Follow-up path — thread has prior history, use conversational mode` | `// 5. Follow-up: active thread history → conversational mode` |
| `// 2. Check cache` | `// 6. Cache lookup` |
| `// 3. Detect role + post thinking placeholder in parallel (zero latency cost)` | `// 7. Role detection + thinking placeholder (parallel, zero latency)` |
| `// 2.5 — Tier 2: knowledge.md fast-lookup (no MCP, answer from stored knowledge)` | `// 8. Tier 2: knowledge.md fast-lookup (no MCP, no cache miss)` |
| `// 4. Look up past corrections to inject as context` | `// 9. Feedback corrections context` |
| `// 5. Call Claude with gathered context` | `// 10. Full Claude query (MCP search — slowest path)` |
| `// 6. Attach original query for the feedback button, then cache` | `// 11. Attach query metadata + conditionally cache result` |
| `// 7. If Claude itself decided it was an accounting topic (double-check via AI)` | `// 12. Accounting redirect from AI (double-check)` |
| `// 8a. If Claude needs clarification before answering fully — post question and wait` | `// 13. Clarifying question from AI` |
| `// 8. Update the thinking placeholder with the real response` | `// 14. Deliver response` |
| `// Save initial exchange to conversation history...` | `// 15. Seed conversation history` |
| `// Nomination check — nominate high-quality bot responses for knowledge base` | `// 16. Nominate for knowledge base` |

Also add `// 1. Empty query — greet and return early` above the empty query check (currently has no comment).

- [ ] **Step 2: Rename `_queryStart` to `queryStart`**

Two occurrences in `handleQuery`:
```js
// Before
const _queryStart = Date.now();
// ...
if (!result.clarifying_question && (Date.now() - _queryStart) >= CACHE_MIN_MS) setCached(query, result);
// ...
const KNOWLEDGE_MIN_MS = parseInt(process.env.KNOWLEDGE_MIN_MS ?? '30000', 10);
// ...
if ((Date.now() - _queryStart) >= KNOWLEDGE_MIN_MS && ...
```

```js
// After
const queryStart = Date.now();
// ...
if (!result.clarifying_question && (Date.now() - queryStart) >= CACHE_MIN_MS) setCached(query, result);
// ...
if ((Date.now() - queryStart) >= KNOWLEDGE_MIN_MS && ...
```

- [ ] **Step 3: Remove redundant JSDoc on `handleQuery`**

Replace the multi-line JSDoc block above `handleQuery` with a single-line comment:

```js
// Core query handler — shared by mention.js and dm.js.
export async function handleQuery({ rawText, channelId, threadTs, client, userId, isDm = false }) {
```

- [ ] **Step 4: Commit**

```bash
git add src/handlers/mention.js
git commit -m "refactor: clean step numbering, rename _queryStart, trim JSDoc in mention.js"
```

---

## Task 4 — Fix prompts.js structure

**Files:**
- Modify: `src/claude/prompts.js`

- [ ] **Step 1: Move `summarizeResultForHistory` to end of file**

The function currently sits between `SYSTEM_PROMPT_CSA` (ends ~line 291) and `SYSTEM_PROMPT_SPECIALIST` (starts ~line 354), which makes no logical sense. Move it to after `parseAuditResponse` at the very end of the file.

Also remove the orphaned JSDoc comment that says `"System prompt for Specialist mode."` which currently sits directly above `summarizeResultForHistory` instead of above `SYSTEM_PROMPT_SPECIALIST`.

The correct file order after the change:
1. `CHAT_SYSTEM_PROMPT`
2. `parseClaudeResponse`
3. `SHARED_RULES`
4. `SYSTEM_PROMPT_CSA`
5. `SYSTEM_PROMPT_SPECIALIST` (with its JSDoc directly above it)
6. `AUDIT_LOG_PROMPT`
7. `parseAuditResponse`
8. `summarizeResultForHistory` ← moved here

- [ ] **Step 2: Verify imports still resolve**

```bash
grep -n "summarizeResultForHistory" src/handlers/mention.js src/claude/prompts.js
```

Expected: import in mention.js, export in prompts.js — both present.

- [ ] **Step 3: Commit**

```bash
git add src/claude/prompts.js
git commit -m "refactor: move summarizeResultForHistory to end of prompts.js, fix orphaned JSDoc"
```

---

## Task 5 — Fix feedback.js arrow function style

**Files:**
- Modify: `src/slack/feedback.js`

- [ ] **Step 1: Add parens to bare arrow function parameters**

Three occurrences of `findIndex(e =>` — replace all with `findIndex((e) =>`:

```js
// Before (appears 3 times in approveFeedback, rejectFeedback, notifyFeedbackChannel)
pending.findIndex(e => e.id === id)
pending.findIndex(e => e.id === record.id)

// After
pending.findIndex((e) => e.id === id)
pending.findIndex((e) => e.id === record.id)
```

- [ ] **Step 2: Commit**

```bash
git add src/slack/feedback.js
git commit -m "style: add parens to arrow function params in feedback.js"
```

---

## Task 6 — Fix knowledge-writer.js Promise anti-pattern

**Files:**
- Modify: `src/slack/knowledge-writer.js`

- [ ] **Step 1: Refactor `appendKbArticle`**

Replace the `let resolve; const result = new Promise(...)` deferred pattern with a clean Promise constructor:

```js
export async function appendKbArticle(integration, url, title, snippet, filePath = DEFAULT_KB_FILE, client = null) {
  return new Promise((resolve) => {
    _writeQueue = _writeQueue
      .then(async () => {
        if (await hasKbUrl(url, filePath)) { resolve(false); return; }
        const line = `- [kb, ${today()}] ${title} — ${url} — ${snippet}`;
        await writeKb(insertUnderSection(await readKb(filePath), integration, line), filePath);
        resolve(true);
        clearKnowledgeCache();
        if (client && FEEDBACK_CHANNEL) {
          await client.chat.postMessage({
            channel: FEEDBACK_CHANNEL,
            text: `📚 KB article auto-saved to knowledge.md: ${integration} — ${title}`,
          }).catch((err) => console.warn('[knowledge-writer] Slack alert failed:', err.message));
        }
      })
      .catch((err) => {
        console.error('[knowledge-writer] appendKbArticle failed:', err.message);
        resolve(false);
        if (client && FEEDBACK_CHANNEL) {
          client.chat.postMessage({
            channel: FEEDBACK_CHANNEL,
            text: `⚠️ knowledge.md write failed: ${integration} — ${title}. ${err.message}`,
          }).catch(() => {});
        }
      });
  });
}
```

- [ ] **Step 2: Refactor `appendBotResponse` the same way**

```js
export async function appendBotResponse(integration, issueTitle, steps, refs, filePath = DEFAULT_KB_FILE, client = null) {
  return new Promise((resolve) => {
    _writeQueue = _writeQueue
      .then(async () => {
        if (await hasIssueTitle(integration, issueTitle, filePath)) { resolve(false); return; }
        const refsText = refs.length > 0 ? ` Confirmed in ${refs.join(' + ')}.` : '';
        const line = `- [auto, ${today()}] ${issueTitle}: ${steps.join('; ')}.${refsText}`;
        await writeKb(insertUnderSection(await readKb(filePath), integration, line), filePath);
        resolve(true);
        clearKnowledgeCache();
        if (client && FEEDBACK_CHANNEL) {
          await client.chat.postMessage({
            channel: FEEDBACK_CHANNEL,
            text: `✅ Knowledge entry approved and saved: ${integration} — ${issueTitle}`,
          }).catch((err) => console.warn('[knowledge-writer] Slack alert failed:', err.message));
        }
      })
      .catch((err) => {
        console.error('[knowledge-writer] appendBotResponse failed:', err.message);
        resolve(false);
        if (client && FEEDBACK_CHANNEL) {
          client.chat.postMessage({
            channel: FEEDBACK_CHANNEL,
            text: `⚠️ knowledge.md write failed: ${integration} — ${issueTitle}. ${err.message}`,
          }).catch(() => {});
        }
      });
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/slack/knowledge-writer.js
git commit -m "refactor: replace deferred Promise anti-pattern in knowledge-writer.js"
```

---

## Task 7 — Standardise index.js section banners

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Normalise all section banners to exactly 80 chars**

All `// ── Title ─────` banners should be padded to exactly 80 characters. The short ones are:

```js
// Before
// ── "Show Specialist Detail" button ──────────────────────────────────────
// ── Approve feedback ──────────────────────────────────────────────────────
// ── Reject feedback ───────────────────────────────────────────────────────

// After
// ── "Show Specialist Detail" button ──────────────────────────────────────────
// ── Approve feedback ──────────────────────────────────────────────────────────
// ── Reject feedback ───────────────────────────────────────────────────────────
```

- [ ] **Step 2: Commit**

```bash
git add src/index.js
git commit -m "style: normalise section banner widths in index.js"
```

---

## Task 8 — Config and environment cleanup

**Files:**
- Modify: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Add `FEEDBACK_CHANNEL` to `.env.example`**

Add this block under the `FEEDBACK_REVIEW_CHANNEL_ID` entry:

```bash
# Internal alias used by knowledge-writer.js and nominations.js to post
# KB auto-save alerts and nomination review cards.
# Defaults to FEEDBACK_REVIEW_CHANNEL_ID if not set separately.
# FEEDBACK_CHANNEL=
```

- [ ] **Step 2: Extend `.gitignore`**

Add after the existing entries:

```
*.log
npm-debug.log*
.DS_Store
*.local
```

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: document FEEDBACK_CHANNEL in .env.example; extend .gitignore"
```

---

## Task 9 — Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update project structure diagram**

Replace the stale 6-file structure with the current 16-file layout:

```
src/
├── index.js                     # Bolt app startup, all action/view handlers
├── handlers/
│   ├── mention.js               # @mention handler + shared handleQuery()
│   └── dm.js                    # Direct message handler
├── claude/
│   ├── query.js                 # Claude API — queryWithContext, queryChat, queryAuditLog
│   ├── prompts.js               # System prompts (CSA, Specialist, Chat, Audit) + parsers
│   └── kb-search.js             # Google Custom Search KB lookup
├── slack/
│   ├── blocks.js                # Block Kit builders (response, audit, modals, error)
│   ├── cache.js                 # In-memory LRU response cache with TTL
│   ├── conversation.js          # Per-thread history store for follow-up mode
│   ├── feedback.js              # Wrong Answer feedback queue + moderation
│   ├── knowledge.js             # knowledge.md loader with 5-min cache
│   ├── knowledge-writer.js      # knowledge.md append with deduplication
│   ├── modal.js                 # Audit log modal builder
│   ├── nominations.js           # Bot-response nomination system
│   └── routing-buttons.js       # PARKED: routing buttons for DM entry point
└── utils/
    ├── accounting-filter.js     # Keyword-based accounting topic detection
    └── rate-limiter.js          # Per-user rate limiter
scripts/
└── get-es-token.js              # One-time OAuth helper for ES MCP token
```

- [ ] **Step 2: Update response structure JSON**

Replace the stale JSON example (which references `customer_email`) with the current format:

```json
{
  "issue_title": "Zapier API Access Not Enabled",
  "integration_type": "Zapier",
  "is_accounting_topic": false,
  "confidence": "high",
  "customer_message": "Hey [Name], I can see the issue — Zapier API access hasn't been enabled for your tenant yet. I'm getting that sorted now and will update you as soon as it's live.",
  "escalate_decision": {
    "should_escalate": false,
    "reason": "CSA can resolve with a backend enable — no specialist needed",
    "escalation_path": null
  },
  "channel_recommendation": {
    "channel": "ks-integration",
    "reason": "Known fix, 1-step resolution, no escalation needed"
  },
  "agent_steps": [
    {
      "num": 1,
      "title": "Enable Zapier API access on the tenant",
      "detail": "In the ST Admin portal, locate the tenant and enable Zapier API access under the Integrations tab.",
      "tag": "backend"
    },
    {
      "num": 2,
      "title": "Verify the connection",
      "detail": "Ask the customer to re-authenticate in Zapier. Confirm the trigger fires successfully.",
      "tag": "verify"
    }
  ],
  "findings_summary": {
    "diagnosis": "Zapier cannot authenticate because API access was never enabled on the tenant.",
    "actions": ["Enable Zapier API access", "Re-authenticate in Zapier"]
  },
  "slack_refs": [
    { "url": "https://servicetitan.slack.com/archives/...", "channel": "#ask-integrations", "title": "Zapier API access — enable steps" }
  ],
  "atlassian_refs": [
    { "type": "confluence", "url": "https://...", "title": "Zapier Integration Setup Guide" }
  ],
  "kb_refs": [
    { "url": "https://help.servicetitan.com/...", "title": "Connecting Zapier to ServiceTitan", "snippet": "To connect Zapier, API access must first be enabled..." }
  ],
  "sources_used": ["slack", "confluence", "kb"]
}
```

- [ ] **Step 3: Update environment variables table**

Replace the stale 9-row table with the current complete set:

```markdown
| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✅ | Bot token (`xoxb-...`) from OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | ✅ | From Basic Information |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key |
| `SLACK_APP_TOKEN` | Socket Mode only | App-level token (`xapp-...`) |
| `ATLASSIAN_MCP_TOKEN` | Recommended | Atlassian API token for Confluence/Jira MCP search |
| `SLACK_USER_TOKEN` | Recommended | User token (`xoxp-...`) for Slack MCP history search |
| `GOOGLE_CSE_API_KEY` | Recommended | Google API key for KB search |
| `GOOGLE_CSE_ID` | Recommended | Custom Search Engine ID (scoped to help.servicetitan.com) |
| `ES_MCP_URL` | Optional | Elasticsearch MCP server URL for audit log queries |
| `ES_MCP_TOKEN` | Optional | Bearer token for the ES MCP server |
| `FEEDBACK_REVIEW_CHANNEL_ID` | Optional | Channel for feedback and nomination review cards |
| `FEEDBACK_CHANNEL` | Optional | Alias for `FEEDBACK_REVIEW_CHANNEL_ID` (used internally) |
| `ANTHROPIC_MODEL` | Optional | Override Claude model (default: `claude-sonnet-4-20250514`) |
| `CLAUDE_TIMEOUT_MS` | Optional | API timeout in ms (default: `90000`) |
| `CACHE_TTL_MS` | Optional | Response cache TTL in ms (default: `3600000` = 1 hour) |
| `RATE_LIMIT_MAX` | Optional | Max requests per user per window (default: `5`) |
| `RATE_LIMIT_WINDOW_MS` | Optional | Rate limit window in ms (default: `60000` = 1 min) |
| `PORT` | Optional | HTTP port when not using Socket Mode (default: `3000`) |
| `LOG_LEVEL` | Optional | `info` or `debug` |
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README — structure, response schema, env vars"
```

---

## Task 10 — Update memory snapshot

- [ ] **Step 1: Update project memory with current architecture**

Save a comprehensive memory snapshot to `C:\Users\kserobyan\.claude\projects\C--Users-kserobyan-Slack-Intbot\memory\project_overview.md` reflecting all 16 source files, the parked routing-buttons module, and the current env var set.

- [ ] **Step 2: Commit plan doc**

```bash
git add docs/superpowers/plans/2026-04-27-codebase-polish.md
git commit -m "docs: add codebase polish implementation plan"
```
