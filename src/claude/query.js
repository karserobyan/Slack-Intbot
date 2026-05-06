import Anthropic from '@anthropic-ai/sdk';
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT_CSA, SYSTEM_PROMPT_SPECIALIST, parseClaudeResponse, AUDIT_LOG_PROMPT, parseAuditResponse } from './prompts.js';
import { getKnowledge } from '../slack/knowledge.js';
import { searchKnowledgeBase } from './kb-search.js';
import { appendKbArticle } from '../slack/knowledge-writer.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10) || 90000;

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

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

function normalizeTool(name) {
  const n = (name ?? '').toLowerCase();
  if (/confluence/.test(n)) return 'confluence';
  if (/^jira/.test(n)) return 'jira';
  if (/slack/.test(n)) return 'slack';
  return (name ?? '').slice(0, 20);
}


/**
 * Calls Claude with MCP tools for Atlassian and Slack search.
 * Claude drives its own searches — no pre-fetching on our side.
 * Aborts automatically after TIMEOUT_MS.
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithContext(userQuery, { role = 'csa', agentName = null, onProgress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Run team knowledge fetch and KB search in parallel
  const [knowledge, kbResult] = await Promise.all([
    getKnowledge().catch(() => null),
    searchKnowledgeBase(userQuery),
  ]);

  let userContent = `Issue: ${userQuery}`;
  if (knowledge) userContent += `\n\n[TEAM KNOWLEDGE]\n${knowledge}\n[/TEAM KNOWLEDGE]`;
  if (kbResult?.text) userContent += `\n\n[KB RESULTS]\n${kbResult.text}\n[/KB RESULTS]`;
  const mcpServers = buildMcpServers();

  const basePrompt = role === 'specialist' ? SYSTEM_PROMPT_SPECIALIST : SYSTEM_PROMPT_CSA;
  const systemPrompt = agentName
    ? `${basePrompt}\n\nThe agent's display name is: ${agentName}. Use this name in customer_message.`
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
    const stream = anthropic.beta.messages.stream(requestParams, { signal: controller.signal });

    if (onProgress) {
      let writingFired = false;

      stream.on('streamEvent', (event) => {
        if (event.type !== 'content_block_start') return;
        const cb = event.content_block;
        try {
          if (cb.type === 'tool_use') {
            const tool = normalizeTool(cb.name);
            Promise.resolve(onProgress({ phase: 'tool_start', tool })).catch(() => {});
          } else if (cb.type === 'text' && !writingFired) {
            writingFired = true;
            Promise.resolve(onProgress({ phase: 'writing' })).catch(() => {});
          }
        } catch {}
      });

      stream.on('contentBlock', (block) => {
        if (block.type !== 'tool_use') return;
        try {
          const tool = normalizeTool(block.name);
          Promise.resolve(onProgress({ phase: 'tool_done', tool, count: null })).catch(() => {});
        } catch {}
      });
    }

    const response = await stream.finalMessage();
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

  const result = parseClaudeResponse(fullText);
  if (kbResult?.refs?.length > 0) {
    result.kb_refs = kbResult.refs;
    const integration = result.integration_type || 'General';
    for (const ref of kbResult.refs) {
      appendKbArticle(integration, ref.url, ref.title, ref.snippet ?? '').catch((err) => {
        console.warn('[query] KB auto-save failed for', ref.url, ':', err.message);
      });
    }
  }
  return result;
}

export function parseChatResponse(text) {
  try {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;
    const trimmed = fenced.test(text.trim()) ? text.trim().replace(fenced, '$1') : text.trim();
    const obj = JSON.parse(trimmed);
    if (obj.state === 'diagnosing' || obj.state === 'resolved') return obj;
  } catch {
    // fall through
  }
  return { state: 'diagnosing', acknowledgement: '', question: text };
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
export async function queryChat(userQuery, history, { kbContext = null, onProgress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const systemPrompt = kbContext
    ? `${CHAT_SYSTEM_PROMPT}\n\n[KB RESULTS]\n${kbContext}\n[/KB RESULTS]`
    : CHAT_SYSTEM_PROMPT;

  const messages = [...history, { role: 'user', content: userQuery }];
  const mcpServers = buildMcpServers();

  const requestParams = {
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages,
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: ['mcp-client-2025-04-04'],
  };

  let fullText = '';

  try {
    const stream = anthropic.beta.messages.stream(requestParams, { signal: controller.signal });

    if (onProgress) {
      let writingFired = false;

      stream.on('streamEvent', (event) => {
        if (event.type !== 'content_block_start') return;
        const cb = event.content_block;
        try {
          if (cb.type === 'tool_use') {
            const tool = normalizeTool(cb.name);
            Promise.resolve(onProgress({ phase: 'tool_start', tool })).catch(() => {});
          } else if (cb.type === 'text' && !writingFired) {
            writingFired = true;
            Promise.resolve(onProgress({ phase: 'writing' })).catch(() => {});
          }
        } catch {}
      });

      stream.on('contentBlock', (block) => {
        if (block.type !== 'tool_use') return;
        try {
          const tool = normalizeTool(block.name);
          Promise.resolve(onProgress({ phase: 'tool_done', tool, count: null })).catch(() => {});
        } catch {}
      });
    }

    const response = await stream.finalMessage();
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

  return parseChatResponse(fullText);
}

/**
 * Tier 2 fast-lookup — calls Claude with knowledge.md content only, no MCP servers.
 * Used in mention.js before the full MCP search.
 * Falls through (caller checks) if result has clarifying_question or confidence === 'low'.
 *
 * @param {string} userQuery
 * @param {string} knowledgeContent - Full contents of knowledge.md
 * @param {{ role?: string, agentName?: string|null }} [options]
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithKnowledge(userQuery, knowledgeContent, { role = 'csa', agentName = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const userContent = `Issue: ${userQuery}\n\n[TEAM KNOWLEDGE]\n${knowledgeContent}\n[/TEAM KNOWLEDGE]`;
  const basePrompt = role === 'specialist' ? SYSTEM_PROMPT_SPECIALIST : SYSTEM_PROMPT_CSA;
  const systemPrompt = agentName
    ? `${basePrompt}\n\nThe agent's display name is: ${agentName}. Use this name in intro_message.`
    : basePrompt;

  let fullText = '';
  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }, { signal: controller.signal });

    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Knowledge fast-lookup timed out after ${Math.round(TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return parseClaudeResponse(fullText);
}

/**
 * Queries Claude with Elasticsearch MCP to fetch and analyze audit logs for a tenant.
 * Claude drives its own ES searches — discovers the index, inspects mappings, then queries.
 *
 * @param {{ tenantName: string, question: string, timeRange: number }} params
 * @returns {Promise<object>} Parsed audit result
 */
export async function queryAuditLog({ tenantName, question, timeRange }) {
  if (!process.env.ES_MCP_URL) {
    throw new Error('Elasticsearch is not configured — ask your admin for ES_MCP_URL and ES_MCP_TOKEN.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const mcpServers = [{
    type: 'url',
    url: process.env.ES_MCP_URL,
    name: 'elasticsearch',
    ...(process.env.ES_MCP_TOKEN ? { authorization_token: process.env.ES_MCP_TOKEN } : {}),
  }];

  const userContent = `Tenant: ${tenantName}\nTime range: ${timeRange} days\nQuestion: ${question || 'Show recent changes'}`;

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: AUDIT_LOG_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    mcp_servers: mcpServers,
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

  const result = parseAuditResponse(fullText);
  if (!result) throw new Error('Could not parse audit log response.');
  return result;
}
