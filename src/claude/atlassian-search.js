import 'dotenv/config';

const TIMEOUT_MS = 8000;
const CONFLUENCE_TIMEOUT_MS = 15000;
const CONFLUENCE_SPACE_KEY = 'IPD';
const PAGE_TEXT_MAX = 16000;
const API_GATEWAY = 'https://api.atlassian.com';
let missingAuthWarned = false;
let cloudIdCache = null;

export function clearAtlassianCloudId() {
  cloudIdCache = null;
}

export function isScopedAtlassianToken(token) {
  return String(token ?? '').startsWith('ATATT');
}

function siteBase() {
  return (process.env.ATLASSIAN_BASE_URL ?? 'https://servicetitan.atlassian.net').replace(/\/$/, '');
}

function credentials(product) {
  const email = process.env.ATLASSIAN_EMAIL;
  const token = (product === 'confluence'
    ? process.env.ATLASSIAN_CONFLUENCE_API_TOKEN
    : process.env.ATLASSIAN_JIRA_API_TOKEN) || process.env.ATLASSIAN_API_TOKEN;
  if (!email || !token) {
    if (!missingAuthWarned) {
      missingAuthWarned = true;
      console.warn('[atlassian] ATLASSIAN_EMAIL or an Atlassian API token is missing — Confluence and Jira search is off');
    }
    return null;
  }
  return {
    token,
    header: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
  };
}

async function cloudId(signal) {
  const configured = process.env.ATLASSIAN_CLOUD_ID?.trim();
  if (configured) return configured;
  if (cloudIdCache) return cloudIdCache;
  const res = await fetch(`${siteBase()}/_edge/tenant_info`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`tenant info HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.cloudId) throw new Error('tenant info has no cloudId');
  cloudIdCache = data.cloudId;
  return cloudIdCache;
}

export async function atlassianResourceUrl(product, token, path, signal) {
  const resource = String(path ?? '').replace(/^\//, '');
  if (!isScopedAtlassianToken(token)) {
    const root = product === 'confluence' ? `${siteBase()}/wiki` : siteBase();
    return `${root}/${resource}`;
  }
  const id = await cloudId(signal);
  const root = product === 'confluence'
    ? `${API_GATEWAY}/ex/confluence/${id}/wiki`
    : `${API_GATEWAY}/ex/jira/${id}`;
  return `${root}/${resource}`;
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

function confluenceSpaceKey(url) {
  const match = String(url ?? '').match(/\/spaces\/([^/]+)\//i);
  return match ? decodeURIComponent(match[1]) : '';
}

function stripHtml(html) {
  return (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageIdFromUrl(url) {
  const text = String(url ?? '');
  return text.match(/\/pages\/(\d+)\b/i)?.[1] || text.match(/[?&]pageId=(\d+)/i)?.[1] || '';
}

async function readConfluencePage(id, creds, signal) {
  const url = await atlassianResourceUrl('confluence', creds.token, `rest/api/content/${id}?expand=body.storage`, signal);
  const res = await fetch(url, {
    headers: { Authorization: creds.header, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) return '';
  const data = await res.json();
  const text = stripHtml(data?.body?.storage?.value ?? '');
  if (!text) return '';
  return text.length > PAGE_TEXT_MAX ? `${text.slice(0, PAGE_TEXT_MAX)}…` : text;
}

export async function searchConfluence(query, { signal: externalSignal } = {}) {
  const creds = credentials('confluence');
  if (!creds) return null;

  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), CONFLUENCE_TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([localController.signal, externalSignal])
    : localController.signal;

  try {
    const phrase = searchPhrase(query);
    if (!phrase) return { text: null, refs: [] };
    const cql = `space = "${CONFLUENCE_SPACE_KEY}" AND type = page AND text ~ "${escapeQuery(phrase)}"`;
    const url = await atlassianResourceUrl('confluence', creds.token, `rest/api/search?${new URLSearchParams({ cql, limit: '5' })}`, signal);

    const res = await fetch(url, {
      headers: { Authorization: creds.header, Accept: 'application/json' },
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
    const pages = results.map(r => {
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
        id: String(r.content?.id ?? '') || pageIdFromUrl(pageUrl),
        type: 'confluence',
        title,
        url: pageUrl,
        excerpt: stripHtml(r.excerpt ?? '').slice(0, 300),
      };
    }).filter(page => page.url && confluenceSpaceKey(page.url).toUpperCase() === CONFLUENCE_SPACE_KEY);
    if (!pages.length) return { text: null, refs: [] };

    const bodies = await Promise.all(pages.map(async (page) => {
      if (!page.id) return '';
      try {
        return await readConfluencePage(page.id, creds, signal);
      } catch {
        return '';
      }
    }));
    const refs = pages.map(({ id, ...ref }) => ref);
    const text = refs.map((ref, index) => `[Confluence] ${ref.title}\n${bodies[index] || ref.excerpt}\n${ref.url}`).join('\n\n');
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
  const creds = credentials('jira');
  if (!creds) return null;

  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([localController.signal, externalSignal])
    : localController.signal;

  try {
    const phrase = searchPhrase(query);
    if (!phrase) return { text: null, refs: [] };
    const jql = `text ~ "${escapeQuery(phrase)}" ORDER BY updated DESC`;
    const url = await atlassianResourceUrl('jira', creds.token, 'rest/api/3/search/jql', signal);

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: creds.header, Accept: 'application/json', 'Content-Type': 'application/json' },
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
