const SEARCH_URL = 'https://slack.com/api/search.messages';
const TIMEOUT_MS = 8000;

/**
 * Searches Slack messages via the Web API (NOT MCP).
 * Returns { text, refs } on success, null on missing token, placeholder token,
 * HTTP error, empty results, or any thrown exception.
 *
 * @param {string} query
 * @returns {Promise<{ text: string, refs: Array<{ url: string, channel: string, title: string }> } | null>}
 */
export async function searchSlackMessages(query) {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token || token === 'xoxp-replace-me') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('count', '5');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[slack-search] HTTP error:', res.status);
      return null;
    }

    const data = await res.json();
    if (data.ok === false) {
      console.warn('[slack-search] Slack error:', data.error);
      return null;
    }

    const matches = data.messages?.matches ?? [];
    if (matches.length === 0) return null;

    const refs = matches.map(m => ({
      url: m.permalink ?? '',
      channel: m.channel?.name ? `#${m.channel.name}` : '',
      title: (m.text ?? '').slice(0, 200),
    }));

    const text = refs
      .map((r, i) => `${i + 1}. [${r.channel}] ${r.title}\n   ${r.url}`)
      .join('\n\n');

    return { text, refs };
  } catch (err) {
    if (controller.signal.aborted) {
      console.warn('[slack-search] timed out after 8s');
    } else {
      console.warn('[slack-search] error:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
