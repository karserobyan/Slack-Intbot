import Anthropic from '@anthropic-ai/sdk';
import { ANSWERER_PROMPT_CSA, ANSWERER_PROMPT_SPECIALIST, parseClaudeResponse } from './prompts/answerer.js';

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

/**
 * Final stage of the pipeline. Calls Claude Sonnet with pre-fetched search
 * results and team context. No MCP — search happened upstream.
 *
 * @param {object} args
 * @param {string} args.cleanedQuestion
 * @param {object} args.searchResults - { kb, confluence, jira, slack }, each {text,refs,priority}|null
 * @param {'csa'|'specialist'} args.role
 * @param {string|null} args.teamKnowledge
 * @param {string} args.feedbackContext
 * @param {string|null} [args.agentName]
 * @returns {Promise<object>} Parsed JSON response. Throws on Anthropic failure or parse failure.
 */
export async function runAnswerer({
  cleanedQuestion,
  searchResults,
  role,
  teamKnowledge,
  feedbackContext,
  agentName = null,
  signal: externalSignal,
}) {
  const basePrompt = role === 'specialist' ? ANSWERER_PROMPT_SPECIALIST : ANSWERER_PROMPT_CSA;
  const systemPrompt = basePrompt;

  let userContent = `Issue: ${cleanedQuestion}`;
  if (teamKnowledge) userContent += `\n\n[TEAM KNOWLEDGE]\n${teamKnowledge}\n[/TEAM KNOWLEDGE]`;
  if (searchResults.kb?.text)         userContent += `\n\n[KB RESULTS]\n${searchResults.kb.text}\n[/KB RESULTS]`;
  if (searchResults.confluence?.text) userContent += `\n\n[CONFLUENCE RESULTS]\n${searchResults.confluence.text}\n[/CONFLUENCE RESULTS]`;
  if (searchResults.jira?.text)       userContent += `\n\n[JIRA RESULTS]\n${searchResults.jira.text}\n[/JIRA RESULTS]`;
  if (searchResults.slack?.text)      userContent += `\n\n[SLACK RESULTS]\n${searchResults.slack.text}\n[/SLACK RESULTS]`;
  if (feedbackContext)                userContent += feedbackContext;

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
      console.error('[answerer] parse failed — head of model output:', JSON.stringify(fullText.slice(0, 200)));
      throw Object.assign(new Error(`Could not parse Answerer response: ${parseErr.message}`), { parseFailure: true });
    }
    if (!parsed) {
      console.error('[answerer] parse returned no content — head of model output:', JSON.stringify(fullText.slice(0, 200)));
      throw Object.assign(new Error('Answerer returned no parseable content.'), { parseFailure: true });
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
