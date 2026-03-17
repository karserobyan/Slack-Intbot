/**
 * Feedback storage — persists "wrong answer" corrections to a local JSON file
 * and optionally posts to a Slack channel for team visibility.
 *
 * Design:
 * - Write queue: all writes are serialised via a Promise chain to prevent concurrent
 *   write races that could corrupt or lose entries. The .catch() guard prevents a
 *   failed write from poisoning the queue for future writes.
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
