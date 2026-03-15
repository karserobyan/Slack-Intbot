import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
 * Streams the response for immediate feedback, then parses the final JSON.
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @param {Function} [onToken] - Optional callback fired with each streamed text chunk
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithMcp(userQuery, onToken) {
  const mcpServers = getAvailableMcpServers();

  const requestParams = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Issue: ${userQuery}` }],
  };

  // Only attach MCP servers if we have at least one configured
  if (mcpServers.length > 0) {
    requestParams.mcp_servers = mcpServers;
  }

  let fullText = '';

  if (typeof onToken === 'function') {
    // Streaming path — caller gets tokens as they arrive
    const stream = await anthropic.messages.stream(requestParams);

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta?.type === 'text_delta'
      ) {
        const token = chunk.delta.text;
        fullText += token;
        onToken(token);
      }
    }
  } else {
    // Non-streaming path
    const response = await anthropic.messages.create(requestParams);
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  return parseClaudeResponse(fullText);
}
