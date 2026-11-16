export const GATEWAY_BASE_URL = 'https://servicetitanint.truefoundry.cloud/api/llm';
export const HAIKU_MODEL = 'haiku-5-5';
export const SONNET_MODEL = 'sonnet-5-5';

export function anthropicBaseUrl() {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim();
  return (configured || GATEWAY_BASE_URL).replace(/\/$/, '');
}

export function messagesUrl() {
  return `${anthropicBaseUrl()}/v1/messages`;
}

export function answerModel() {
  return process.env.ANTHROPIC_MODEL?.trim() || SONNET_MODEL;
}

export function anthropicClientOptions() {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: anthropicBaseUrl(),
    fetch: (...args) => globalThis.fetch(...args),
    // The pipeline owns retries inside a 60s cap. The SDK default of 2 would
    // spend that cap on backoff.
    maxRetries: 0,
  };
}
