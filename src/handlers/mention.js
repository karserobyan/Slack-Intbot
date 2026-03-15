import { isAccountingTopic } from '../utils/accounting-filter.js';
import { queryWithMcp } from '../claude/query.js';
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
} from '../slack/blocks.js';
import { getCached, setCached } from '../slack/cache.js';

/**
 * Strips the bot mention (<@UXXXXXXX>) from the message text.
 * @param {string} text
 * @returns {string}
 */
function stripBotMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

/**
 * Core handler — shared by both mention.js and dm.js.
 * Posts a "thinking" placeholder, runs Claude, then updates the placeholder.
 *
 * @param {object} params
 * @param {string} params.rawText - Raw message text (may contain bot mention)
 * @param {string} params.channelId - Slack channel to post to
 * @param {string} params.threadTs - Thread timestamp to reply in
 * @param {object} params.client - Slack WebClient
 * @param {string} params.userId - Slack user ID who triggered the bot
 */
export async function handleQuery({ rawText, channelId, threadTs, client, userId }) {
  const query = stripBotMention(rawText);

  if (!query) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "Hi! Ask me about a ServiceTitan integration issue and I'll help you troubleshoot it. For example: _\"Customer's Zapier integration isn't working — they say API access was never set up.\"_",
    });
    return;
  }

  // 1. Fast-path: accounting redirect (no Claude needed)
  if (isAccountingTopic(query)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildAccountingRedirectBlocks(query),
      text: 'This question is about accounting integrations — please redirect to #ask-partner-enabled-accounting-integrations.',
    });
    return;
  }

  // 2. Check cache
  const cached = getCached(query);
  if (cached) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildResponseBlocks(cached),
      text: `Troubleshooting steps for: ${cached.issue_title}`,
    });
    return;
  }

  // 3. Post "thinking" placeholder
  let thinkingTs;
  try {
    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildThinkingBlocks(query),
      text: 'Searching knowledge sources…',
    });
    thinkingTs = thinkingMsg.ts;
  } catch (err) {
    console.error('[mention] Failed to post thinking message:', err.message);
  }

  // 4. Call Claude with both MCP servers
  let result;
  try {
    result = await queryWithMcp(query);
  } catch (err) {
    console.error('[mention] Claude query failed:', err.message);

    const updateTarget = thinkingTs ?? threadTs;
    if (thinkingTs) {
      await client.chat.update({
        channel: channelId,
        ts: updateTarget,
        blocks: buildErrorBlocks(query),
        text: 'Something went wrong — please retry or escalate manually.',
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildErrorBlocks(query),
        text: 'Something went wrong — please retry or escalate manually.',
      });
    }
    return;
  }

  // 5. Cache the result
  setCached(query, result);

  // 6. If Claude itself decided it was an accounting topic (double-check via AI)
  if (result.is_accounting_topic) {
    const accountingBlocks = buildAccountingRedirectBlocks(query);
    if (thinkingTs) {
      await client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        blocks: accountingBlocks,
        text: 'Accounting integration — please redirect to #ask-partner-enabled-accounting-integrations.',
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: accountingBlocks,
        text: 'Accounting integration — please redirect.',
      });
    }
    return;
  }

  // 7. Update the thinking placeholder with the real response
  const responseBlocks = buildResponseBlocks(result);
  const fallbackText = `Troubleshooting: ${result.issue_title} (${result.integration_type})`;

  if (thinkingTs) {
    await client.chat.update({
      channel: channelId,
      ts: thinkingTs,
      blocks: responseBlocks,
      text: fallbackText,
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: responseBlocks,
      text: fallbackText,
    });
  }
}

/**
 * Registers the app_mention event handler on the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerMentionHandler(app) {
  app.event('app_mention', async ({ event, client, logger }) => {
    logger.info(`[mention] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);

    await handleQuery({
      rawText: event.text ?? '',
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      client,
      userId: event.user,
    });
  });
}
