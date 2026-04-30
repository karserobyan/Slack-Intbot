# DM Interaction Flow — Thread-per-Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat DM handler and the parked routing-buttons module with a thread-per-session model: a standing welcome card, one session card per "New chat" press, and all conversation in threads.

**Architecture:** Two new block builders (`buildWelcomeCard`, `buildSessionCard`) are added to `blocks.js`. `buildResponseBlocks` gains an `isDm` flag that appends a "💬 New chat" action button. `dm.js` is rewritten to register all DM-related events and actions (`app_home_opened`, `new_chat`, `start_chat_thread`) and to handle the fallback path. `routing-buttons.js` is deleted; its two action handlers are removed from `index.js`.

**Tech Stack:** Node.js ESM, @slack/bolt v4, Block Kit

---

## File Map

| File | Change |
|---|---|
| `src/slack/blocks.js` | Add `buildWelcomeCard()`, `buildSessionCard()`; modify `buildResponseBlocks()` signature |
| `src/handlers/mention.js` | Update 4 `buildResponseBlocks` call sites to pass `{ isDm }` |
| `src/handlers/dm.js` | Full rewrite — registers `app_home_opened`, `new_chat`, `start_chat_thread`, and DM message handler |
| `src/index.js` | Remove `integration_question` and `log_request` action handlers (lines 44–78) |
| `src/slack/routing-buttons.js` | **Delete** |
| `test.js` | Add `buildWelcomeCard` / `buildSessionCard` / `isDm` tests; remove Routing Buttons section and its import |

---

## Codebase Context

Read before starting:

- `src/slack/blocks.js:47` — `buildResponseBlocks` signature (currently no second param); actions block built at lines 107–148
- `src/handlers/mention.js:46` — `handleQuery` signature (already receives `isDm`); `buildResponseBlocks` called at lines 179, 231, 238, 368
- `src/handlers/dm.js` — current 39-line handler; entire file will be replaced
- `src/index.js:44–78` — `integration_question` and `log_request` action handlers to delete
- `test.js:18` — `import { buildRoutingButtons }` to remove
- `test.js:901–930` — Routing Buttons test section to remove

Key facts:
- `test.js` runs with `node test.js` — no test framework, plain `assert()`
- All new block builder tests go in the "Block Kit Builders" section (~line 443, before the Cache section)
- `app.event()` is the Bolt API for non-message events; `app.action()` for button clicks
- `body.message.ts` inside an `app.action` handler is the TS of the message containing the clicked button
- `body.channel.id` inside an `app.action` handler is the channel where the button lives

---

## Task 1 — `buildWelcomeCard` and `buildSessionCard`

**Files:**
- Modify: `src/slack/blocks.js` (append after line 150, before `buildAccountingRedirectBlocks`)
- Modify: `test.js` (append after line 442, before `// ── 4. Cache`)

- [ ] **Step 1: Add failing tests to `test.js`**

Find the line `// ── 4. Cache ─────────────────────────────────────────────────────────────────` (line 443). Insert before it:

```js
// ── 3b. Welcome Card & Session Card ──────────────────────────────────────────
console.log('\n🔹 Welcome Card & Session Card');

const welcomeBlocks = buildWelcomeCard();
assert(Array.isArray(welcomeBlocks), 'buildWelcomeCard returns array');
assert(welcomeBlocks.some(b => b.type === 'actions'), 'welcome card has actions block');
const welcomeActions = welcomeBlocks.find(b => b.type === 'actions');
assert(welcomeActions.elements[0].action_id === 'new_chat', 'welcome card button action_id is new_chat');
assert(welcomeActions.elements[0].text.text === '💬 New chat', 'welcome card button text is 💬 New chat');
assert(welcomeActions.elements[0].style === 'primary', 'welcome card button style is primary');
assert(welcomeBlocks.some(b => b.text?.text?.includes('Welcome to IntBot')), 'welcome card contains welcome text');

const sessionBlocks = buildSessionCard();
assert(Array.isArray(sessionBlocks), 'buildSessionCard returns array');
assert(sessionBlocks.some(b => b.text?.text?.includes('🟢 Integration chat')), 'session card has 🟢 Integration chat text');
assert(sessionBlocks.some(b => b.type === 'actions'), 'session card has actions block');
const sessionActions = sessionBlocks.find(b => b.type === 'actions');
assert(sessionActions.elements[0].action_id === 'start_chat_thread', 'session card button action_id is start_chat_thread');
assert(sessionActions.elements[0].text.text === '💬 Ask an integration question', 'session card button text correct');
```

- [ ] **Step 2: Update the import in `test.js` to include the new builders**

Find line 7:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildSourcesModal,
  buildAuditBlocks,
} from './src/slack/blocks.js';
```

Replace with:
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
} from './src/slack/blocks.js';
```

- [ ] **Step 3: Run tests — verify new assertions fail**

```bash
node test.js 2>&1 | grep -E "(Welcome Card|Session Card|❌)"
```

Expected: failures for `buildWelcomeCard` / `buildSessionCard` (not yet defined).

- [ ] **Step 4: Add `buildWelcomeCard` and `buildSessionCard` to `src/slack/blocks.js`**

Append after line 150 (`  return blocks;\n}`), before `/**\n * Builds Block Kit blocks for the accounting topic redirect.`:

```js
export function buildWelcomeCard() {
  return [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: "*👋 Welcome to IntBot!*\nI diagnose integration issues and walk you through step-by-step fixes. Start a chat when you're ready." },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 New chat', emoji: true },
          action_id: 'new_chat',
          style: 'primary',
          value: 'new_chat',
        },
      ],
    },
  ];
}

export function buildSessionCard() {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*🟢 Integration chat*\nReady when you are.' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 Ask an integration question', emoji: true },
          action_id: 'start_chat_thread',
          value: 'start_chat_thread',
        },
      ],
    },
  ];
}
```

- [ ] **Step 5: Run tests — verify all pass**

```bash
node test.js 2>&1 | tail -4
```

Expected: `NNN passed, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add buildWelcomeCard and buildSessionCard block builders"
```

---

## Task 2 — `buildResponseBlocks` isDm flag + mention.js call sites

**Files:**
- Modify: `src/slack/blocks.js:47` (signature change + isDm button)
- Modify: `src/handlers/mention.js:179,231,238,368` (pass `{ isDm }`)
- Modify: `test.js` (add isDm assertions in Block Kit Builders section)

- [ ] **Step 1: Add failing tests to `test.js`**

Find the line:
```js
// unknown/missing confidence defaults to medium badge (no crash)
const noConfBlocks = buildResponseBlocks({ ...sampleJson, confidence: undefined });
assert(noConfBlocks.length > 0, 'Missing confidence field does not crash');
```

Add immediately after it:

```js
// isDm: true appends New chat button; isDm: false (default) does not
const dmBlocks = buildResponseBlocks(sampleJson, { isDm: true });
const dmActions = dmBlocks.find(b => b.type === 'actions');
assert(dmActions !== undefined, 'isDm response has actions block');
assert(dmActions.elements.some(e => e.action_id === 'new_chat'), 'isDm: true appends new_chat button');
assert(dmActions.elements.at(-1).text.text === '💬 New chat', 'New chat button is last in actions');

const nonDmActions = responseBlocks.find(b => b.type === 'actions');
assert(!nonDmActions.elements.some(e => e.action_id === 'new_chat'), 'isDm: false (default) has no new_chat button');
```

- [ ] **Step 2: Run tests — verify the two new assertions fail**

```bash
node test.js 2>&1 | grep -E "(new_chat|New chat button)"
```

Expected: `❌ isDm: true appends new_chat button` and `❌ New chat button is last in actions`.

- [ ] **Step 3: Update `buildResponseBlocks` signature in `src/slack/blocks.js`**

Find line 47:
```js
export function buildResponseBlocks(data) {
```

Replace with:
```js
export function buildResponseBlocks(data, { isDm = false } = {}) {
```

- [ ] **Step 4: Add the isDm button injection in `src/slack/blocks.js`**

Find (lines 144–148):
```js
  if (data._showSpecialistValue) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
      action_id: 'show_specialist_detail',
      value: data._showSpecialistValue,
    });
  }

  blocks.push({ type: 'actions', elements: actionElements });
```

Replace with:
```js
  if (data._showSpecialistValue) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
      action_id: 'show_specialist_detail',
      value: data._showSpecialistValue,
    });
  }

  if (isDm) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '💬 New chat', emoji: true },
      action_id: 'new_chat',
      value: 'new_chat',
    });
  }

  blocks.push({ type: 'actions', elements: actionElements });
```

- [ ] **Step 5: Run tests — verify blocks.js tests pass**

```bash
node test.js 2>&1 | grep -E "(new_chat|New chat|❌)" | head -10
```

Expected: both new assertions pass, no regressions in existing block tests.

- [ ] **Step 6: Update 4 `buildResponseBlocks` call sites in `src/handlers/mention.js`**

**Change 1 — line 179 (cache hit):**
```js
// before
blocks: buildResponseBlocks(cached),
// after
blocks: buildResponseBlocks(cached, { isDm }),
```

**Change 2 — line 231 (knowledge fast-lookup, update path):**
```js
// before
blocks: buildResponseBlocks(fastResult),
// after
blocks: buildResponseBlocks(fastResult, { isDm }),
```

**Change 3 — line 238 (knowledge fast-lookup, post path):**
```js
// before
blocks: buildResponseBlocks(fastResult),
// after
blocks: buildResponseBlocks(fastResult, { isDm }),
```

**Change 4 — line 368 (main response):**
```js
// before
const responseBlocks = buildResponseBlocks(result);
// after
const responseBlocks = buildResponseBlocks(result, { isDm });
```

- [ ] **Step 7: Run full test suite**

```bash
node test.js 2>&1 | tail -4
```

Expected: all tests pass, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add src/slack/blocks.js src/handlers/mention.js test.js
git commit -m "feat: add isDm flag to buildResponseBlocks; propagate through mention.js"
```

---

## Task 3 — Rewrite `src/handlers/dm.js`

**Files:**
- Modify: `src/handlers/dm.js` (full replacement)

No unit tests for the Bolt handler itself — the block builders it uses are already tested. The integration is verified manually by running the bot.

- [ ] **Step 1: Replace `src/handlers/dm.js` entirely**

```js
import { handleQuery } from './mention.js';
import { buildWelcomeCard, buildSessionCard } from '../slack/blocks.js';

export function registerDmHandler(app) {
  const _inFlight         = new Set();
  const _welcomed         = new Set();
  const _promptedSessions = new Set();

  // Post standing welcome card the first time a user opens the bot
  app.event('app_home_opened', async ({ event, client, logger }) => {
    const userId = event.user;
    if (_welcomed.has(userId)) return;
    _welcomed.add(userId);
    try {
      const dm = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: dm.channel.id,
        blocks:  buildWelcomeCard(),
        text:    "👋 Welcome to IntBot! Start a chat when you're ready.",
      });
    } catch (err) {
      logger.error(`[dm] Failed to post welcome card to ${userId}:`, err.message);
      _welcomed.delete(userId); // allow retry on next open
    }
  });

  // "New chat" button — post a fresh session card to the DM channel
  app.action('new_chat', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    try {
      await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
    } catch (err) {
      logger.error('[dm] Failed to post session card:', err.message);
    }
  });

  // "Ask an integration question" button — post thread prompt (double-click safe)
  app.action('start_chat_thread', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    const sessionTs = body.message.ts;
    if (_promptedSessions.has(sessionTs)) return;
    _promptedSessions.add(sessionTs);
    setTimeout(() => _promptedSessions.delete(sessionTs), 86_400_000);
    try {
      await client.chat.postMessage({
        channel:   channelId,
        thread_ts: sessionTs,
        text:      'What integration issue are you working on? 👇',
      });
    } catch (err) {
      logger.error('[dm] Failed to post thread prompt:', err.message);
      _promptedSessions.delete(sessionTs); // allow retry
    }
  });

  // DM message handler — thread replies go to handleQuery; top-level triggers fallback
  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype === 'bot_message' || message.bot_id) return;

    if (_inFlight.has(message.ts)) {
      logger.warn(`[dm] Duplicate event ${message.ts} — skipping`);
      return;
    }
    _inFlight.add(message.ts);

    const userId    = message.user;
    const channelId = message.channel;

    try {
      // Thread reply — route directly to the AI
      if (message.thread_ts && message.thread_ts !== message.ts) {
        await handleQuery({
          rawText:  message.text ?? '',
          channelId,
          threadTs: message.thread_ts,
          client,
          userId,
          isDm: true,
        });
        return;
      }

      // Top-level DM — fallback: welcome (if first contact) → session card → prompt → answer
      if (!_welcomed.has(userId)) {
        _welcomed.add(userId);
        await client.chat.postMessage({
          channel: channelId,
          blocks:  buildWelcomeCard(),
          text:    "👋 Welcome to IntBot!",
        });
      }

      const sessionMsg = await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
      const sessionTs = sessionMsg.ts;
      _promptedSessions.add(sessionTs);
      setTimeout(() => _promptedSessions.delete(sessionTs), 86_400_000);

      await client.chat.postMessage({
        channel:   channelId,
        thread_ts: sessionTs,
        text:      'What integration issue are you working on? 👇',
      });

      await handleQuery({
        rawText:  message.text ?? '',
        channelId,
        threadTs: sessionTs,
        client,
        userId,
        isDm: true,
      });
    } catch (err) {
      logger.error(`[dm] Error handling message ${message.ts}:`, err.message);
    } finally {
      setTimeout(() => _inFlight.delete(message.ts), 60_000);
    }
  });
}
```

- [ ] **Step 2: Run tests — verify nothing broken**

```bash
node test.js 2>&1 | tail -4
```

Expected: all tests still pass (dm.js has no direct unit tests — the handlers use Bolt's app object which is not available in the test suite).

- [ ] **Step 3: Commit**

```bash
git add src/handlers/dm.js
git commit -m "feat: rewrite dm.js — thread-per-session model with welcome card and session flow"
```

---

## Task 4 — Remove routing handlers from `src/index.js`

**Files:**
- Modify: `src/index.js:44–78`

- [ ] **Step 1: Remove `integration_question` and `log_request` handlers**

Find and delete the following block entirely (lines 44–78):

```js
// ── Routing: Integration Question button ─────────────────────────────────────
app.action('integration_question', async ({ ack, body, client, logger }) => {
  await ack();
  let context;
  try {
    context = JSON.parse(body.actions[0].value);
  } catch {
    logger.error('[routing] Failed to parse integration_question value');
    return;
  }
  await handleQuery({
    rawText:   context.query,
    channelId: context.channelId,
    threadTs:  context.threadTs,
    client,
    userId:    context.userId,
    isDm:      context.isDm ?? false,
  });
});

// ── Routing: Log Request button — opens audit modal ───────────────────────────
app.action('log_request', async ({ ack, body, client, logger }) => {
  await ack();
  let context;
  try {
    context = JSON.parse(body.actions[0].value);
  } catch {
    logger.error('[routing] Failed to parse log_request value');
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildAuditLogModal({ channelId: context.channelId, threadTs: context.threadTs }),
  });
});
```

- [ ] **Step 2: Run tests — verify no regressions**

```bash
node test.js 2>&1 | tail -4
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "chore: remove integration_question and log_request routing handlers"
```

---

## Task 5 — Delete `routing-buttons.js` and clean up `test.js`

**Files:**
- Delete: `src/slack/routing-buttons.js`
- Modify: `test.js:18` (remove import)
- Modify: `test.js:901–930` (remove Routing Buttons test section)

- [ ] **Step 1: Delete `src/slack/routing-buttons.js`**

```bash
rm src/slack/routing-buttons.js
```

- [ ] **Step 2: Remove `buildRoutingButtons` import from `test.js`**

Find line 18:
```js
import { buildRoutingButtons } from './src/slack/routing-buttons.js';
```

Delete that entire line.

- [ ] **Step 3: Remove the Routing Buttons test section from `test.js`**

Find and delete the following block entirely (lines 901–930):

```js
// ── Routing Buttons ───────────────────────────────────────────────────────────
console.log('\n🔹 Routing Buttons');

const routingCtx = { query: 'Zapier not working', channelId: 'C123', threadTs: '111.222', userId: 'U456' };
const routingBlocks = buildRoutingButtons(routingCtx);

assert(routingBlocks.length === 2, 'buildRoutingButtons returns 2 blocks');
assert(routingBlocks[0].type === 'section', 'routing block 0 is section');
assert(routingBlocks[1].type === 'actions', 'routing block 1 is actions');

const btns = routingBlocks[1].elements;
assert(btns.length === 2, 'routing actions has 2 buttons');
assert(btns[0].action_id === 'integration_question', 'first button action_id is integration_question');
assert(btns[1].action_id === 'log_request', 'second button action_id is log_request');
assert(btns[1].value === btns[0].value, 'both buttons carry the same routing context');

const btnValue = JSON.parse(btns[0].value);
assert(btnValue.query === 'Zapier not working', 'button value encodes query');
assert(btnValue.channelId === 'C123', 'button value encodes channelId');
assert(btnValue.threadTs === '111.222', 'button value encodes threadTs');
assert(btnValue.userId === 'U456', 'button value encodes userId');
assert(btnValue.isDm === false, 'button value encodes isDm (default false)');

const dmBlocks = buildRoutingButtons({ query: 'test', channelId: 'D1', threadTs: '1', userId: 'U1', isDm: true });
const dmValue = JSON.parse(dmBlocks[1].elements[0].value);
assert(dmValue.isDm === true, 'button value encodes isDm: true when passed');

const veryLongQuery = 'x'.repeat(2000);
const longBlocks = buildRoutingButtons({ query: veryLongQuery, channelId: 'C1', threadTs: '1', userId: 'U1' });
const longValue = JSON.parse(longBlocks[1].elements[0].value);
assert(longValue.query.length <= 1800, 'button value truncates long queries to 1800 chars');
```

- [ ] **Step 4: Run full test suite**

```bash
node test.js 2>&1 | tail -4
```

Expected: all tests pass, 0 failed. Count will be lower than before (routing button assertions removed).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete routing-buttons.js; remove routing button tests"
```

---

## Self-Review Checklist

- [x] `buildWelcomeCard` — Task 1 ✅
- [x] `buildSessionCard` — Task 1 ✅
- [x] `buildResponseBlocks` isDm flag — Task 2 ✅
- [x] 4 mention.js call sites updated — Task 2 ✅
- [x] `app_home_opened` handler — Task 3 ✅
- [x] `new_chat` action handler — Task 3 ✅
- [x] `start_chat_thread` action handler + double-click guard — Task 3 ✅
- [x] DM message handler: thread replies → handleQuery, top-level → fallback — Task 3 ✅
- [x] Dual-trigger welcome (app_home_opened + first DM message) with shared `_welcomed` Set — Task 3 ✅
- [x] `integration_question` handler removed — Task 4 ✅
- [x] `log_request` handler removed — Task 4 ✅
- [x] `routing-buttons.js` deleted — Task 5 ✅
- [x] Test import and section cleaned up — Task 5 ✅
