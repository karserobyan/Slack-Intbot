/**
 * PARKED FEATURE — Routing buttons for the DM entry point.
 *
 * Re-enable by:
 *   1. In dm.js — swap registerDmHandler for registerDmHandlerWithRouting:
 *        import { registerDmHandlerWithRouting } from '../slack/routing-buttons.js';
 *        registerDmHandlerWithRouting(app);
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
