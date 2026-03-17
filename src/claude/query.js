import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Configurable timeout — Claude with MCP tools can take 30-90s
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10) || 90000;

// Model is configurable so you can test with cheaper models locally
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

// MCP server configurations — connections are declared per-request as per SDK spec
const MCP_SERVERS = [
  {
    type: 'url',
    url: 'https://mcp.slack.com/mcp',
    name: 'slack',
    authorization_token: process.env.SLACK_MCP_TOKEN || process.env.SLACK_BOT_TOKEN,
  },
  {
    type: 'url',
    url: 'https://mcp.atlassian.com/v1/sse',
    name: 'atlassian',
    authorization_token: process.env.ATLASSIAN_MCP_TOKEN,
  },
];

/**
 * Determines which MCP servers are configured and available.
 * Falls back gracefully if tokens are missing.
 */
function getAvailableMcpServers() {
  return MCP_SERVERS.filter((s) => s.authorization_token);
}

/**
 * Runs a single Claude API call with both MCP servers active simultaneously.
 * Aborts automatically after TIMEOUT_MS (default 90s).
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @param {Function} [onToken] - Optional callback fired with each streamed text chunk
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithMcp(userQuery, onToken) {
  const mcpServers = getAvailableMcpServers();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Issue: ${userQuery}` }],
  };

  if (mcpServers.length > 0) {
    requestParams.mcp_servers = mcpServers;
  }

  let fullText = '';

  try {
    if (typeof onToken === 'function') {
      const stream = await anthropic.messages.stream(requestParams, { signal: controller.signal });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          const token = chunk.delta.text;
          fullText += token;
          onToken(token);
        }
      }
    } else {
      const response = await anthropic.messages.create(requestParams, { signal: controller.signal });
      fullText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — Claude with MCP tools is slow on complex queries. Try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return parseClaudeResponse(fullText);
}
