/**
 * Feedback storage — persists "wrong answer" corrections to a local JSON file
 * and optionally posts to a Slack channel for team visibility.
 *
 * Feedback is used to improve the system prompt over time by building a
 * corrections library that Claude can reference.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const FEEDBACK_DIR = join(process.cwd(), 'data');
const FEEDBACK_FILE = join(FEEDBACK_DIR, 'feedback.json');

// Optional: post feedback to a Slack channel for team visibility
const FEEDBACK_CHANNEL = process.env.FEEDBACK_CHANNEL_ID || null;

/**
 * Loads existing feedback entries from disk.
 * @returns {Promise<Array>}
 */
async function loadFeedback() {
  try {
    const raw = await readFile(FEEDBACK_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Saves a new feedback entry.
 *
 * @param {object} entry
 * @param {string} entry.query - Original agent query
 * @param {string} entry.issueTitle - Bot's generated issue title
 * @param {string} entry.integrationType - Bot's detected integration type
 * @param {string} entry.feedbackType - "wrong_answer" | "partially_correct" | "outdated"
 * @param {string} entry.correction - Agent's correction / correct answer
 * @param {string} entry.agentId - Slack user ID of the agent
 * @param {string} entry.agentName - Slack display name
 * @returns {Promise<object>} The saved entry with id and timestamp
 */
export async function saveFeedback(entry) {
  if (!existsSync(FEEDBACK_DIR)) {
    await mkdir(FEEDBACK_DIR, { recursive: true });
  }

  const feedback = await loadFeedback();

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

  feedback.push(record);
  await writeFile(FEEDBACK_FILE, JSON.stringify(feedback, null, 2));

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
          text: {
            type: 'mrkdwn',
            text: `*Original query:*\n>${record.query}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Bot said:*\n>${record.issueTitle}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Correction:*\n>${record.correction}`,
          },
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
 * Returns all feedback entries (for building correction context).
 * @returns {Promise<Array>}
 */
export async function getAllFeedback() {
  return loadFeedback();
}

/**
 * Returns recent feedback entries relevant to a query (simple keyword match).
 * Used to inject corrections into the Claude system prompt.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array>}
 */
export async function getRelevantFeedback(query, limit = 5) {
  const all = await loadFeedback();
  if (all.length === 0) return [];

  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

  const scored = all.map((entry) => {
    const text = `${entry.query} ${entry.integrationType} ${entry.correction}`.toLowerCase();
    const matches = queryWords.filter((w) => text.includes(w)).length;
    return { entry, score: matches };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}
