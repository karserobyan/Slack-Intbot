import Anthropic from '@anthropic-ai/sdk';
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT_CSA, SYSTEM_PROMPT_SPECIALIST, parseClaudeResponse } from './prompts.js';
import { getKnowledge } from '../slack/knowledge.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10) || 90000;

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

/**
 * Builds the MCP servers array based on available tokens.
 * Slack MCP is omitted if SLACK_USER_TOKEN is missing or still a placeholder.
 *
 * @returns {Array} Array of MCP server config objects
 */
function buildMcpServers() {
  const servers = [];

  if (process.env.ATLASSIAN_MCP_TOKEN) {
    servers.push({
      type: 'url',
      url: 'https://mcp.atlassian.com/v1/sse',
      name: 'atlassian',
      authorization_token: process.env.ATLASSIAN_MCP_TOKEN,
    });
  }

  const slackToken = process.env.SLACK_USER_TOKEN;
  if (slackToken && slackToken !== 'xoxp-replace-me') {
    servers.push({
      type: 'url',
      url: 'https://mcp.slack.com/mcp',
      name: 'slack',
      authorization_token: slackToken,
    });
  }

  return servers;
}

/**
 * Calls Claude with MCP tools for Atlassian and Slack search.
 * Claude drives its own searches — no pre-fetching on our side.
 * Aborts automatically after TIMEOUT_MS.
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithContext(userQuery, { role = 'csa', agentName = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Inject team knowledge base if available
  let knowledgeBlock = '';
  try {
    const knowledge = await getKnowledge();
    if (knowledge) knowledgeBlock = `\n\n[TEAM KNOWLEDGE]\n${knowledge}\n[/TEAM KNOWLEDGE]`;
  } catch {
    // non-critical — proceed without it
  }

  const userContent = `Issue: ${userQuery}${knowledgeBlock}`;
  const mcpServers = buildMcpServers();

  // Select system prompt based on role. agentName is appended so Claude uses it in intro_message.
  const basePrompt = role === 'specialist' ? SYSTEM_PROMPT_SPECIALIST : SYSTEM_PROMPT_CSA;
  const systemPrompt = agentName
    ? `${basePrompt}\n\nThe agent's display name is: ${agentName}. Use this name in intro_message.`
    : basePrompt;

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: ['mcp-client-2025-04-04'],
  };

  let fullText = '';

  try {
    const response = await anthropic.beta.messages.create(requestParams, { signal: controller.signal });
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (controller.signal.aborted) {
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
 * Uses MCP tools so Claude can search for new information if the agent provides
 * a new angle, error code, or additional context.
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
  const mcpServers = buildMcpServers();

  const requestParams = {
    model: MODEL,
    max_tokens: 2048,
    system: CHAT_SYSTEM_PROMPT,
    messages,
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: ['mcp-client-2025-04-04'],
  };

  let fullText = '';

  try {
    const response = await anthropic.beta.messages.create(requestParams, { signal: controller.signal });
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return fullText;
}
