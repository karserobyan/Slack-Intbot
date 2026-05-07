import { handleQuery } from './mention.js';
import { buildWelcomeCard, buildSessionCard } from '../slack/blocks.js';

export function registerDmHandler(app) {
  const _inFlight         = new Set();
  const _welcomed         = new Set();
  const _promptedSessions = new Set();
  const _latestSession    = new Map(); // channelId → current sessionTs (one at a time)

  const SESSION_TTL = 7 * 24 * 3_600_000;

  function openSession(channelId, sessionTs) {
    _latestSession.set(channelId, sessionTs);
    setTimeout(() => {
      if (_latestSession.get(channelId) === sessionTs) _latestSession.delete(channelId);
    }, SESSION_TTL);
  }

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

  // "New chat" button — post a fresh session card; all future messages go here
  app.action('new_chat', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    try {
      const sessionMsg = await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
      openSession(channelId, sessionMsg.ts);
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

  // DM message handler — everything routes to the one active session
  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype === 'bot_message' || message.bot_id) return;

    if (_inFlight.has(message.ts)) {
      logger.warn(`[dm] Duplicate event ${message.ts} — skipping`);
      return;
    }
    _inFlight.add(message.ts);

    const userId    = message.user;
    const channelId = message.channel;

    try {
      const sessionTs = _latestSession.get(channelId);
      const isThreadReply = message.thread_ts && message.thread_ts !== message.ts;

      if (sessionTs || isThreadReply) {
        const threadTs = sessionTs ?? message.thread_ts;
        if (!sessionTs) openSession(channelId, threadTs); // re-anchor after restart
        await handleQuery({
          rawText:  message.text ?? '',
          channelId,
          threadTs,
          client,
          userId,
          isDm: true,
        });
        return;
      }

      // No session, not a thread reply — first contact: welcome → session card → prompt → answer
      if (!_welcomed.has(userId)) {
        _welcomed.add(userId);
        await client.chat.postMessage({
          channel: channelId,
          blocks:  buildWelcomeCard(),
          text:    "👋 Welcome to IntBot!",
        });
      }

      const sessionMsg = await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
      const newSessionTs = sessionMsg.ts;
      openSession(channelId, newSessionTs);
      _promptedSessions.add(newSessionTs);
      setTimeout(() => _promptedSessions.delete(newSessionTs), 86_400_000);

      await client.chat.postMessage({
        channel:   channelId,
        thread_ts: newSessionTs,
        text:      'What integration issue are you working on? 👇',
      });

      await handleQuery({
        rawText:  message.text ?? '',
        channelId,
        threadTs: newSessionTs,
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
