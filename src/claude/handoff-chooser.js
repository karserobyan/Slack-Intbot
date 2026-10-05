import Anthropic from '@anthropic-ai/sdk';

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

export async function completeHandoffChoice({ system, user, signal: externalSignal }) {
  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([localController.signal, externalSignal])
    : localController.signal;

  try {
    const response = await getAnthropicClient().messages.create({
      model: MODEL,
      max_tokens: 128,
      system,
      messages: [{ role: 'user', content: user }],
    }, { signal });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  } finally {
    clearTimeout(timer);
  }
}
