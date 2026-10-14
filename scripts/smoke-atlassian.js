import 'dotenv/config';
import { atlassianResourceUrl, isScopedAtlassianToken } from '../src/claude/atlassian-search.js';

const email = process.env.ATLASSIAN_EMAIL;
const confluenceToken = process.env.ATLASSIAN_CONFLUENCE_API_TOKEN || process.env.ATLASSIAN_API_TOKEN;
const jiraToken = process.env.ATLASSIAN_JIRA_API_TOKEN || process.env.ATLASSIAN_API_TOKEN;
const base = process.env.ATLASSIAN_BASE_URL ?? 'https://servicetitan.atlassian.net';

function describe(token) {
  if (!token) return '(missing)';
  const kind = isScopedAtlassianToken(token) ? 'scoped' : 'classic';
  return `${token.slice(0, 6)}…${token.slice(-4)} (${kind})`;
}

console.log(`Site: ${base}`);
console.log(`ATLASSIAN_EMAIL: ${email ?? '(missing)'}`);
console.log(`Confluence token: ${describe(confluenceToken)}`);
console.log(`Jira token: ${describe(jiraToken)}\n`);

if (!email || (!confluenceToken && !jiraToken)) process.exit(1);

function authHeader(token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

const tests = [];
if (confluenceToken) {
  tests.push(
    { name: 'whoami', product: 'confluence', token: confluenceToken, path: 'rest/api/user/current' },
    { name: 'confluence', product: 'confluence', token: confluenceToken, path: `rest/api/search?cql=${encodeURIComponent('space = "IPD" AND type = page AND text ~ "integration"')}&limit=2` },
  );
}
if (jiraToken) {
  tests.push(
    { name: 'jira-myself', product: 'jira', token: jiraToken, path: 'rest/api/3/myself' },
    {
      name: 'jira-search',
      product: 'jira',
      token: jiraToken,
      path: 'rest/api/3/search/jql',
      method: 'POST',
      body: JSON.stringify({
        jql: 'text ~ "integration" ORDER BY updated DESC',
        maxResults: 2,
        fields: ['summary', 'status'],
      }),
    },
  );
}

for (const t of tests) {
  console.log(`--- ${t.name} ---`);
  try {
    const url = await atlassianResourceUrl(t.product, t.token, t.path);
    console.log(url);
    const res = await fetch(url, {
      method: t.method ?? 'GET',
      headers: t.body
        ? { Authorization: authHeader(t.token), Accept: 'application/json', 'Content-Type': 'application/json' }
        : { Authorization: authHeader(t.token), Accept: 'application/json' },
      body: t.body,
    });
    const body = await res.text();
    console.log(`status: ${res.status} ${res.statusText}`);
    console.log(body.slice(0, 400));
  } catch (err) {
    console.log(`error: ${err.message}`);
  }
  console.log();
}
