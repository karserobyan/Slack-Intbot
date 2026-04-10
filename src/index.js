import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { registerMentionHandler } from './handlers/mention.js';
import { registerDmHandler } from './handlers/dm.js';
import { buildEmailModal, buildFeedbackModal, buildResponseBlocks } from './slack/blocks.js';
import { pruneExpired, cacheStats } from './slack/cache.js';
import { pruneConversations, appendToHistory } from './slack/conversation.js';
import { queryWithContext } from './claude/query.js';
import { saveFeedback, notifyFeedbackChannel, approveFeedback, rejectFeedback, initFeedbackStorage, getUnpostedPending } from './slack/feedback.js';

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

// ── "Copy Email Draft" button — opens a modal with the email text ────────────
app.action('copy_email_modal', async ({ ack, body, client, action }) => {
  await ack();

  let emailData = { subject: '', body: '' };
  try {
    emailData = JSON.parse(action.value);
  } catch {
    // value may be malformed — show empty modal rather than crash
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildEmailModal(emailData.subject, emailData.body),
  });
});

// ── "Wrong Answer" button — opens feedback modal ─────────────────────────────
app.action('wrong_answer_modal', async ({ ack, body, client, action }) => {
  await ack();

  let context = { query: '', issueTitle: '', integrationType: '' };
  try {
    context = JSON.parse(action.value);
  } catch {
    // fallback to empty context
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildFeedbackModal(context),
  });
});

// ── "Show Specialist Detail" button ──────────────────────────────────────
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
  const responseBlocks = buildResponseBlocks(result);
  const fallbackText = `Specialist view: ${result.issue_title}`;

  if (thinkingTs) {
    await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: responseBlocks, text: fallbackText });
  } else {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: responseBlocks, text: fallbackText });
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

  let context = {};
  try {
    context = JSON.parse(view.private_metadata || '{}');
  } catch {
    app.logger.warn('[feedback] Could not parse private_metadata — proceeding with empty context');
  }
  const values = view.state.values;

  const feedbackType = values.feedback_type_block?.feedback_type_select?.selected_option?.value ?? 'wrong_answer';
  const correction = values.correction_block?.correction_input?.value ?? '';

  const record = await saveFeedback({
    query: context.query,
    issueTitle: context.issueTitle,
    integrationType: context.integrationType,
    feedbackType,
    correction,
    agentId: body.user.id,
    agentName: body.user.name,
  });

  app.logger.info(`[feedback] Saved ${record.id} from ${body.user.name}: ${feedbackType}`);

  // Notify feedback channel if configured
  await notifyFeedbackChannel(client, record);

  // DM the submitting agent that feedback is pending review
  try {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Thanks for the feedback! It's been sent for review — if approved, it'll help improve the bot.`,
    });
  } catch (err) {
    app.logger.warn(`[feedback] Could not DM submission confirmation to ${body.user.name}: ${err.message}`);
  }
});

// ── Approve feedback ──────────────────────────────────────────────────────
app.action('approve_feedback', async ({ ack, body, client, action }) => {
  await ack();

  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  const { feedbackId } = payload;
  if (!feedbackId) return;

  const record = await approveFeedback(feedbackId);
  if (!record) return; // Already processed

  // Get reviewer name
  let reviewerName = body.user.name;
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch { /* use fallback */ }

  // Update review card
  if (record.reviewMessageTs && record.reviewChannelId) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `✅ Approved by ${reviewerName}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `✅ *Approved by ${reviewerName}*\n_Feedback ID: ${record.id}_` },
        },
      ],
    }).catch((err) => app.logger.warn('[feedback] Failed to update review card:', err.message));
  }

  // DM the submitting agent
  await client.chat.postMessage({
    channel: record.agentId,
    text: `✅ Your feedback on *"${record.issueTitle}"* was approved and applied — thanks for helping improve the bot!`,
  }).catch((err) => app.logger.warn('[feedback] Failed to DM agent after approval:', err.message));

  app.logger.info(`[feedback] ${feedbackId} approved by ${reviewerName}`);
});

// ── Reject feedback ───────────────────────────────────────────────────────
app.action('reject_feedback', async ({ ack, body, client, action }) => {
  await ack();

  let payload = {};
  try { payload = JSON.parse(action.value); } catch { return; }
  const { feedbackId } = payload;
  if (!feedbackId) return;

  const record = await rejectFeedback(feedbackId);
  if (!record) return; // Already processed

  // Get reviewer name
  let reviewerName = body.user.name;
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch { /* use fallback */ }

  // Update review card
  if (record.reviewMessageTs && record.reviewChannelId) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `❌ Rejected by ${reviewerName}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `❌ *Rejected by ${reviewerName}*\n_Feedback ID: ${record.id}_` },
        },
      ],
    }).catch((err) => app.logger.warn('[feedback] Failed to update review card:', err.message));
  }

  // DM the submitting agent
  await client.chat.postMessage({
    channel: record.agentId,
    text: `Your feedback on *"${record.issueTitle}"* was reviewed and not applied — thanks for flagging it.`,
  }).catch((err) => app.logger.warn('[feedback] Failed to DM agent after rejection:', err.message));

  app.logger.info(`[feedback] ${feedbackId} rejected by ${reviewerName}`);
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
      atlassian: Boolean(process.env.ATLASSIAN_MCP_TOKEN),
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

  const feedbackChannel = process.env.FEEDBACK_REVIEW_CHANNEL_ID || process.env.FEEDBACK_CHANNEL_ID;
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
  const hasMcpAtlassian = Boolean(process.env.ATLASSIAN_MCP_TOKEN);
  app.logger.info(
    `[startup] MCP: Slack=${hasMcpSlack ? '✅' : '❌ (set SLACK_USER_TOKEN)'}  Atlassian=${hasMcpAtlassian ? '✅' : '❌ (set ATLASSIAN_MCP_TOKEN)'}`,
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
