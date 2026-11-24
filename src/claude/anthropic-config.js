export const GATEWAY_BASE_URL = 'https://servicetitanint.truefoundry.cloud/api/llm';
export const HAIKU_MODEL = 'integrationsbot-internal/chat-model-fast';
export const SONNET_MODEL = 'integrationsbot-internal/chat-model';

// Own variable names: a shell's ambient ANTHROPIC_BASE_URL/ANTHROPIC_MODEL
// would otherwise send the gateway token to another host.
export function anthropicBaseUrl() {
  const configured = process.env.INTBOT_GATEWAY_URL?.trim();
  return (configured || GATEWAY_BASE_URL).replace(/\/$/, '');
}

export function messagesUrl() {
  return `${anthropicBaseUrl()}/v1/messages`;
}

export function answerModel() {
  return process.env.INTBOT_MODEL?.trim() || SONNET_MODEL;
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
