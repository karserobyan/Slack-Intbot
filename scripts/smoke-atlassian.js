import 'dotenv/config';

const email = process.env.ATLASSIAN_EMAIL;
const token = process.env.ATLASSIAN_API_TOKEN;
const base = process.env.ATLASSIAN_BASE_URL ?? 'https://servicetitan.atlassian.net';

console.log(`Base URL: ${base}`);
console.log(`ATLASSIAN_EMAIL: ${email ?? '(missing)'}`);
console.log(`ATLASSIAN_API_TOKEN: ${token ? token.slice(0, 6) + '…' + token.slice(-4) : '(missing)'}\n`);

if (!email || !token) process.exit(1);

const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
const headers = { Authorization: auth, Accept: 'application/json' };

const tests = [
  { name: 'whoami', url: `${base}/wiki/rest/api/user/current` },
  { name: 'confluence', url: `${base}/wiki/rest/api/search?cql=${encodeURIComponent('text ~ "integration" AND type = page')}&limit=2` },
  { name: 'jira-myself', url: `${base}/rest/api/3/myself` },
  {
    name: 'jira-search',
    url: `${base}/rest/api/3/search/jql`,
    method: 'POST',
    body: JSON.stringify({
      jql: 'text ~ "integration" ORDER BY updated DESC',
      maxResults: 2,
      fields: ['summary', 'status'],
    }),
  },
];

for (const t of tests) {
  console.log(`--- ${t.name} ---`);
  try {
    const res = await fetch(t.url, {
      method: t.method ?? 'GET',
      headers: t.body ? { ...headers, 'Content-Type': 'application/json' } : headers,
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
