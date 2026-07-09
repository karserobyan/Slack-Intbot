import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { registerMentionHandler } from './handlers/mention.js';
import { registerDmHandler } from './handlers/dm.js';
import { registerAutoAnswerHandler } from './handlers/auto-answer.js';
import { buildFeedbackModal, buildResponseBlocks, buildSourcesModal, buildThinkingBlocks, buildErrorBlocks } from './slack/blocks.js';
import { getFeedbackChannelId } from './utils/feedback-channel.js';
import { pruneExpired, cacheStats } from './slack/cache.js';
import { pruneConversations, appendToHistory } from './slack/conversation.js';
import { queryWithContext } from './claude/query.js';
import { initFeedbackStorage, getUnpostedPending, notifyFeedbackChannel } from './slack/feedback.js';
import { handleFeedbackSubmission } from './slack/feedback-submission.js';
import { buildChannelPostModal } from './slack/modal.js';
import { handleFeedbackReviewAction, handleNominationReviewAction } from './slack/review-actions.js';

function decodeActionText(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

// ── Validate required environment variables ──────────────────────────────────
const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[startup] Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// ── Initialise Slack Bolt app ────────────────────────────────────────────────
const isSocketMode = Boolean(process.env.SLACK_APP_TOKEN);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(isSocketMode
    ? {
        socketMode: true,
        appToken: process.env.SLACK_APP_TOKEN,
      }
    : {
        // HTTP mode — Slack posts events to your public URL
        // Set PORT env var to control the port (default 3000)
      }),
  logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

// ── Register event handlers ──────────────────────────────────────────────────
registerMentionHandler(app);
registerDmHandler(app);
registerAutoAnswerHandler(app);

// ── "Wrong Answer" button — opens feedback modal ─────────────────────────────
app.action('wrong_answer_modal', async ({ ack, body, client, action, logger }) => {
  await ack();

  let context = { query: '', issueTitle: '', integrationType: '' };
  try {
    context = JSON.parse(action.value);
  } catch {
    // fallback to empty context
  }
  context = {
    query: decodeActionText(context.query),
    issueTitle: decodeActionText(context.issueTitle),
    integrationType: decodeActionText(context.integrationType),
  };

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildFeedbackModal(context),
    });
  } catch (err) {
    logger.error('[index] Failed to open feedback modal:', err.message);
  }
});

// ── "Sources" button — opens sources modal ───────────────────────────────────
app.action('view_sources_modal', async ({ ack, body, client, action, logger }) => {
  await ack();
  let refsData = { diagnosis: null, slack_refs: [], atlassian_refs: [], kb_refs: [] };
  try { refsData = JSON.parse(action.value); } catch { /* show empty modal on bad JSON */ }
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildSourcesModal(refsData),
    });
  } catch (err) {
    logger.error('[index] Failed to open sources modal:', err.message);
  }
});

// ── "Channel post" button — opens copy-paste modal ───────────────────────────
app.action('copy_channel_post', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildChannelPostModal(body.actions[0].value),
    });
  } catch (err) {
    logger.error('[index] Failed to open channel post modal:', err.message);
  }
});

// ── "Show Specialist Detail" button ──────────────────────────────────────────
app.action('show_specialist_detail', async ({ ack, body, client, action }) => {
  await ack();

  let context = { threadTs: null, channelId: null, query: '' };
  try {
    context = JSON.parse(action.value);
  } catch {
    // malformed value — abort
    return;
  }

  const { threadTs, channelId, query } = context;
  if (!threadTs || !channelId || !query) return;

  const userId = body.user.id;

  // Get agent name for personalised response
  let agentName = null;
  try {
    const res = await client.users.info({ user: userId });
    agentName = res.user?.profile?.display_name || res.user?.profile?.real_name || null;
  } catch {
    // non-critical
  }

  // Post a thinking placeholder in the thread
  let thinkingTs;
  try {
    const msg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: 'Pulling up the full specialist view…',
    });
    thinkingTs = msg.ts;
  } catch {
    // continue without placeholder
  }

  let result;
  try {
    result = await queryWithContext(query, { role: 'specialist', agentName });
  } catch (err) {
    app.logger.error('[show_specialist_detail] queryWithContext failed:', err.message);
    const errText = 'Something went wrong fetching specialist detail — please retry.';
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText });
    }
    return;
  }

  result._originalQuery = query;
  const responseBlocks = buildResponseBlocks(result, { role: 'specialist' });
  const fallbackText = `Specialist view: ${result.issue_title}`;

  try {
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: responseBlocks, text: fallbackText });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: responseBlocks, text: fallbackText });
    }
  } catch (err) {
    app.logger.error('[show_specialist_detail] Failed to deliver specialist view:', err.message);
    const errText = 'Could not render the specialist view — please retry.';
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText, blocks: [] }).catch(() => {});
    }
    return;
  }

  // Append to conversation history
  appendToHistory(threadTs, [
    { role: 'user', content: `[Specialist detail requested] ${query}` },
    { role: 'assistant', content: JSON.stringify(result) },
  ]);
});

// ── Feedback modal submission ────────────────────────────────────────────────
app.view('feedback_submission', async ({ ack, body, view, client }) => {
  await ack();
  await handleFeedbackSubmission({ body, view, client, logger: app.logger });
});

// ── Approve feedback ──────────────────────────────────────────────────────────
app.action('approve_feedback', async ({ ack, body, client, action, respond }) => {
  await ack();
  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  try {
    await handleFeedbackReviewAction({
      decision: 'approve',
      feedbackId: payload.feedbackId,
      body,
      client,
      respond,
      logger: app.logger,
    });
  } catch (err) {
    app.logger.error(`[feedback] approve_feedback failed: ${err.message}`);
    await respond?.({ response_type: 'ephemeral', text: 'Approval failed. The feedback was not changed.' }).catch(() => {});
  }
});

// ── Reject feedback ───────────────────────────────────────────────────────────
app.action('reject_feedback', async ({ ack, body, client, action, respond }) => {
  await ack();
  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  try {
    await handleFeedbackReviewAction({
      decision: 'reject',
      feedbackId: payload.feedbackId,
      body,
      client,
      respond,
      logger: app.logger,
    });
  } catch (err) {
    app.logger.error(`[feedback] reject_feedback failed: ${err.message}`);
    await respond?.({ response_type: 'ephemeral', text: 'Rejection failed. The feedback was not changed.' }).catch(() => {});
  }
});

// ── Approve nomination ────────────────────────────────────────────────────────
app.action('approve_nomination', async ({ ack, body, client, action, respond }) => {
  await ack();
  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  try {
    await handleNominationReviewAction({
      decision: 'approve',
      nominationId: payload.nominationId,
      body,
      client,
      respond,
      logger: app.logger,
    });
  } catch (err) {
    app.logger.error(`[nominations] approve_nomination failed: ${err.message}`);
    await respond?.({ response_type: 'ephemeral', text: 'Approval failed. The nomination was not changed.' }).catch(() => {});
  }
});

// ── Reject nomination ─────────────────────────────────────────────────────────
app.action('reject_nomination', async ({ ack, body, client, action, respond }) => {
  await ack();
  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  try {
    await handleNominationReviewAction({
      decision: 'reject',
      nominationId: payload.nominationId,
      body,
      client,
      respond,
      logger: app.logger,
    });
  } catch (err) {
    app.logger.error(`[nominations] reject_nomination failed: ${err.message}`);
    await respond?.({ response_type: 'ephemeral', text: 'Rejection failed. The nomination was not changed.' }).catch(() => {});
  }
});

// ── Periodic cache prune (every 15 minutes) ──────────────────────────────────
setInterval(
  () => {
    pruneExpired();
    pruneConversations();
    const stats = cacheStats();
    app.logger.info(`[cache] Pruned expired entries. Current size: ${stats.size}/${stats.maxEntries}`);
  },
  15 * 60 * 1000,
);

// ── Health check endpoint (HTTP mode) ────────────────────────────────────────
app.receiver?.router?.get?.('/health', (_req, res) => {
  const stats = cacheStats();
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    cache: stats,
    mcp: {
      slack: Boolean(process.env.SLACK_USER_TOKEN && process.env.SLACK_USER_TOKEN !== 'xoxp-replace-me'),
      atlassian: Boolean(process.env.ATLASSIAN_API_TOKEN),
    },
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
(async () => {
  const port = parseInt(process.env.PORT ?? '3000', 10);

  if (isSocketMode) {
    await app.start();
    app.logger.info('[startup] ⚡ IntegrationsBot started in Socket Mode');
  } else {
    await app.start(port);
    app.logger.info(`[startup] ⚡ IntegrationsBot started on port ${port} (HTTP mode)`);
  }

  app.logger.info('[startup] Bot is ready. Mention @IntegrationsBot or DM it to get started.');

  // Check users:read scope is available for role detection
  try {
    await app.client.users.info({ user: 'USLACKBOT' }); // USLACKBOT always exists
  } catch (err) {
    if (err.message?.includes('missing_scope')) {
      app.logger.error('[startup] WARNING: users:read scope missing — role detection will always default to CSA mode. Add users:read to bot token scopes and reinstall.');
    }
  }

  const feedbackChannel = getFeedbackChannelId();
  app.logger.info(`[startup] Feedback review channel: ${feedbackChannel ? feedbackChannel : '❌ NOT SET — review cards will not be posted. Set FEEDBACK_REVIEW_CHANNEL_ID and invite the bot to that channel.'}`);

  // Ensure data dir exists (prevents silent write failures on first run)
  await initFeedbackStorage();

  // Retry posting review cards for stuck pending entries (notifyFeedbackChannel
  // failed previously — bot was not yet in the review channel, or channel was unset)
  if (feedbackChannel) {
    try {
      const stuck = await getUnpostedPending();
      if (stuck.length > 0) {
        app.logger.warn(`[feedback] ${stuck.length} pending feedback entry(ies) never got a review card — retrying now...`);
        for (const record of stuck) {
          await notifyFeedbackChannel(app.client, record);
        }
        app.logger.info('[feedback] Retry complete.');
      }
    } catch (err) {
      app.logger.warn('[feedback] Startup retry for stuck pending entries failed:', err.message);
    }
  }

  const hasMcpSlack = Boolean(process.env.SLACK_USER_TOKEN && process.env.SLACK_USER_TOKEN !== 'xoxp-replace-me');
  const hasAtlassianApi = Boolean(process.env.ATLASSIAN_API_TOKEN);
  app.logger.info(
    `[startup] Search: Slack MCP=${hasMcpSlack ? '✅' : '❌ (set SLACK_USER_TOKEN)'}  Atlassian REST=${hasAtlassianApi ? '✅' : '❌ (set ATLASSIAN_API_TOKEN)'}`,
  );
})();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  app.logger.info(`[shutdown] ${signal} received — shutting down gracefully`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
