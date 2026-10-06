import 'dotenv/config';

const TIMEOUT_MS = 8000;
let missingAuthWarned = false;

function siteBase() {
  return (process.env.ATLASSIAN_BASE_URL ?? 'https://servicetitan.atlassian.net').replace(/\/$/, '');
}

function getAuth() {
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN;
  if (!email || !token) {
    if (!missingAuthWarned) {
      missingAuthWarned = true;
      console.warn('[atlassian] ATLASSIAN_EMAIL or ATLASSIAN_API_TOKEN is missing — Confluence and Jira search is off');
    }
    return null;
  }
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function searchPhrase(query) {
  return String(query ?? '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .slice(0, 8)
    .join(' ');
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
    const phrase = searchPhrase(query);
    if (!phrase) return { text: null, refs: [] };
    const cql = `text ~ "${escapeQuery(phrase)}" AND type = page`;
    const url = `${siteBase()}/wiki/rest/api/search?` + new URLSearchParams({ cql, limit: '5' });

    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[atlassian] Confluence search HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const results = data.results ?? [];
    if (results.length === 0) return { text: null, refs: [] };

    const base = siteBase();
    const refs = results.map(r => {
      const raw = r.url || r.content?._links?.webui || '';
      let pageUrl = '';
      if (/^https?:\/\//i.test(raw)) pageUrl = raw;
      else if (raw) {
        const path = raw.startsWith('/wiki') ? raw : `/wiki${raw.startsWith('/') ? raw : `/${raw}`}`;
        pageUrl = `${base}${path}`;
      } else if (r.content?.id) {
        pageUrl = `${base}/wiki/pages/viewpage.action?pageId=${r.content.id}`;
      }
      const title = String(r.content?.title || r.title || 'Untitled').replace(/@@@hl@@@|@@@endhl@@@/g, '').trim();
      return {
        type: 'confluence',
        title,
        url: pageUrl,
        excerpt: stripHtml(r.excerpt ?? '').slice(0, 300),
      };
    }).filter(r => r.url);

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
    const phrase = searchPhrase(query);
    if (!phrase) return { text: null, refs: [] };
    const jql = `text ~ "${escapeQuery(phrase)}" ORDER BY updated DESC`;
    const url = `${siteBase()}/rest/api/3/search/jql`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        maxResults: 5,
        fields: ['summary', 'status'],
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[atlassian] Jira search HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const issues = data.issues ?? [];
    if (issues.length === 0) return { text: null, refs: [] };

    const refs = issues.map(i => ({
      type: 'jira',
      title: `${i.key} — ${i.fields?.summary ?? ''}`,
      url: `${siteBase()}/browse/${i.key}`,
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
