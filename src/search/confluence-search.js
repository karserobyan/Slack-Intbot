const BASE_URL = 'https://servicetitan.atlassian.net/wiki/rest/api';

function authHeader() {
  const email = process.env.ATLASSIAN_EMAIL ?? '';
  const token = process.env.ATLASSIAN_MCP_TOKEN ?? '';
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

/**
 * Builds a CQL (Confluence Query Language) expression from an array of keywords.
 * Each keyword is wrapped in a `text ~ "kw"` clause and joined with AND.
 * Falls back to `type=page` when no keywords are provided.
 *
 * @param {string[]} keywords - Array of keyword strings to search for
 * @returns {string} A valid CQL expression string
 */
export function buildCql(keywords) {
  if (keywords.length === 0) return 'type=page';
  const terms = keywords.map((kw) => `text ~ "${kw}"`).join(' AND ');
  return `type=page AND (${terms})`;
}

/**
 * Searches Confluence for pages matching the given keywords using the REST API.
 * Returns up to `limit` results with title, plain-text excerpt, and page URL.
 * Returns an empty array if credentials are missing or no keywords are provided.
 *
 * @param {string[]} keywords - Array of keyword strings extracted from the user query
 * @param {object} [options]
 * @param {number} [options.limit=3] - Maximum number of results to return
 * @returns {Promise<Array<{ title: string, excerpt: string, url: string }>>}
 */
export async function searchConfluence(keywords, { limit = 3 } = {}) {
  if (!process.env.ATLASSIAN_MCP_TOKEN || !process.env.ATLASSIAN_EMAIL) return [];
  if (keywords.length === 0) return [];

  const cql = buildCql(keywords);
  const url = `${BASE_URL}/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=excerpt`;

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Confluence search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.results ?? []).map((page) => ({
    title: page.title,
    excerpt: (page.excerpt ?? '').replace(/<[^>]+>/g, '').slice(0, 300),
    url: `https://servicetitan.atlassian.net/wiki${page._links?.webui ?? ''}`,
  }));
}
