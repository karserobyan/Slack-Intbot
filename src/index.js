'use strict';

require('dotenv').config();

const { App } = require('@slack/bolt');
const { getSupportResponse } = require('./claude');
const { formatSlackBlocks } = require('./formatSlack');

// ── Validate required env vars ───────────────────────────────────────────────
const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'ANTHROPIC_API_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ── Slack App setup ──────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Socket Mode is optional but recommended for development
  ...(process.env.SLACK_APP_TOKEN
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : {}),
  port: process.env.PORT || 3000,
});

// ── Slash command: /support ──────────────────────────────────────────────────
app.command('/support', async ({ command, ack, respond, logger }) => {
  await ack();

  const ticket = command.text?.trim();
  if (!ticket) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/support <describe the customer issue>`',
    });
    return;
  }

  // Immediately acknowledge with a loading message (ephemeral)
  await respond({ response_type: 'ephemeral', text: ':hourglass: Analyzing issue with Claude…' });

  try {
    const response = await getSupportResponse(ticket);
    const blocks = formatSlackBlocks(response);

    // Post the full response as an ephemeral message visible only to the agent
    await respond({
      response_type: 'ephemeral',
      blocks,
      text: 'ServiceTitan Integrations Support response',
    });
  } catch (err) {
    logger.error('Claude error:', err);
    await respond({
      response_type: 'ephemeral',
      text: `:x: Error generating response: ${err.message}`,
    });
  }
});

// ── App mention: @intbot <issue> ─────────────────────────────────────────────
app.event('app_mention', async ({ event, say, client, logger }) => {
  // Strip the bot mention from the text
  const ticket = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!ticket) {
    await say({
      thread_ts: event.ts,
      text: 'Please describe the customer issue after mentioning me. Example: `@intbot customer cannot authenticate via OAuth`',
    });
    return;
  }

  // Post a loading indicator in the thread
  const thinking = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: ':hourglass: Analyzing issue with Claude…',
  });

  try {
    const response = await getSupportResponse(ticket);
    const blocks = formatSlackBlocks(response);

    // Update the loading message with the real response
    await client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      blocks,
      text: 'ServiceTitan Integrations Support response',
    });
  } catch (err) {
    logger.error('Claude error:', err);
    await client.chat.update({
      channel: event.channel,
      ts: thinking.ts,
      text: `:x: Error generating response: ${err.message}`,
    });
  }
});

// ── Direct messages ──────────────────────────────────────────────────────────
app.message(async ({ message, say, client, logger }) => {
  // Only handle DMs (channel type 'im') to avoid noise in public channels
  if (message.channel_type !== 'im' || message.subtype) return;

  const ticket = message.text?.trim();
  if (!ticket) return;

  const thinking = await say(':hourglass: Analyzing issue with Claude…');

  try {
    const response = await getSupportResponse(ticket);
    const blocks = formatSlackBlocks(response);

    await client.chat.update({
      channel: message.channel,
      ts: thinking.ts,
      blocks,
      text: 'ServiceTitan Integrations Support response',
    });
  } catch (err) {
    logger.error('Claude error:', err);
    await client.chat.update({
      channel: message.channel,
      ts: thinking.ts,
      text: `:x: Error generating response: ${err.message}`,
    });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log(`⚡ ServiceTitan Integrations Support Assistant is running`);
})();
