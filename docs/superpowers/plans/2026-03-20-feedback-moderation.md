# Feedback Moderation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Slack-based approval layer to the Wrong Answer feedback system so corrections go into a pending queue and are only applied after a reviewer approves them.

**Architecture:** `saveFeedback()` writes to `data/feedback-pending.json` instead of `data/feedback.json`. After saving, `notifyFeedbackChannel()` posts a review card with Approve/Reject buttons to the review channel and records the message ts back onto the pending entry. Two new action handlers in `index.js` handle approval and rejection. `getRelevantFeedback()` is unchanged — it only reads from `feedback.json` (approved entries).

**Tech Stack:** Existing Slack Bolt framework, existing Node.js `fs/promises`, existing `feedback.js` write-queue pattern.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/slack/feedback.js` | Pending queue, review card posting, approve/reject functions |
| Modify | `src/index.js` | Register `approve_feedback` and `reject_feedback` action handlers |
| Modify | `test.js` | Tests for pending queue, approval, rejection |
| Auto-create | `data/feedback-pending.json` | Created on first submission |

---

## Task 1: Add feedback moderation tests to `test.js`

**Files:**
- Modify: `test.js`

- [ ] **Step 1: Add import for new functions at the top of `test.js`**

Update the feedback import line:
```js
import { getRelevantFeedback, saveFeedback, approveFeedback, rejectFeedback, getPendingFeedback } from './src/slack/feedback.js';
```

Note: `getPendingFeedback` is a new export we'll add for testing purposes only.

- [ ] **Step 2: Add tests before the summary block**

```js
// ── Feedback Moderation ───────────────────────────────────────────────────
console.log('\n🔹 Feedback Moderation');

// saveFeedback should write to pending, NOT active
const testRecord = await saveFeedback({
  query: 'zapier test query for moderation',
  issueTitle: 'Zapier API Access',
  integrationType: 'Zapier',
  feedbackType: 'wrong_answer',
  correction: 'The real fix is X',
  agentId: 'U12345',
  agentName: 'Test Agent',
}, { skipNotify: true }); // skipNotify flag for testing

const pending = await getPendingFeedback();
assert(Array.isArray(pending), 'getPendingFeedback returns array');
assert(pending.some(e => e.id === testRecord.id), 'New feedback is in pending queue');

// Schema check — pending entry must have reviewMessageTs and reviewChannelId
const pendingEntry = pending.find(e => e.id === testRecord.id);
assert(pendingEntry.reviewMessageTs === null, 'New pending entry has null reviewMessageTs');
assert('reviewChannelId' in pendingEntry, 'New pending entry has reviewChannelId field');

// Should NOT be in active feedback.json yet
const activeBefore = await getRelevantFeedback('zapier test query for moderation');
assert(!activeBefore.some(e => e.id === testRecord.id), 'New feedback NOT in active queue before approval');

// Approve it
await approveFeedback(testRecord.id);
const activeAfter = await getRelevantFeedback('zapier test query for moderation');
assert(activeAfter.some(e => e.id === testRecord.id), 'Feedback in active queue after approval');

const pendingAfter = await getPendingFeedback();
assert(!pendingAfter.some(e => e.id === testRecord.id), 'Feedback removed from pending after approval');

// Reject a second entry
const testRecord2 = await saveFeedback({
  query: 'angi test query for rejection',
  issueTitle: 'Angi Leads Issue',
  integrationType: 'Angi',
  feedbackType: 'outdated',
  correction: 'This is wrong info',
  agentId: 'U99999',
  agentName: 'Bad Actor',
}, { skipNotify: true });

await rejectFeedback(testRecord2.id);
const pendingAfterReject = await getPendingFeedback();
assert(!pendingAfterReject.some(e => e.id === testRecord2.id), 'Feedback removed from pending after rejection');

const activeAfterReject = await getRelevantFeedback('angi test query for rejection');
assert(!activeAfterReject.some(e => e.id === testRecord2.id), 'Rejected feedback NOT in active queue');

// Double-approve is idempotent — must NOT duplicate in active queue
await approveFeedback(testRecord.id); // already approved
const activeNoDup = await getRelevantFeedback('zapier test query for moderation');
const matchCount = activeNoDup.filter(e => e.id === testRecord.id).length;
assert(matchCount === 1, 'Double-approve does not duplicate entry in active queue');

assert(typeof approveFeedback === 'function', 'approveFeedback is a function');
assert(typeof rejectFeedback === 'function', 'rejectFeedback is a function');
```

- [ ] **Step 3: Run tests — confirm new tests FAIL**

```bash
npm test
```

Expected: FAIL — `approveFeedback`, `rejectFeedback`, `getPendingFeedback` not exported from `feedback.js` yet.

- [ ] **Step 4: Commit the failing tests**

```bash
git add test.js
git commit -m "test: add feedback moderation tests (red — implementation pending)"
```

---

## Task 2: Rewrite `src/slack/feedback.js`

**Files:**
- Modify: `src/slack/feedback.js`

- [ ] **Step 1: Replace the entire file with the moderation-aware version**

```js
/**
 * Feedback storage with moderation queue.
 *
 * Design:
 * - Submissions go to data/feedback-pending.json (not applied yet)
 * - A reviewer approves/rejects via Slack buttons in the review channel
 * - Approved entries move to data/feedback.json (active, injected into prompts)
 * - Rejected entries are discarded
 * - Write queue: all writes serialised via Promise chain to prevent races
 * - In-memory caches for both pending and active arrays
 * - Max 500 active entries, 200 pending entries
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteCache } from './cache.js';

const FEEDBACK_DIR = join(process.cwd(), 'data');
const FEEDBACK_FILE = join(FEEDBACK_DIR, 'feedback.json');
const PENDING_FILE = join(FEEDBACK_DIR, 'feedback-pending.json');
const REVIEW_CHANNEL = process.env.FEEDBACK_REVIEW_CHANNEL_ID || null;
const MAX_ACTIVE = 500;
const MAX_PENDING = 200;

// In-memory caches. null = not yet loaded.
let _activeCache = null;
let _pendingCache = null;

// Single write queue for both files — prevents any concurrent write races.
let _writeQueue = Promise.resolve();

// ── Disk I/O helpers ──────────────────────────────────────────────────────

async function loadActive() {
  if (_activeCache !== null) return _activeCache;
  try {
    _activeCache = JSON.parse(await readFile(FEEDBACK_FILE, 'utf-8'));
  } catch {
    _activeCache = [];
  }
  return _activeCache;
}

async function loadPending() {
  if (_pendingCache !== null) return _pendingCache;
  try {
    _pendingCache = JSON.parse(await readFile(PENDING_FILE, 'utf-8'));
  } catch {
    _pendingCache = [];
  }
  return _pendingCache;
}

async function persistActive(entries) {
  await mkdir(FEEDBACK_DIR, { recursive: true });
  await writeFile(FEEDBACK_FILE, JSON.stringify(entries, null, 2));
}

async function persistPending(entries) {
  await mkdir(FEEDBACK_DIR, { recursive: true });
  await writeFile(PENDING_FILE, JSON.stringify(entries, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Saves a new feedback entry to the pending queue.
 * Does NOT apply to active feedback until approved.
 *
 * @param {object} entry - Feedback data
 * @param {object} [opts]
 * @param {boolean} [opts.skipNotify] - Skip posting review card (for tests)
 * @returns {Promise<object>} The saved pending record
 */
export async function saveFeedback(entry, { skipNotify = false } = {}) {
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
    reviewMessageTs: null,
    reviewChannelId: REVIEW_CHANNEL,
  };

  _writeQueue = _writeQueue
    .then(async () => {
      const pending = await loadPending();
      pending.push(record);
      // Cap at MAX_PENDING — silently evict oldest
      if (pending.length > MAX_PENDING) {
        pending.splice(0, pending.length - MAX_PENDING);
      }
      _pendingCache = pending;
      await persistPending(pending);
    })
    .catch((err) => {
      console.error('[feedback] Pending write failed:', err.message);
    });

  await _writeQueue;
  return record;
}

/**
 * Posts a review card to the review channel with Approve/Reject buttons.
 * Updates the pending entry with reviewMessageTs after posting.
 * No-op if FEEDBACK_REVIEW_CHANNEL_ID is not configured.
 *
 * @param {object} client - Slack WebClient
 * @param {object} record - Pending feedback record
 */
export async function notifyFeedbackChannel(client, record) {
  if (!REVIEW_CHANNEL) {
    console.warn('[feedback] FEEDBACK_REVIEW_CHANNEL_ID not set — review card not posted.');
    return;
  }

  let messageTs;
  try {
    const msg = await client.chat.postMessage({
      channel: REVIEW_CHANNEL,
      text: `📝 Feedback Review from ${record.agentName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*📝 Feedback Review — ${record.feedbackType.replace(/_/g, ' ')}*`,
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
          text: { type: 'mrkdwn', text: `*Agent's correction:*\n>${record.correction}` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Approve', emoji: true },
              action_id: 'approve_feedback',
              style: 'primary',
              value: JSON.stringify({ feedbackId: record.id }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Reject', emoji: true },
              action_id: 'reject_feedback',
              style: 'danger',
              value: JSON.stringify({ feedbackId: record.id }),
            },
          ],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_${record.id} • ${record.timestamp}_` }],
        },
      ],
    });
    messageTs = msg.ts;
  } catch (err) {
    console.error('[feedback] Failed to post review card:', err.message);
    return;
  }

  // Update pending entry with message ts so action handlers can update it
  _writeQueue = _writeQueue
    .then(async () => {
      const pending = await loadPending();
      const idx = pending.findIndex(e => e.id === record.id);
      if (idx !== -1) {
        pending[idx].reviewMessageTs = messageTs;
        pending[idx].reviewChannelId = REVIEW_CHANNEL;
        _pendingCache = pending;
        await persistPending(pending);
      }
    })
    .catch((err) => {
      console.error('[feedback] Failed to update pending entry with messageTs:', err.message);
    });

  await _writeQueue;
}

/**
 * Approves a pending feedback entry — moves it to active feedback.
 * Idempotent: no-op if entry not found (already processed).
 *
 * @param {string} id - Feedback entry ID
 * @returns {Promise<object|null>} The approved record, or null if not found
 */
export async function approveFeedback(id) {
  let approved = null;

  _writeQueue = _writeQueue
    .then(async () => {
      const pending = await loadPending();
      const idx = pending.findIndex(e => e.id === id);
      if (idx === -1) return; // Already processed — idempotent

      approved = pending[idx];
      pending.splice(idx, 1);
      _pendingCache = pending;
      await persistPending(pending);

      // Move to active
      const active = await loadActive();
      active.push(approved);
      if (active.length > MAX_ACTIVE) {
        active.splice(0, active.length - MAX_ACTIVE);
      }
      _activeCache = active;
      await persistActive(active);

      // Invalidate response cache for this query
      deleteCache(approved.query);
    })
    .catch((err) => {
      console.error('[feedback] approveFeedback write failed:', err.message);
    });

  await _writeQueue;
  return approved;
}

/**
 * Rejects a pending feedback entry — removes it without applying.
 * Idempotent: no-op if entry not found.
 *
 * @param {string} id - Feedback entry ID
 * @returns {Promise<object|null>} The rejected record, or null if not found
 */
export async function rejectFeedback(id) {
  let rejected = null;

  _writeQueue = _writeQueue
    .then(async () => {
      const pending = await loadPending();
      const idx = pending.findIndex(e => e.id === id);
      if (idx === -1) return; // Already processed — idempotent

      rejected = pending[idx];
      pending.splice(idx, 1);
      _pendingCache = pending;
      await persistPending(pending);
    })
    .catch((err) => {
      console.error('[feedback] rejectFeedback write failed:', err.message);
    });

  await _writeQueue;
  return rejected;
}

/**
 * Returns all pending (unreviewed) feedback entries.
 * Used for testing only.
 *
 * @returns {Promise<Array>}
 */
export async function getPendingFeedback() {
  return loadPending();
}

/**
 * Returns all feedback entries.
 * @returns {Promise<Array>}
 */
export async function getAllFeedback() {
  return loadActive();
}

/**
 * Returns recent feedback entries relevant to a query (keyword-scored).
 * Only returns APPROVED entries from feedback.json.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array>}
 */
export async function getRelevantFeedback(query, limit = 5) {
  const all = await loadActive();
  if (all.length === 0) return [];

  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (queryWords.length === 0) return [];

  const scored = all.map((entry) => {
    const text = `${entry.query} ${entry.integrationType} ${entry.correction}`.toLowerCase();
    const score = queryWords.reduce((acc, w) => {
      if (!text.includes(w)) return acc;
      return acc + 1 + (w.length > 6 ? 1 : 0);
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

- [ ] **Step 2: Clean up test fixture files before running tests**

The Task 1 red-step run may have written entries to `data/feedback.json` (because the old `saveFeedback` writes to the active file and ignores unknown arguments). Before running the full test suite with the new implementation, clear both data files:

```bash
echo "[]" > data/feedback.json
echo "[]" > data/feedback-pending.json
```

- [ ] **Step 3: Run tests — confirm moderation tests PASS**

```bash
npm test
```

Expected: All feedback moderation tests pass. All other existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/slack/feedback.js
git commit -m "feat: add feedback pending queue with approve/reject functions"
```

---

## Task 3: Register approval action handlers in `src/index.js`

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Update the feedback import**

```js
import { saveFeedback, notifyFeedbackChannel, approveFeedback, rejectFeedback } from './slack/feedback.js';
```

- [ ] **Step 2: Add approve and reject action handlers**

After the `feedback_submission` view handler, add:

```js
// ── Approve feedback ──────────────────────────────────────────────────────
app.action('approve_feedback', async ({ ack, body, client, action }) => {
  await ack();

  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  const { feedbackId } = payload;
  if (!feedbackId) return;

  const record = await approveFeedback(feedbackId);
  if (!record) return; // Already processed

  // Get reviewer name
  let reviewerName = body.user.name;
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch { /* use fallback */ }

  // Update review card
  if (record.reviewMessageTs && record.reviewChannelId) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `✅ Approved by ${reviewerName}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `✅ *Approved by ${reviewerName}*\n_Feedback ID: ${record.id}_` },
        },
      ],
    }).catch((err) => app.logger.warn('[feedback] Failed to update review card:', err.message));
  }

  // DM the submitting agent
  await client.chat.postMessage({
    channel: record.agentId,
    text: `✅ Your feedback on *"${record.issueTitle}"* was approved and applied — thanks for helping improve the bot!`,
  }).catch((err) => app.logger.warn('[feedback] Failed to DM agent after approval:', err.message));

  app.logger.info(`[feedback] ${feedbackId} approved by ${reviewerName}`);
});

// ── Reject feedback ───────────────────────────────────────────────────────
app.action('reject_feedback', async ({ ack, body, client, action }) => {
  await ack();

  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  const { feedbackId } = payload;
  if (!feedbackId) return;

  const record = await rejectFeedback(feedbackId);
  if (!record) return; // Already processed

  // Get reviewer name
  let reviewerName = body.user.name;
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch { /* use fallback */ }

  // Update review card
  if (record.reviewMessageTs && record.reviewChannelId) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `❌ Rejected by ${reviewerName}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `❌ *Rejected by ${reviewerName}*\n_Feedback ID: ${record.id}_` },
        },
      ],
    }).catch((err) => app.logger.warn('[feedback] Failed to update review card:', err.message));
  }

  // DM the submitting agent
  await client.chat.postMessage({
    channel: record.agentId,
    text: `Your feedback on *"${record.issueTitle}"* was reviewed and not applied — thanks for flagging it.`,
  }).catch((err) => app.logger.warn('[feedback] Failed to DM agent after rejection:', err.message));

  app.logger.info(`[feedback] ${feedbackId} rejected by ${reviewerName}`);
});
```

- [ ] **Step 3: Update the `feedback_submission` view handler to use the new flow**

In the existing `feedback_submission` handler, change:

```js
// Before:
const record = await saveFeedback({ ... });
await notifyFeedbackChannel(client, record);

// After:
const record = await saveFeedback({ ... });
await notifyFeedbackChannel(client, record);
// DM the submitting agent that feedback is pending review
try {
  await client.chat.postMessage({
    channel: body.user.id,
    text: `Thanks for the feedback! It's been sent for review — if approved, it'll help improve the bot.`,
  });
} catch (err) {
  app.logger.warn(`[feedback] Could not DM submission confirmation to ${body.user.name}: ${err.message}`);
}
```

Remove the old DM confirmation that was there before (the "✅ Thanks for the feedback! Your correction has been saved" message).

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat: register approve/reject feedback handlers with Slack review card updates"
```

---

## Task 4: Update `.env.example` — add `FEEDBACK_REVIEW_CHANNEL_ID`, retire `FEEDBACK_CHANNEL_ID`

Note: Never commit `.env` (it contains real secrets and is gitignored). `.env.example` is the correct file for documenting env vars.

- [ ] **Step 1: Update `.env.example`**

Find the `FEEDBACK_CHANNEL_ID` block (lines 38–40):
```
# Feedback channel — post a Slack notification here when an agent submits wrong-answer feedback
# Must be a channel ID (e.g. C012ABCDEFG), not a channel name
# FEEDBACK_CHANNEL_ID=C012ABCDEFG
```

Replace it with:
```
# Slack channel ID for feedback moderation (Approve/Reject review workflow)
# Create a private channel, add the bot and your reviewers, then paste the channel ID here
# FEEDBACK_CHANNEL_ID is retired — replaced by FEEDBACK_REVIEW_CHANNEL_ID
FEEDBACK_REVIEW_CHANNEL_ID=
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "config: replace FEEDBACK_CHANNEL_ID with FEEDBACK_REVIEW_CHANNEL_ID in .env.example"
```

---

## Task 5: Live test

- [ ] **Step 1: Create the review channel in Slack**

Create `#integrations-bot-reviews` (or any name), add the bot and yourself.

- [ ] **Step 2: Set the channel ID in `.env`**

Copy the channel ID (right-click channel → Copy Link → extract the ID from the URL) and paste it as `FEEDBACK_REVIEW_CHANNEL_ID`.

- [ ] **Step 3: Start the bot**

```bash
npm run dev
```

- [ ] **Step 4: Trigger a Wrong Answer submission**

Ask the bot a question, get a response, click "👎 Wrong Answer", fill in a correction, submit.

Expected:
- Agent (you) receives DM: "Thanks for the feedback! It's been sent for review..."
- Review card appears in `#integrations-bot-reviews` with Approve/Reject buttons
- `data/feedback-pending.json` contains the entry
- `data/feedback.json` does NOT contain the entry yet

- [ ] **Step 5: Click Approve**

Expected:
- Review card updates to "✅ Approved by [your name]"
- Agent receives DM: "Your feedback was approved and applied!"
- Entry moves to `data/feedback.json`
- Entry removed from `data/feedback-pending.json`

- [ ] **Step 6: Click Approve again (double-approve test)**

Expected: No error, no duplicate entry.
