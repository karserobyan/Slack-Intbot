import Anthropic from '@anthropic-ai/sdk';
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT_CSA, SYSTEM_PROMPT_SPECIALIST, parseClaudeResponse } from './prompts.js';
import { getKnowledge } from '../slack/knowledge.js';
import { searchKnowledgeBase } from './kb-search.js';
import { searchConfluence, searchJira } from './atlassian-search.js';
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
  const slackToken = process.env.SLACK_USER_TOKEN;
  if (slackToken && slackToken !== 'xoxp-replace-me') {
    return [{
      type: 'url',
      url: 'https://mcp.slack.com/mcp',
      name: 'slack',
      authorization_token: slackToken,
    }];
  }
  return [];
}

function normalizeTool(name) {
  const n = (name ?? '').toLowerCase();
  if (/confluence/.test(n)) return 'confluence';
  if (/jira/.test(n)) return 'jira';
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

  if (onProgress) {
    Promise.resolve(onProgress({ phase: 'tool_start', tool: 'KB' })).catch(() => {});
    Promise.resolve(onProgress({ phase: 'tool_start', tool: 'confluence' })).catch(() => {});
    Promise.resolve(onProgress({ phase: 'tool_start', tool: 'jira' })).catch(() => {});
  }
  const [knowledge, kbResult, confluenceResult, jiraResult] = await Promise.all([
    getKnowledge().catch(() => null),
    searchKnowledgeBase(userQuery).catch(() => null),
    searchConfluence(userQuery).catch(() => null),
    searchJira(userQuery).catch(() => null),
  ]);
  if (onProgress) {
    Promise.resolve(onProgress({ phase: 'tool_done', tool: 'KB', count: kbResult?.refs?.length ?? null })).catch(() => {});
    Promise.resolve(onProgress({ phase: 'tool_done', tool: 'confluence', count: confluenceResult?.refs?.length ?? null })).catch(() => {});
    Promise.resolve(onProgress({ phase: 'tool_done', tool: 'jira', count: jiraResult?.refs?.length ?? null })).catch(() => {});
  }

  let userContent = `Issue: ${userQuery}`;
  if (knowledge) userContent += `\n\n[TEAM KNOWLEDGE]\n${knowledge}\n[/TEAM KNOWLEDGE]`;
  if (kbResult?.text) userContent += `\n\n[KB RESULTS]\n${kbResult.text}\n[/KB RESULTS]`;
  if (confluenceResult?.text) userContent += `\n\n[CONFLUENCE RESULTS]\n${confluenceResult.text}\n[/CONFLUENCE RESULTS]`;
  if (jiraResult?.text) userContent += `\n\n[JIRA RESULTS]\n${jiraResult.text}\n[/JIRA RESULTS]`;
  const mcpServers = buildMcpServers();

  const basePrompt = role === 'specialist' ? SYSTEM_PROMPT_SPECIALIST : SYSTEM_PROMPT_CSA;
  const systemPrompt = basePrompt;

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

    const toolsUsed = [];

    if (onProgress) {
      let writingFired = false;

      stream.on('streamEvent', (event) => {
        if (event.type !== 'content_block_start') return;
        const cb = event.content_block;
        try {
          if (cb.type === 'tool_use') {
            toolsUsed.push(cb.name);
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
    if (toolsUsed.length > 0) {
      console.info('[query] tools called:', toolsUsed.join(', '));
    } else {
      console.warn('[query] no MCP tools called — Claude answered without searching');
    }
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
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1));
      if (obj.state === 'diagnosing' || obj.state === 'resolved') return obj;
    } catch {}
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
export async function queryChat(userQuery, history, { kbContext = null, confluenceContext = null, jiraContext = null, onProgress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let systemPrompt = CHAT_SYSTEM_PROMPT;
  if (kbContext) systemPrompt += `\n\n[KB RESULTS]\n${kbContext}\n[/KB RESULTS]`;
  if (confluenceContext) systemPrompt += `\n\n[CONFLUENCE RESULTS]\n${confluenceContext}\n[/CONFLUENCE RESULTS]`;
  if (jiraContext) systemPrompt += `\n\n[JIRA RESULTS]\n${jiraContext}\n[/JIRA RESULTS]`;

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
