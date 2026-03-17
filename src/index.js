import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { registerMentionHandler } from './handlers/mention.js';
import { registerDmHandler } from './handlers/dm.js';
import { buildEmailModal, buildFeedbackModal } from './slack/blocks.js';
import { pruneExpired, cacheStats } from './slack/cache.js';
import { saveFeedback, notifyFeedbackChannel } from './slack/feedback.js';

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

  // DM the agent a confirmation
  try {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `✅ Thanks for the feedback! Your correction has been saved (${record.id}). The bot will use this to improve future answers.`,
    });
  } catch (err) {
    app.logger.warn(`[feedback] Could not DM confirmation to ${body.user.name}: ${err.message}`);
  }
});

// ── Periodic cache prune (every 15 minutes) ──────────────────────────────────
setInterval(
  () => {
    pruneExpired();
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
      slack: Boolean(process.env.SLACK_MCP_TOKEN || process.env.SLACK_BOT_TOKEN),
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

  const hasMcpSlack = Boolean(process.env.SLACK_MCP_TOKEN || process.env.SLACK_BOT_TOKEN);
  const hasMcpAtlassian = Boolean(process.env.ATLASSIAN_MCP_TOKEN);
  app.logger.info(
    `[startup] MCP: Slack=${hasMcpSlack ? '✅' : '❌ (set SLACK_MCP_TOKEN)'}  Atlassian=${hasMcpAtlassian ? '✅' : '❌ (set ATLASSIAN_MCP_TOKEN)'}`,
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
