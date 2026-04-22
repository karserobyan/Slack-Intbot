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
