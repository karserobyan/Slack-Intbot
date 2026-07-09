import { runPipeline } from '../claude/pipeline.js';
import { buildAutoAnswerBlocks } from '../slack/blocks.js';
import { isAccountingTopic } from '../utils/accounting-filter.js';

const MIN_QUERY_LEN = 8;
const DEDUPE_TTL_MS = 60_000;

function isEnabled() {
  return process.env.AUTO_ANSWER_ENABLED === 'true';
}

function getSourceChannelId() {
  return process.env.AUTO_ANSWER_SOURCE_CHANNEL ?? '';
}

function getTargetChannelId() {
  return process.env.AUTO_ANSWER_TARGET_CHANNEL ?? '';
}

/**
 * Returns true if the message event should NOT trigger an auto-answer.
 * Reasons: bot/system message, edit/delete, thread reply, wrong channel,
 * too short, or already processed (dedupe).
 */
export function shouldSkipMessage(event, { processedTs }) {
  if (!event) return true;
  if (event.subtype) return true;
  if (event.bot_id) return true;
  if (event.thread_ts && event.thread_ts !== event.ts) return true;
  if (event.channel !== getSourceChannelId()) return true;
  const text = (event.text ?? '').trim();
  if (text.length < MIN_QUERY_LEN) return true;
  if (processedTs.has(event.ts)) return true;
  return false;
}

export async function handleAutoAnswer({ event, client, logger }) {
  const query = (event.text ?? '').trim();
  const targetChannel = getTargetChannelId();
  const sourceChannel = getSourceChannelId();

  if (!targetChannel) {
    logger?.warn?.('[auto-answer] AUTO_ANSWER_TARGET_CHANNEL not set — dropping draft');
    return;
  }

  if (isAccountingTopic(query)) {
    logger?.info?.(`[auto-answer] Skipping accounting topic: ${query.slice(0, 60)}`);
    return;
  }

  let permalink = null;
  try {
    const res = await client.chat.getPermalink({ channel: sourceChannel, message_ts: event.ts });
    if (res?.ok) permalink = res.permalink;
  } catch (err) {
    logger?.warn?.(`[auto-answer] getPermalink failed: ${err.message}`);
  }

  let result;
  try {
    result = await runPipeline({ rawQuery: query, role: 'csa' });
  } catch (err) {
    logger?.error?.(`[auto-answer] pipeline failed for ts=${event.ts}: ${err.message}`);
    await client.chat.postMessage({
      channel: targetChannel,
      text: `Auto-answer failed for <${permalink ?? '#'}|new #ask-integrations post>: ${err.message.slice(0, 200)}`,
    }).catch(() => {});
    return;
  }

  if (result.clarifying_question) {
    logger?.info?.(`[auto-answer] Pipeline asked clarifying question — skipping draft (ts=${event.ts})`);
    await client.chat.postMessage({
      channel: targetChannel,
      text: `Skipped: pipeline wanted to clarify rather than answer. Original: ${permalink ?? '(no link)'}`,
    }).catch(() => {});
    return;
  }

  if (result.is_accounting_topic) {
    logger?.info?.(`[auto-answer] Pipeline flagged accounting — skipping (ts=${event.ts})`);
    return;
  }

  const blocks = buildAutoAnswerBlocks({
    originalUrl: permalink,
    sourceChannelId: sourceChannel,
    originalUserId: event.user,
    query,
    result,
  });

  const fallback = (result.customer_message ?? result.issue_title ?? 'New auto-answer').slice(0, 200);

  await client.chat.postMessage({
    channel: targetChannel,
    blocks,
    text: fallback,
    unfurl_links: false,
    unfurl_media: false,
  });
}

/**
 * Startup self-check. A silent "no drafts ever post" almost always means the
 * bot never receives message events — because it is not a member of the source
 * channel, or the token lacks channels:read/channels:history. This probes the
 * source channel once at boot and logs a loud, specific warning so the failure
 * is visible instead of silent. It cannot detect a missing `message.channels`
 * event subscription (that is Slack-app config, not reachable via the API).
 */
export async function verifyChannelAccess(client, channelId, logger) {
  const log = logger ?? console;
  try {
    const res = await client.conversations.info({ channel: channelId });
    if (!res?.ok) {
      log.warn?.(`[auto-answer] conversations.info for source channel ${channelId} returned not-ok: ${res?.error}`);
      return;
    }
    if (res.channel?.is_member === false) {
      log.warn?.(`[auto-answer] Bot is NOT a member of source channel ${channelId} — it will receive zero message events. Run "/invite @IntegrationsBot" in that channel.`);
      return;
    }
    log.info?.(`[auto-answer] Source channel ${channelId} access verified (bot is a member).`);
  } catch (err) {
    const code = err.data?.error;
    if (code === 'missing_scope') {
      log.warn?.(`[auto-answer] Missing Slack scope for source channel ${channelId}: needs "${err.data?.needed ?? 'channels:read'}". Add channels:read + channels:history to the bot token, subscribe to the message.channels event, reinstall the app, and invite the bot to the source channel.`);
    } else if (code === 'channel_not_found') {
      log.warn?.(`[auto-answer] Source channel ${channelId} not found — AUTO_ANSWER_SOURCE_CHANNEL must be a channel ID (e.g. C0123ABCD), not a name. For private channels, the bot must be invited and may need groups:read/groups:history if private-channel support is added later.`);
    } else {
      log.warn?.(`[auto-answer] Could not verify access to source channel ${channelId}: ${err.message}`);
    }
  }
}

export function registerAutoAnswerHandler(app) {
  if (!isEnabled()) {
    console.info('[auto-answer] AUTO_ANSWER_ENABLED is not "true" — handler not registered');
    return;
  }
  const sourceChannel = getSourceChannelId();
  const targetChannel = getTargetChannelId();
  if (!sourceChannel || !targetChannel) {
    console.warn('[auto-answer] AUTO_ANSWER_SOURCE_CHANNEL or AUTO_ANSWER_TARGET_CHANNEL not set — handler not registered');
    return;
  }
  console.info(`[auto-answer] Enabled — source=${sourceChannel} target=${targetChannel}`);

  if (app.client) {
    verifyChannelAccess(app.client, sourceChannel, app.logger).catch(() => {});
  }

  const processedTs = new Set();

  app.event('message', async ({ event, client, logger }) => {
    if (shouldSkipMessage(event, { processedTs })) return;

    processedTs.add(event.ts);
    setTimeout(() => processedTs.delete(event.ts), DEDUPE_TTL_MS);

    logger.info(`[auto-answer] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);
    try {
      await handleAutoAnswer({ event, client, logger });
    } catch (err) {
      logger.error?.(`[auto-answer] unhandled error: ${err.message}`);
    }
  });
}
