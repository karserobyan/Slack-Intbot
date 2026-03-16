'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT, buildUserMessage } = require('./systemPrompt');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Sends a customer issue to Claude and returns a parsed response.
 * @param {string} customerIssue - The raw support message from the agent.
 * @returns {Promise<{agent_troubleshooting_markdown: string, customer_email_markdown: string, metadata: object}>}
 */
async function getSupportResponse(customerIssue) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(customerIssue) }],
  });

  const rawText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Strip markdown code fences if Claude wraps the JSON
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Claude returned non-JSON output:\n${rawText}`);
  }

  // Validate required fields
  if (!parsed.agent_troubleshooting_markdown || !parsed.customer_email_markdown) {
    throw new Error('Claude response missing required fields (agent_troubleshooting_markdown or customer_email_markdown)');
  }

  return parsed;
}

module.exports = { getSupportResponse };
