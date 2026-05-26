/**
 * Knowledge Base search backed by Anthropic's web_search tool, scoped to
 * help.servicetitan.com. Returns public, customer-shareable KB URLs.
 *
 * Why not Google Custom Search: avoids a separate GCP project + enable-API +
 * billing surface that has repeatedly broken. Anthropic API is already a hard
 * dependency of the bot, so this collapses one failure mode.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const KB_DOMAIN = 'help.servicetitan.com';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RESULTS = 5;

export async function searchKnowledgeBase(query, { signal: externalSignal } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn('[kb-search] ANTHROPIC_API_KEY not set — skipping KB search');
    return null;
  }

  const body = {
    model: MODEL,
    max_tokens: 1024,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      allowed_domains: [KB_DOMAIN],
      max_uses: 1,
    }],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: query }],
  };

  let data;
  try {
    const localAbort = new AbortController();
    const timer = setTimeout(() => localAbort.abort(), 15_000);
    const signal = externalSignal
      ? AbortSignal.any([localAbort.signal, externalSignal])
      : localAbort.signal;
    let response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`[kb-search] Anthropic API returned ${response.status} — skipping KB search`, errText.slice(0, 200));
      return null;
    }
    data = await response.json();
  } catch (err) {
    console.warn('[kb-search] Fetch failed:', err.name === 'AbortError' ? 'timed out after 15s' : err.message);
    return null;
  }

  try {
    const toolResult = (data?.content ?? []).find((b) => b.type === 'web_search_tool_result');
    const results = Array.isArray(toolResult?.content) ? toolResult.content : [];
    const webResults = results.filter((r) => r?.type === 'web_search_result');

    if (webResults.length === 0) {
      return null;
    }

    const refs = webResults.slice(0, MAX_RESULTS).map((r) => ({
      url: r.url ?? '',
      title: r.title ?? '',
      snippet: '',
    }));

    const text = refs
      .map((ref, i) => `${i + 1}. ${ref.title}\n   URL: ${ref.url}`)
      .join('\n\n');

    return { text, refs };
  } catch (err) {
    console.warn('[kb-search] Failed to parse search results:', err.message);
    return null;
  }
}
