import { handleQuery } from './mention.js';
import { buildWelcomeCard, buildSessionCard } from '../slack/blocks.js';

export function registerDmHandler(app) {
  const _inFlight         = new Set();
  const _welcomed         = new Set();
  const _promptedSessions = new Set();

  // Post standing welcome card the first time a user opens the bot
  app.event('app_home_opened', async ({ event, client, logger }) => {
    const userId = event.user;
    if (_welcomed.has(userId)) return;
    _welcomed.add(userId);
    try {
      const dm = await client.conversations.open({ users: userId });
      await client.chat.postMessage({
        channel: dm.channel.id,
        blocks:  buildWelcomeCard(),
        text:    "👋 Welcome to IntBot! Start a chat when you're ready.",
      });
    } catch (err) {
      logger.error(`[dm] Failed to post welcome card to ${userId}:`, err.message);
      _welcomed.delete(userId);
    }
  });

  // "New chat" button — post a fresh session card
  app.action('new_chat', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    try {
      await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
    } catch (err) {
      logger.error('[dm] Failed to post session card:', err.message);
    }
  });

  // "Ask an integration question" button — post thread prompt (double-click safe)
  app.action('start_chat_thread', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    const sessionTs = body.message.ts;
    if (_promptedSessions.has(sessionTs)) return;
    _promptedSessions.add(sessionTs);
    setTimeout(() => _promptedSessions.delete(sessionTs), 86_400_000);
    try {
      await client.chat.postMessage({
        channel:   channelId,
        thread_ts: sessionTs,
        text:      'What integration issue are you working on? 👇',
      });
    } catch (err) {
      logger.error('[dm] Failed to post thread prompt:', err.message);
      _promptedSessions.delete(sessionTs);
    }
  });

  // DM message handler — top-level message starts a new thread, reply continues its thread
  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype || message.bot_id) return;

    if (_inFlight.has(message.ts)) {
      logger.warn(`[dm] Duplicate event ${message.ts} — skipping`);
      return;
    }
    _inFlight.add(message.ts);

    const userId    = message.user;
    const channelId = message.channel;
    const isThreadReply = !!message.thread_ts && message.thread_ts !== message.ts;
    const threadTs  = isThreadReply ? message.thread_ts : message.ts;

    try {
      await handleQuery({
        rawText:  message.text ?? '',
        channelId,
        threadTs,
        client,
        userId,
        isDm: true,
      });
    } catch (err) {
      logger.error(`[dm] Error handling message ${message.ts}:`, err.message);
    } finally {
      setTimeout(() => _inFlight.delete(message.ts), 60_000);
    }
  });
}
