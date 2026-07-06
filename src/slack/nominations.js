/**
 * Nomination system for bot-response knowledge entries.
 *
 * Flow:
 *   1. nominateResponse() posts to the feedback review channel with Approve/Reject buttons.
 *   2. Moderator clicks Approve → approveNomination() writes to knowledge.md, posts confirmation.
 *   3. Moderator clicks Reject → rejectNomination() removes from pending, no write.
 *
 * Pending nominations are persisted to data/nominations-pending.json (atomic
 * writes) so they survive bot restarts/redeploys — approve/reject still work
 * after a deploy.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { appendBotResponse } from './knowledge-writer.js';
import { getFeedbackChannelId } from '../utils/feedback-channel.js';

const NOMINATION_ID_PREFIX = 'nom_';

// Pending nominations persist to disk so they survive bot restarts/redeploys.
// Without this, a moderator approving a review card after a redeploy hits an
// empty in-memory map → silent no-op while the card still shows the buttons.
// (Mirrors the atomic-write pattern in feedback.js.)
let _file = join(process.cwd(), 'data', 'nominations-pending.json');
/** @type {Map<string, object>|null} nominationId → record; null until first load */
let _pending = null;
let _writeQueue = Promise.resolve();

async function loadPending() {
  if (_pending !== null) return _pending;
  let arr = [];
  try {
    arr = JSON.parse(await readFile(_file, 'utf-8'));
  } catch (err) {
    // ENOENT = no pending nominations yet (normal). Other errors: log and start
    // empty — a corrupt low-stakes queue shouldn't block approve/reject.
    if (err.code !== 'ENOENT') {
      console.error(`[nominations] Failed to read ${_file} (${err.code ?? err.name}): ${err.message} — starting empty.`);
    }
  }
  _pending = new Map(arr.map((r) => [r.id, r]));
  return _pending;
}

// Atomic write (temp + rename) of the current pending map, serialised via a
// queue so concurrent approvals can't clobber each other or truncate the file.
function persistPending() {
  const snapshot = [...(_pending?.values() ?? [])];
  _writeQueue = _writeQueue
    .then(async () => {
      await mkdir(dirname(_file), { recursive: true });
      const tmp = `${_file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot, null, 2));
      await rename(tmp, _file);
    })
    .catch((err) => console.error('[nominations] persist failed:', err.message));
  return _writeQueue;
}

// Test-only: point storage at a temp file and reset the in-memory cache so a
// "restart" (fresh load from disk) can be simulated.
export function _setStoreForTest(path) {
  _file = path;
  _pending = null;
  _writeQueue = Promise.resolve();
}

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
 * Posts a review card to the feedback channel. No-op if no channel configured.
 * @param {object} client - Slack WebClient
 * @param {object} record - { integration, issueTitle, steps, refs }
 * @returns {Promise<object|null>}
 */
export async function nominateResponse(client, record) {
  const channelId = getFeedbackChannelId();
  if (!channelId) {
    console.warn('[nominations] No feedback channel set — nomination skipped.');
    return null;
  }

  const date = new Date().toISOString().slice(0, 10);
  const refsText = record.refs?.length > 0 ? ` Confirmed in ${record.refs.join(' + ')}.` : '';
  const proposedEntry = `- [auto, ${date}] ${record.issueTitle}: ${record.steps.join('; ')}.${refsText}`;

  const nomination = {
    id: `${NOMINATION_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, // base-36 = 0-9 + a-z
    timestamp: new Date().toISOString(),
    integration: record.integration,
    issueTitle: record.issueTitle,
    steps: record.steps,
    refs: record.refs ?? [],
    proposedEntry,
    reviewMessageTs: null,
    reviewChannelId: channelId,
  };

  const pending = await loadPending();
  pending.set(nomination.id, nomination);
  await persistPending();

  try {
    const msg = await client.chat.postMessage({
      channel: channelId,
      text: `📝 Knowledge Nomination — ${record.integration}: ${record.issueTitle}`,
      blocks: buildNominationBlocks(nomination),
    });
    nomination.reviewMessageTs = msg.ts;
    await persistPending(); // save the review message ts for later card updates
  } catch (err) {
    console.error('[nominations] Failed to post nomination card:', err.message);
    pending.delete(nomination.id);
    await persistPending();
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
  const pending = await loadPending();
  const record = pending.get(id);
  if (!record) return null;

  const written = await appendBotResponse(record.integration, record.issueTitle, record.steps, record.refs, undefined, client);
  if (!written) {
    throw new Error(`Knowledge write failed for nomination ${id}`);
  }

  pending.delete(id);
  await persistPending();

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
  const pending = await loadPending();
  const record = pending.get(id);
  if (!record) return null;
  pending.delete(id);
  await persistPending();

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
