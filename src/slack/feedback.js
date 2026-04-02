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
      // Idempotent: don't add if already in active (double-approve)
      if (!active.some(e => e.id === id)) {
        active.push(approved);
        if (active.length > MAX_ACTIVE) {
          active.splice(0, active.length - MAX_ACTIVE);
        }
        _activeCache = active;
        await persistActive(active);
      }

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
