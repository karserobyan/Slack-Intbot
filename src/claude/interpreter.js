import Anthropic from '@anthropic-ai/sdk';
import { INTERPRETER_PROMPT } from './prompts/interpreter.js';

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

const FALLBACK = Object.freeze({
  cleaned_question: '',
  intent: 'unclear',
  entities: { integration: null, error_code: null, tenant_id: null, customer_mentioned: false, symptom: null },
  question_confidence: 'low',
  clarifying_question: 'I had trouble understanding the question — can you rephrase it with the integration name and what specifically is going wrong?',
  search_plan: null,
});

function buildUserMessage(rawQuery, threadHistory) {
  if (!threadHistory || threadHistory.length === 0) return rawQuery;
  const historyText = threadHistory.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n');
  return `[PRIOR THREAD HISTORY]\n${historyText}\n[/PRIOR THREAD HISTORY]\n\nCURRENT MESSAGE: ${rawQuery}`;
}

async function callOnce(userMessage, externalSignal) {
  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([localController.signal, externalSignal])
    : localController.signal;
  try {
    const response = await getAnthropicClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: INTERPRETER_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }, { signal });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Interpreter response');
    return JSON.parse(match[0]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runInterpreter(rawQuery, { threadHistory = [], signal } = {}) {
  const userMessage = buildUserMessage(rawQuery, threadHistory);
  try {
    return await callOnce(userMessage, signal);
  } catch (err1) {
    if (signal?.aborted) return FALLBACK;
    console.warn('[interpreter] first attempt failed:', err1.message);
    try {
      return await callOnce(userMessage, signal);
    } catch (err2) {
      console.warn('[interpreter] second attempt failed, returning fallback:', err2.message);
      return FALLBACK;
    }
  }
}
