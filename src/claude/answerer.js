import Anthropic from '@anthropic-ai/sdk';
import { RESOLVER_PROMPT } from './prompts/resolver.js';
import { REPLY_PROMPT } from './prompts/reply.js';
import { parseClaudeResponse } from './prompts.js';
import { RETIRED_ROLE_FIELDS, NON_MODEL_FIELDS } from './answer-schema.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10) || 90000;

// Lazy-init the client so tests can set ANTHROPIC_API_KEY after this module
// is imported. The SDK captures the key at construction time and validates it
// when building request headers, so module-level construction with an unset
// env var would throw at first call rather than at startup.
let anthropic = null;

function getAnthropicClient() {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      fetch: (...args) => globalThis.fetch(...args),
      // Retry policy is owned by the pipeline (see runPipeline), not the SDK —
      // matching interpreter.js and evaluator.js. Leaving the SDK default (2)
      // would stack with the pipeline's manual retry inside the same timeout
      // budget and burn it on exponential backoff.
      maxRetries: 0,
    });
  }
  return anthropic;
}

function appendResearchBlocks(userContent, searchResults, { teamKnowledge, feedbackContext } = {}) {
  let content = userContent;
  if (teamKnowledge) content += `\n\n[TEAM KNOWLEDGE]\n${teamKnowledge}\n[/TEAM KNOWLEDGE]`;
  if (searchResults.kb?.text)         content += `\n\n[KB RESULTS]\n${searchResults.kb.text}\n[/KB RESULTS]`;
  if (searchResults.confluence?.text) content += `\n\n[CONFLUENCE RESULTS]\n${searchResults.confluence.text}\n[/CONFLUENCE RESULTS]`;
  if (searchResults.jira?.text)       content += `\n\n[JIRA RESULTS]\n${searchResults.jira.text}\n[/JIRA RESULTS]`;
  if (searchResults.slack?.text)      content += `\n\n[SLACK RESULTS]\n${searchResults.slack.text}\n[/SLACK RESULTS]`;
  if (feedbackContext)                content += feedbackContext;
  return content;
}

async function callClaude({ systemPrompt, userContent, signal: externalSignal, stageLabel }) {
  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([localController.signal, externalSignal])
    : localController.signal;

  try {
    const response = await getAnthropicClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }, { signal });

    const fullText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    let parsed;
    try {
      parsed = parseClaudeResponse(fullText);
    } catch (parseErr) {
      // Malformed/truncated LLM JSON is common and usually recovers on a re-roll.
      // Tag it so runPipeline retries once instead of failing the whole request.
      console.error(`[${stageLabel}] parse failed — head of model output:`, JSON.stringify(fullText.slice(0, 200)));
      throw Object.assign(new Error(`Could not parse ${stageLabel} response: ${parseErr.message}`), { parseFailure: true });
    }
    if (!parsed) {
      console.error(`[${stageLabel}] parse returned no content — head of model output:`, JSON.stringify(fullText.slice(0, 200)));
      throw Object.assign(new Error(`${stageLabel} returned no parseable content.`), { parseFailure: true });
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function stripRetiredFields(parsed) {
  for (const field of RETIRED_ROLE_FIELDS) {
    delete parsed[field];
  }
  for (const field of NON_MODEL_FIELDS) {
    delete parsed[field];
  }
  return parsed;
}

/**
 * Resolver stage. Produces diagnosis + steps + involvement for the case owner.
 * No role, no agentName. Research is already in the context blocks.
 *
 * @param {object} args
 * @param {string} args.cleanedQuestion
 * @param {object} args.searchResults - { kb, confluence, jira, slack }, each {text,refs,priority}|null
 * @param {string|null} args.teamKnowledge
 * @param {string} args.feedbackContext
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<object>} Parsed resolver JSON with retired/non-model fields stripped.
 */
function formatPriorCase(threadHistory) {
  if (!Array.isArray(threadHistory) || threadHistory.length === 0) return '';
  const lines = threadHistory.slice(-8).map((turn) => `${turn.role}: ${String(turn.content ?? '').slice(0, 800)}`);
  return `[PRIOR CASE]\n${lines.join('\n')}\n[/PRIOR CASE]\n\n`;
}

export async function runResolver({
  cleanedQuestion,
  searchResults,
  teamKnowledge,
  feedbackContext,
  threadHistory,
  signal: externalSignal,
}) {
  const userContent = appendResearchBlocks(
    `${formatPriorCase(threadHistory)}Issue: ${cleanedQuestion}`,
    searchResults,
    { teamKnowledge, feedbackContext },
  );

  const parsed = await callClaude({
    systemPrompt: RESOLVER_PROMPT,
    userContent,
    signal: externalSignal,
    stageLabel: 'resolver',
  });

  return stripRetiredFields(parsed);
}

/**
 * Reply stage. Writes customer_message only from the resolver result + research.
 *
 * @param {object} args
 * @param {string} args.cleanedQuestion
 * @param {object} args.resolver - Parsed resolver result
 * @param {object} args.searchResults
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ customer_message: string }>}
 */
export async function runReply({
  cleanedQuestion,
  resolver,
  searchResults,
  signal: externalSignal,
}) {
  let userContent = `Issue: ${cleanedQuestion}\n\n[RESOLVER]\n${JSON.stringify(resolver)}\n[/RESOLVER]`;
  userContent = appendResearchBlocks(userContent, searchResults);

  const parsed = await callClaude({
    systemPrompt: REPLY_PROMPT,
    userContent,
    signal: externalSignal,
    stageLabel: 'reply',
  });

  return { customer_message: parsed.customer_message };
}
