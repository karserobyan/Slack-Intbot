import { handleQuery } from './mention.js';

/**
 * Registers the direct message handler on the Bolt app.
 * DMs arrive as message events in an im channel type.
 * We skip bot_message subtypes to avoid echo loops.
 *
 * @param {import('@slack/bolt').App} app
 */
export function registerDmHandler(app) {
  app.message(async ({ message, client, logger }) => {
    // Only handle DMs (channel_type === 'im') from real users
    if (message.channel_type !== 'im') return;
    if (message.subtype === 'bot_message' || message.bot_id) return;

    logger.info(`[dm] ${message.user}: ${message.text?.slice(0, 80)}`);

    await handleQuery({
      rawText: message.text ?? '',
      channelId: message.channel,
      threadTs: message.thread_ts ?? message.ts,
      client,
      userId: message.user,
    });
  });
}
