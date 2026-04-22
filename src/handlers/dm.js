import { handleQuery } from './mention.js';

/**
 * Registers the direct message handler on the Bolt app.
 * DMs arrive as message events in an im channel type.
 * We skip bot_message subtypes to avoid echo loops.
 *
 * @param {import('@slack/bolt').App} app
 */
export function registerDmHandler(app) {
  // Lightweight dedup — same pattern as mention.js
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
      await handleQuery({
        rawText: message.text ?? '',
        channelId: message.channel,
        threadTs: message.thread_ts ?? message.ts,
        client,
        userId: message.user,
        isDm: true,
      });
    } finally {
      setTimeout(() => _inFlight.delete(message.ts), 60_000);
    }
  });
}
