# Near-Term Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four targeted improvements — clarifying-question cache bug fix, confidence logging, accounting check order fix, and a role-gated help command.

**Architecture:** All changes are confined to three files: `src/slack/blocks.js` (new help block builders), `src/handlers/mention.js` (handler reorder, cache guard, logging, help handler, `isDm` param), and `src/handlers/dm.js` (pass `isDm: true`). Tests for new blocks live in `test.js`. Handler changes are verified by existing tests + runtime.

**Tech Stack:** Node.js ESM, `@slack/bolt` v4, Block Kit

---

## File Map

| File | Change |
|------|--------|
| `src/slack/blocks.js` | Add `buildHelpBlocks()` and `buildHelpDetailBlocks()` |
| `src/handlers/mention.js` | Add `isDm` param; move accounting check; add help handler; fix cache guard; add confidence log lines |
| `src/handlers/dm.js` | Pass `isDm: true` to `handleQuery` |
| `test.js` | Import + test new help block builders |

---

## Task 1: Add help block builders to `src/slack/blocks.js` (TDD)

**Files:**
- Modify: `test.js`
- Modify: `src/slack/blocks.js`

- [ ] **Step 1: Add `buildHelpBlocks` and `buildHelpDetailBlocks` to the import in `test.js`**

In `test.js`, find:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
} from './src/slack/blocks.js';
```

Replace with:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
} from './src/slack/blocks.js';
```

- [ ] **Step 2: Add failing tests for `buildHelpBlocks` and `buildHelpDetailBlocks` in `test.js`**

Add a new section at the end of `test.js`, just before the `── Summary ──` block:

```js
// ── 10. Help Blocks ───────────────────────────────────────────────────────────
console.log('\n🔹 Help Blocks');

const helpBlocks = buildHelpBlocks();
assert(Array.isArray(helpBlocks), 'buildHelpBlocks returns array');
assert(helpBlocks.length > 0, 'buildHelpBlocks returns non-empty array');
assert(helpBlocks[0].type === 'header', 'buildHelpBlocks first block is header');
assert(helpBlocks[0].text.text.includes('IntegrationsBot'), 'help header mentions IntegrationsBot');
assert(helpBlocks.some(b => b.text?.text?.includes('Zapier')), 'help blocks mention Zapier');
assert(helpBlocks.some(b => b.text?.text?.includes('accounting')), 'help blocks mention accounting exclusion');
assert(helpBlocks.some(b => b.type === 'context'), 'help blocks have context footer');
assert(helpBlocks.every(b => b.type === 'header' || b.type === 'section' || b.type === 'context'), 'help blocks contain only valid block types');

const helpDetailBlocks = buildHelpDetailBlocks();
assert(Array.isArray(helpDetailBlocks), 'buildHelpDetailBlocks returns array');
assert(helpDetailBlocks.length > 0, 'buildHelpDetailBlocks returns non-empty array');
assert(helpDetailBlocks[0].type === 'header', 'buildHelpDetailBlocks first block is header');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('confidence')), 'detail blocks explain confidence levels');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('Wrong Answer')), 'detail blocks explain feedback');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('Specialist Detail')), 'detail blocks explain specialist button');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('Thread continuation')), 'detail blocks explain thread mode');
assert(helpDetailBlocks.some(b => b.type === 'context'), 'detail blocks have context footer');
```

- [ ] **Step 3: Run tests — confirm new tests fail**

```bash
node test.js 2>&1 | grep -E "(Help Blocks|❌)"
```

Expected: failures on all `buildHelpBlocks` and `buildHelpDetailBlocks` assertions (`buildHelpBlocks is not a function`). All previously passing tests still green.

- [ ] **Step 4: Implement `buildHelpBlocks()` in `src/slack/blocks.js`**

Add before the final line of `src/slack/blocks.js`:

```js
/**
 * Builds the public help response shown to all roles when an agent asks "@bot help".
 * @returns {Array} Slack blocks array
 */
export function buildHelpBlocks() {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🤖 IntegrationsBot — Help', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*What I do*\nSearch Confluence, Jira, and past Slack threads to give you troubleshooting steps for integration issues. Describe the problem and I\'ll tell you what to do — or ask a clarifying question to narrow it down first.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Integrations I cover*\nZapier · Angi / Angi Leads · Reserve with Google (RwG) · ServiceChannel · Thumbtack · Procore · Chat-to-Text widget · and others',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*What I can\'t help with*\nAccounting integrations (QuickBooks, NetSuite, Sage Intacct, Xero, etc.) — those go to #ask-partner-enabled-accounting-integrations.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Example queries*\n• _"Customer\'s Zapier integration shows no API access on their tenant"_\n• _"Angi leads stopped syncing after the tenant migration"_\n• _"Procore job cost export failing for one specific job type"_',
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_IntegrationsBot · Tag me or DM me with an issue · Team support: #ask-integrations_' }],
    },
  ];
}
```

- [ ] **Step 5: Implement `buildHelpDetailBlocks()` in `src/slack/blocks.js`**

Add immediately after `buildHelpBlocks()`:

```js
/**
 * Builds the Specialist-only full reference, sent as an ephemeral in channels
 * or appended to the thread in DMs.
 * @returns {Array} Slack blocks array
 */
export function buildHelpDetailBlocks() {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📖 Full Reference — Specialists', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Confidence levels*\n🟢 *High* — every step traced directly to a search result. Act on it.\n🟡 *Medium* — partial match or drawn from built-in knowledge. Verify before actioning.\n🔴 *Low* — no direct match found. Treat as a starting point; escalate if unsure.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Wrong Answer feedback*\nClick 👎 Wrong Answer → describe the correct answer → goes to pending review in the feedback channel → if approved, the correction is injected into future Claude prompts for the same query type.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Show Specialist Detail button*\nAppears on CSA responses. Clicking it triggers a second Claude call in Specialist mode and posts the full technical response in the same thread — useful when a CSA wants more depth without re-asking.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Thread continuation*\nAfter my first response, any follow-up in the same thread enters guided diagnostic mode — I ask yes/no questions to narrow down the root cause, then deliver a final answer.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*"No direct match" escalations*\nWhen I output a single escalate step saying I couldn\'t find specific information — that\'s intentional honesty, not a failure. It means searches returned nothing specific for this integration + symptom combination.',
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_This reference is visible to Specialists only_' }],
    },
  ];
}
```

- [ ] **Step 6: Run tests — all should pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Results: 162 passed, 0 failed out of 162 tests` (10 new tests added).

If count differs, check the `❌` lines and fix before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add buildHelpBlocks and buildHelpDetailBlocks for help command"
```

---

## Task 2: Fix cache bug + add `isDm` param to `handleQuery`

**Files:**
- Modify: `src/handlers/mention.js`
- Modify: `src/handlers/dm.js`

- [ ] **Step 1: Add `isDm` param to `handleQuery` in `src/handlers/mention.js`**

In `src/handlers/mention.js`, find:
```js
export async function handleQuery({ rawText, channelId, threadTs, client, userId }) {
```

Replace with:
```js
export async function handleQuery({ rawText, channelId, threadTs, client, userId, isDm = false }) {
```

- [ ] **Step 2: Pass `isDm: true` from `src/handlers/dm.js`**

In `src/handlers/dm.js`, find:
```js
      await handleQuery({
        rawText: message.text ?? '',
        channelId: message.channel,
        threadTs: message.thread_ts ?? message.ts,
        client,
        userId: message.user,
      });
```

Replace with:
```js
      await handleQuery({
        rawText: message.text ?? '',
        channelId: message.channel,
        threadTs: message.thread_ts ?? message.ts,
        client,
        userId: message.user,
        isDm: true,
      });
```

- [ ] **Step 3: Fix the cache bug in `src/handlers/mention.js`**

In `src/handlers/mention.js`, find:
```js
  setCached(query, result);
```

Replace with:
```js
  // Only cache full structured responses — clarifying-question stubs must not be cached
  // because buildResponseBlocks would render them as broken messages with undefined fields.
  if (!result.clarifying_question) setCached(query, result);
```

- [ ] **Step 4: Run tests — all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: same pass count as after Task 1. No regressions.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/mention.js src/handlers/dm.js
git commit -m "fix: only cache full structured responses, not clarifying-question stubs; add isDm param to handleQuery"
```

---

## Task 3: Move accounting check + add help command handler

**Files:**
- Modify: `src/handlers/mention.js`

Both changes go in the same file in adjacent positions — do them together.

- [ ] **Step 1: Add `buildHelpBlocks` and `buildHelpDetailBlocks` to the import in `src/handlers/mention.js`**

In `src/handlers/mention.js`, find:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
} from '../slack/blocks.js';
```

Replace with:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
} from '../slack/blocks.js';
```

- [ ] **Step 2: Move the accounting check and add the help check before the history check**

In `src/handlers/mention.js`, find this block (it currently sits after the `hasHistory` block):
```js
  // 1. Fast-path: accounting redirect (no Claude needed)
  if (isAccountingTopic(query)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildAccountingRedirectBlocks(query),
      text: 'This question is about accounting integrations — please redirect to #ask-partner-enabled-accounting-integrations.',
    });
    return;
  }
```

Delete it from its current position. Then find the `hasHistory` block:
```js
  // 1b. Follow-up path — thread has prior history, use conversational mode
  if (hasHistory(threadTs)) {
```

Insert the accounting check and new help check **immediately before** that line:

```js
  // 1. Fast-path: accounting redirect (no Claude needed)
  // Checked before history so follow-up messages about accounting topics
  // get the redirect without an unnecessary Claude call.
  if (isAccountingTopic(query)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildAccountingRedirectBlocks(query),
      text: 'This question is about accounting integrations — please redirect to #ask-partner-enabled-accounting-integrations.',
    });
    return;
  }

  // 1c. Help command — "@bot help" returns capability overview (all roles)
  // plus a Specialist-only full reference via ephemeral.
  // Checked before history so "help" in an active thread always shows help.
  if (query.toLowerCase() === 'help') {
    const { role } = await detectAgentRole(client, userId);

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildHelpBlocks(),
      text: 'IntegrationsBot — Help',
    });

    if (role === 'specialist') {
      if (isDm) {
        // DM is already private — post detail as a follow-up message
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildHelpDetailBlocks(),
          text: 'IntegrationsBot — Full Reference',
        });
      } else {
        // Channel — send ephemeral so only the Specialist sees the detail
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          blocks: buildHelpDetailBlocks(),
          text: 'IntegrationsBot — Full Reference (Specialists only)',
        });
      }
    }
    return;
  }

  // 1b. Follow-up path — thread has prior history, use conversational mode
  if (hasHistory(threadTs)) {
```

- [ ] **Step 3: Run tests — all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: same pass count as after Task 2. No regressions.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/mention.js
git commit -m "feat: move accounting check before history, add role-gated help command handler"
```

---

## Task 4: Add confidence logging

**Files:**
- Modify: `src/handlers/mention.js`

Two log lines — one for cache hits, one for live full responses.

- [ ] **Step 1: Add log line for cache hits**

In `src/handlers/mention.js`, find the cache hit block:
```js
  // 2. Check cache
  const cached = getCached(query);
  if (cached) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildResponseBlocks(cached),
      text: `Troubleshooting steps for: ${cached.issue_title}`,
    });
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(cached) },
    ]);
    return;
  }
```

Replace with:
```js
  // 2. Check cache
  const cached = getCached(query);
  if (cached) {
    const cachedIntegration = (cached.integration_type ?? 'unknown').slice(0, 50);
    const cachedSources = (cached.sources_used ?? []).join(',') || 'none';
    console.info(`[query] cache-hit confidence=${cached.confidence ?? 'unknown'} integration=${cachedIntegration} sources=${cachedSources}`);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildResponseBlocks(cached),
      text: `Troubleshooting steps for: ${cached.issue_title}`,
    });
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(cached) },
    ]);
    return;
  }
```

- [ ] **Step 2: Add log line for live full responses**

In `src/handlers/mention.js`, find this block (it is the full response delivery path, after the clarifying question check):
```js
  // 8. Update the thinking placeholder with the real response
  const responseBlocks = buildResponseBlocks(result);
```

Insert the log line immediately before it:
```js
  // Log confidence + sources for live full responses (after accounting + clarifying-question paths have returned)
  const liveIntegration = (result.integration_type ?? 'unknown').slice(0, 50);
  const liveSources = (result.sources_used ?? []).join(',') || 'none';
  console.info(`[query] role=${role} confidence=${result.confidence ?? 'unknown'} integration=${liveIntegration} sources=${liveSources}`);

  // 8. Update the thinking placeholder with the real response
  const responseBlocks = buildResponseBlocks(result);
```

- [ ] **Step 3: Run tests — all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: same pass count as after Task 3. No regressions.

- [ ] **Step 4: Commit**

```bash
git add src/handlers/mention.js
git commit -m "feat: add confidence logging for cache hits and live full responses"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
node test.js 2>&1
```

Expected: `Results: 162 passed, 0 failed out of 162 tests`

If any test fails, read the `❌` line carefully and fix before proceeding.

- [ ] **Step 2: Verify no leftover references to removed patterns**

```bash
grep -n "setCached" src/handlers/mention.js
```

Expected: exactly one match — the guarded `if (!result.clarifying_question) setCached(...)` line.

```bash
grep -n "isAccountingTopic" src/handlers/mention.js
```

Expected: exactly one match — in the early fast-path block, before the `hasHistory` check.

- [ ] **Step 3: Verify exports are clean**

```bash
grep -n "^export function" src/slack/blocks.js
```

Expected output includes `buildHelpBlocks` and `buildHelpDetailBlocks` alongside the existing exports.

- [ ] **Step 4: Commit any outstanding changes (if needed)**

If all checks pass and there's nothing uncommitted, skip this step.

```bash
git status
```

If clean: done. If dirty: investigate before committing — nothing should be unstaged at this point.
