import 'dotenv/config';

const BASE_URL = process.env.ATLASSIAN_BASE_URL ?? 'https://servicetitan.atlassian.net';
const TIMEOUT_MS = 8000;

function getAuth() {
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN;
  if (!email || !token) return null;
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function escapeQuery(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stripHtml(html) {
  return (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchConfluence(query, { signal: externalSignal } = {}) {
  const auth = getAuth();
  if (!auth) return null;

  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([localController.signal, externalSignal])
    : localController.signal;

  try {
    const cql = `text ~ "${escapeQuery(query)}" AND type = page`;
    // Top-5 results; cap bounds the answerer prompt (rationale: MAX_RESULTS in kb-search.js).
    const url = `${BASE_URL}/wiki/rest/api/search?` + new URLSearchParams({ cql, limit: '5' });

    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal,
    });

    if (!res.ok) {
      console.warn('[atlassian] Confluence search HTTP error:', res.status);
      return null;
    }

    const data = await res.json();
    const results = data.results ?? [];
    if (results.length === 0) return { text: null, refs: [] };

    const refs = results.map(r => ({
      type: 'confluence',
      title: r.title ?? 'Untitled',
      url: `${BASE_URL}/wiki${r.url ?? ''}`,
      excerpt: stripHtml(r.excerpt ?? '').slice(0, 300),
    }));

    const text = refs.map(r => `[Confluence] ${r.title}\n${r.excerpt}\n${r.url}`).join('\n\n');
    return { text, refs };
  } catch (err) {
    if (localController.signal.aborted) {
      console.warn('[atlassian] Confluence search timed out');
    } else if (externalSignal?.aborted) {
      console.warn('[atlassian] Confluence search aborted by pipeline budget');
    } else {
      console.warn('[atlassian] Confluence search error:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchJira(query, { signal: externalSignal } = {}) {
  const auth = getAuth();
  if (!auth) return null;

  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([localController.signal, externalSignal])
    : localController.signal;

  try {
    const jql = `text ~ "${escapeQuery(query)}" ORDER BY updated DESC`;
    const url = `${BASE_URL}/rest/api/3/search/jql?` + new URLSearchParams({
      jql,
      // Top-5 results; cap bounds the answerer prompt (rationale: MAX_RESULTS in kb-search.js).
      maxResults: '5',
      fields: 'summary,status,issuetype',
    });

    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal,
    });

    if (!res.ok) {
      console.warn('[atlassian] Jira search HTTP error:', res.status);
      return null;
    }

    const data = await res.json();
    const issues = data.issues ?? [];
    if (issues.length === 0) return { text: null, refs: [] };

    const refs = issues.map(i => ({
      type: 'jira',
      title: `${i.key} — ${i.fields?.summary ?? ''}`,
      url: `${BASE_URL}/browse/${i.key}`,
      status: i.fields?.status?.name ?? '',
    }));

    const text = refs.map(r => `[Jira] ${r.title} [${r.status}]\n${r.url}`).join('\n\n');
    return { text, refs };
  } catch (err) {
    if (localController.signal.aborted) {
      console.warn('[atlassian] Jira search timed out');
    } else if (externalSignal?.aborted) {
      console.warn('[atlassian] Jira search aborted by pipeline budget');
    } else {
      console.warn('[atlassian] Jira search error:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
