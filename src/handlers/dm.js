import { handleQuery } from './mention.js';
import { buildWelcomeCard, buildSessionCard } from '../slack/blocks.js';

export function registerDmHandler(app) {
  const _inFlight         = new Set();
  const _welcomed         = new Set();
  const _promptedSessions = new Set();
  const _activeSessions   = new Set();
  const _latestSession    = new Map(); // channelId → most recent sessionTs

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
      _welcomed.delete(userId); // allow retry on next open
    }
  });

  // "New chat" button — post a fresh session card to the DM channel
  app.action('new_chat', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    try {
      const sessionMsg = await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
      const newTs = sessionMsg.ts;
      _activeSessions.add(newTs);
      _latestSession.set(channelId, newTs);
      setTimeout(() => {
        _activeSessions.delete(newTs);
        if (_latestSession.get(channelId) === newTs) _latestSession.delete(channelId);
      }, 7 * 24 * 3_600_000);
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
    _activeSessions.add(sessionTs);
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

  // DM message handler — thread replies go to handleQuery; top-level triggers fallback
  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype === 'bot_message' || message.bot_id) return;

    logger.info(`[dm] Message: ts=${message.ts} thread_ts=${message.thread_ts ?? 'none'} channel_type=${message.channel_type} subtype=${message.subtype ?? 'none'}`);

    if (_inFlight.has(message.ts)) {
      logger.warn(`[dm] Duplicate event ${message.ts} — skipping`);
      return;
    }
    _inFlight.add(message.ts);

    const userId    = message.user;
    const channelId = message.channel;

    try {
      const isThreadReply =
        (message.thread_ts && message.thread_ts !== message.ts) ||
        _activeSessions.has(message.thread_ts);

      if (isThreadReply) {
        logger.info(`[dm] Thread reply: ts=${message.ts} thread_ts=${message.thread_ts} channel=${message.channel}`);
        await handleQuery({
          rawText:  message.text ?? '',
          channelId,
          threadTs: message.thread_ts,
          client,
          userId,
          isDm: true,
        });
        return;
      }

      // Top-level DM — route to existing session if one exists
      const existingTs = _latestSession.get(channelId);
      if (existingTs) {
        await handleQuery({
          rawText:  message.text ?? '',
          channelId,
          threadTs: existingTs,
          client,
          userId,
          isDm: true,
        });
        return;
      }

      // No existing session — first contact: welcome → session card → prompt → answer
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
      const sessionTs = sessionMsg.ts;
      _activeSessions.add(sessionTs);
      _latestSession.set(channelId, sessionTs);
      setTimeout(() => {
        _activeSessions.delete(sessionTs);
        if (_latestSession.get(channelId) === sessionTs) _latestSession.delete(channelId);
      }, 7 * 24 * 3_600_000);
      _promptedSessions.add(sessionTs);
      setTimeout(() => _promptedSessions.delete(sessionTs), 86_400_000);

      await client.chat.postMessage({
        channel:   channelId,
        thread_ts: sessionTs,
        text:      'What integration issue are you working on? 👇',
      });

      await handleQuery({
        rawText:  message.text ?? '',
        channelId,
        threadTs: sessionTs,
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
