import { isAccountingTopic } from '../utils/accounting-filter.js';
import { queryWithContext } from '../claude/query.js';
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
} from '../slack/blocks.js';
import { getCached, setCached } from '../slack/cache.js';
import { getRelevantFeedback } from '../slack/feedback.js';
import { checkRateLimit, rateLimitResetIn } from '../utils/rate-limiter.js';

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

  // Rate limit — prevent a single user from spamming Claude calls
  if (!checkRateLimit(userId)) {
    const resetIn = rateLimitResetIn(userId);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `⏳ You're sending requests too quickly. Please wait ${resetIn}s before trying again.`,
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

  // 4. Look up past corrections to inject as context
  let feedbackContext = '';
  try {
    const corrections = await getRelevantFeedback(query);
    if (corrections.length > 0) {
      // Sanitize corrections before injecting into the Claude prompt to prevent prompt injection.
      // Strip markdown headers and limit length on each field.
      const sanitize = (str) => String(str ?? '')
        .replace(/^#+\s*/gm, '')   // remove markdown headers
        .replace(/^\s*[-*>]+/gm, '') // remove list/quote markers at line start
        .trim()
        .slice(0, 300);

      const lines = corrections.map(
        (c) => `- Query: "${sanitize(c.query)}" → Bot was wrong (${c.feedbackType}). Correct answer: ${sanitize(c.correction)}`,
      );
      feedbackContext = `\n\nIMPORTANT — Past corrections from agents (use these to avoid repeating mistakes):\n${lines.join('\n')}`;
    }
  } catch {
    // feedback lookup failure is non-critical
  }

  // 5. Call Claude with both MCP servers
  let result;
  try {
    result = await queryWithContext(query + feedbackContext);
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

  // 6. Attach original query for the feedback button, then cache
  result._originalQuery = query;
  setCached(query, result);

  // 7. If Claude itself decided it was an accounting topic (double-check via AI)
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

  // 8. Update the thinking placeholder with the real response
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
  // Lightweight dedup — prevents double-processing if Socket Mode reconnects
  // mid-delivery and replays an in-flight event.
  const _inFlight = new Set();

  app.event('app_mention', async ({ event, client, logger }) => {
    if (_inFlight.has(event.ts)) {
      logger.warn(`[mention] Duplicate event ${event.ts} — skipping`);
      return;
    }
    _inFlight.add(event.ts);

    logger.info(`[mention] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);

    try {
      await handleQuery({
        rawText: event.text ?? '',
        channelId: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        client,
        userId: event.user,
      });
    } finally {
      // Remove after 60s — keeps the Set from growing forever while still
      // covering Slack's retry window (well under 60s).
      setTimeout(() => _inFlight.delete(event.ts), 60_000);
    }
  });
}
