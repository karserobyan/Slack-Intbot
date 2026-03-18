import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';
import { gatherContext } from '../search/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Reduced timeout — no MCP round-trips anymore
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '45000', 10) || 45000;

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

/**
 * Searches Slack + Confluence, then calls Claude with grounded context.
 * Aborts automatically after TIMEOUT_MS (default 45s).
 * Note: the onToken streaming callback from the previous MCP implementation
 * has been intentionally removed — no active caller uses it.
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithContext(userQuery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Gather real context before calling Claude
  let contextBlock = '';
  try {
    contextBlock = await gatherContext(userQuery);
  } catch (err) {
    console.warn('[query] Context gathering failed — proceeding without context:', err.message);
  }

  const userContent = `Issue: ${userQuery}${contextBlock}`;

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  };

  let fullText = '';

  try {
    const response = await anthropic.messages.create(requestParams, { signal: controller.signal });
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return parseClaudeResponse(fullText);
}

/**
 * Conversational follow-up query — uses thread history, returns plain text.
 * Does NOT run search (Slack/Confluence) — relies on history for context.
 * Aborts automatically after TIMEOUT_MS.
 *
 * @param {string} userQuery - The agent's follow-up message
 * @param {Array<{role: string, content: string}>} history - Prior messages in the thread
 * @returns {Promise<string>} Plain text response
 */
export async function queryChat(userQuery, history) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const messages = [...history, { role: 'user', content: userQuery }];

  const requestParams = {
    model: MODEL,
    max_tokens: 2048,
    system: CHAT_SYSTEM_PROMPT,
    messages,
  };

  let fullText = '';

  try {
    const response = await anthropic.messages.create(requestParams, { signal: controller.signal });
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return fullText;
}
