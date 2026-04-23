import { handleQuery } from './mention.js';
import { hasHistory } from '../slack/conversation.js';
import { buildRoutingButtons } from '../slack/blocks.js';

/**
 * Registers the direct message handler on the Bolt app.
 * DMs arrive as message events in an im channel type.
 * We skip bot_message subtypes to avoid echo loops.
 *
 * @param {import('@slack/bolt').App} app
 */
export function registerDmHandler(app) {
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

    try {
      const threadTs = message.thread_ts ?? message.ts;
      const isHelp   = (message.text ?? '').toLowerCase().trim() === 'help' ||
                       (message.text ?? '').toLowerCase().trim() === 'help detail';

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
