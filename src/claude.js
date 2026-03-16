'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./systemPrompt');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Sends a support ticket/question to Claude and returns a parsed response.
 * @param {string} userMessage - The raw support message from the agent.
 * @returns {Promise<{agentTroubleshooting: object, customerEmailDraft: object}>}
 */
async function getSupportResponse(userMessage) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const rawText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Strip markdown code fences if Claude wraps the JSON anyway
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Claude returned non-JSON output:\n${rawText}`);
  }

  return parsed;
}

module.exports = { getSupportResponse };
