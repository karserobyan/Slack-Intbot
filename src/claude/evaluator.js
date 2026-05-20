import Anthropic from '@anthropic-ai/sdk';
import { EVALUATOR_PROMPT } from './prompts/evaluator.js';

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 15000;

let anthropic = null;

function getAnthropicClient() {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      fetch: (...args) => globalThis.fetch(...args),
      maxRetries: 0,
    });
  }
  return anthropic;
}

function summarizeResults(searchResults) {
  const lines = [];
  for (const [name, r] of Object.entries(searchResults)) {
    if (!r) { lines.push(`${name.toUpperCase()}: (no results)`); continue; }
    lines.push(`${name.toUpperCase()}: ${r.text ?? '(empty text)'}`);
  }
  return lines.join('\n\n');
}

export async function runEvaluator({ cleanedQuestion, searchResults, originalPlan }) {
  const userContent = `Cleaned question: ${cleanedQuestion}\n\nOriginal plan: ${JSON.stringify(originalPlan)}\n\nRound 1 results:\n${summarizeResults(searchResults)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await getAnthropicClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }, { signal: controller.signal });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Evaluator response');
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('[evaluator] failed, assuming sufficient:', err.message);
    return { sufficient: true, rationale: 'evaluator failed; skipping refinement', refined_plan: null };
  } finally {
    clearTimeout(timer);
  }
}
