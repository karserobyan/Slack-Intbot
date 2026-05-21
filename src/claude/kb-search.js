/**
 * Google Custom Search integration for Knowledge Base lookups.
 * Searches the configured CSE and returns formatted results for Claude context injection
 * and a refs array for the Sources modal.
 *
 * Environment variables required:
 *   GOOGLE_CSE_API_KEY — Google API key with Custom Search enabled
 *   GOOGLE_CSE_ID     — Custom Search Engine ID (cx)
 */

const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';

/**
 * Search the knowledge base via Google Custom Search.
 *
 * @param {string} query - The search query
 * @returns {Promise<{text: string, refs: Array<{url: string, title: string, snippet: string}>} | null>}
 *   Returns formatted results or null on any error / missing config.
 */
export async function searchKnowledgeBase(query, { signal: externalSignal } = {}) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;

  if (!apiKey || !cx) {
    console.warn('[kb-search] GOOGLE_CSE_API_KEY or GOOGLE_CSE_ID not set — skipping KB search');
    return null;
  }

  const url = new URL(GOOGLE_CSE_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', '3');

  let data;
  try {
    const localAbort = new AbortController();
    const timer = setTimeout(() => localAbort.abort(), 8_000);
    const signal = externalSignal
      ? AbortSignal.any([localAbort.signal, externalSignal])
      : localAbort.signal;
    let response;
    try {
      response = await fetch(url.toString(), { signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      console.warn(`[kb-search] Google API returned ${response.status} — skipping KB search`);
      return null;
    }
    data = await response.json();
  } catch (err) {
    console.warn('[kb-search] Fetch failed:', err.name === 'AbortError' ? 'timed out after 8s' : err.message);
    return null;
  }

  try {
    const items = Array.isArray(data?.items) ? data.items : [];

    if (items.length === 0) {
      return null;
    }

    const refs = items.map((item) => ({
      url: item.link ?? '',
      title: item.title ?? '',
      snippet: item.snippet ?? '',
    }));

    const text = refs
      .map((ref, i) =>
        `${i + 1}. ${ref.title}\n   URL: ${ref.url}\n   Snippet: ${ref.snippet}`
      )
      .join('\n\n');

    return { text, refs };
  } catch (err) {
    console.warn('[kb-search] Failed to parse search results:', err.message);
    return null;
  }
}
