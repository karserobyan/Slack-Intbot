/**
 * One-time script to get an Atlassian OAuth 2.0 access token for the MCP server.
 * Run: node scripts/get-atlassian-token.js
 * Then paste the printed values into your .env file.
 *
 * Prerequisites in .env:
 *   ATLASSIAN_CLIENT_ID=...
 *   ATLASSIAN_CLIENT_SECRET=...
 */
import 'dotenv/config';
import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';

const CLIENT_ID     = process.env.ATLASSIAN_CLIENT_ID;
const CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3001/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing ATLASSIAN_CLIENT_ID or ATLASSIAN_CLIENT_SECRET in .env');
  process.exit(1);
}

const SCOPES = [
  // Confluence
  'read:content:confluence',
  'read:content-details:confluence',
  'read:space-details:confluence',
  'read:audit-log:confluence',
  'read:page:confluence',
  'read:attachment:confluence',
  'read:custom-content:confluence',
  'read:comment:confluence',
  'read:label:confluence',
  'read:user:confluence',
  'read:space:confluence',
  // Jira
  'read:notes:customer-notes',
  'read:viewers:support-api-gateway',
  'read:application-role:jira',
  'read:audit-log:jira',
  'read:dashboard:jira',
  'read:filter:jira',
  'read:filter.column:jira',
  'read:issue:jira',
  'read:attachment:jira',
  'read:comment:jira',
  'read:issue-link:jira',
  'read:priority:jira',
  'read:issue.property:jira',
  'read:resolution:jira',
  'read:issue-details:jira',
  'read:issue.remote-link:jira',
  'read:issue-status:jira',
  'read:user:jira',
  'read:project:jira',
  'read:epic:jira-software',
  'read:issue:jira-software',
  'read:sprint:jira-software',
  'read:source-code:jira-software',
  'read:feature-flag:jira-software',
  'read:build:jira-software',
  'read:remote-link:jira-software',
  'read:deployment:jira-software',
  'read:product:jira-service-management',
  'read:queue:jira-service-management',
  'read:requesttype:jira-service-management',
  'read:knowledgebase:jira-service-management',
  // Required for refresh tokens
  'offline_access',
].join(' ');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const state = base64url(crypto.randomBytes(16));

const authUrl = 'https://auth.atlassian.com/authorize?' + new URLSearchParams({
  audience:      'api.atlassian.com',
  client_id:     CLIENT_ID,
  scope:         SCOPES,
  redirect_uri:  REDIRECT_URI,
  state,
  response_type: 'code',
  prompt:        'consent',
});

console.log('Opening browser for Atlassian login…');
console.log('If the browser does not open automatically, paste this URL:\n');
console.log(authUrl + '\n');

exec(`start "" "${authUrl}"`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url           = new URL(req.url, 'http://localhost:3001');
    const returnedState = url.searchParams.get('state');
    const code          = url.searchParams.get('code');
    const error         = url.searchParams.get('error');

    if (error) {
      res.end(`<h1>Error: ${error}</h1>`);
      server.close();
      reject(new Error(`OAuth error: ${error}`));
      return;
    }
    if (returnedState !== state) {
      res.end('<h1>State mismatch — please try again.</h1>');
      server.close();
      reject(new Error('State mismatch'));
      return;
    }

    res.end('<h1>Done! You can close this tab and go back to the terminal.</h1>');
    server.close();
    resolve(code);
  });

  server.listen(3001, () => {
    console.log('Waiting for login… (will time out after 2 minutes)');
  });
  server.on('error', reject);
  setTimeout(() => { server.close(); reject(new Error('Timed out waiting for login')); }, 120_000);
});

console.log('\nExchanging code for tokens…');

const res = await fetch('https://auth.atlassian.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri:  REDIRECT_URI,
  }),
});

if (!res.ok) {
  throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
}

const tokens = await res.json();

console.log('\n✅ Done! Add these lines to your .env file:\n');
console.log(`ATLASSIAN_MCP_TOKEN=${tokens.access_token}`);
if (tokens.refresh_token) {
  console.log(`ATLASSIAN_REFRESH_TOKEN=${tokens.refresh_token}`);
}
if (tokens.expires_in) {
  const mins = Math.round(tokens.expires_in / 60);
  console.log(`\nToken expires in ${mins} minutes.`);
  if (tokens.refresh_token) {
    console.log('Refresh token included — re-run this script when the access token expires.');
  } else {
    console.log('No refresh token — re-run this script when the bot stops searching.');
  }
}
