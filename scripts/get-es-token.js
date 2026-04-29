/**
 * One-time script to get an OAuth access token for the ES MCP server.
 * Run: node scripts/get-es-token.js
 * Then paste the printed values into your .env file.
 */

import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';

const MCP_URL = process.env.ES_MCP_URL || 'https://es-aux-mcp.st.dev/mcp';
const BASE_URL = new URL(MCP_URL).origin;
const REDIRECT_URI = 'http://localhost:3001/callback';
const SCOPE = 'mcp.access';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function registerClient() {
  const res = await fetch(`${BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'IntegrationsBot',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function exchangeCode(clientId, code, codeVerifier) {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log('Registering OAuth client...');
  const client = await registerClient();
  const clientId = client.client_id;
  console.log('Client ID:', clientId);

  const codeVerifier  = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state         = base64url(crypto.randomBytes(16));

  const authUrl = `${BASE_URL}/oauth/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  console.log('\nOpening browser for Microsoft login...');
  console.log('If the browser does not open automatically, paste this URL:\n');
  console.log(authUrl + '\n');

  exec(`start "" "${authUrl}"`);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:3001');
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
      console.log('Waiting for login... (will time out after 2 minutes)');
    });
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('Timed out waiting for login')); }, 120_000);
  });

  console.log('\nExchanging code for tokens...');
  const tokens = await exchangeCode(clientId, code, codeVerifier);

  console.log('\n✅ Done! Add these lines to your .env file:\n');
  console.log(`ES_MCP_TOKEN=${tokens.access_token}`);
  if (tokens.refresh_token) {
    console.log(`ES_MCP_REFRESH_TOKEN=${tokens.refresh_token}`);
  }
  const expiresIn = tokens.expires_in;
  if (expiresIn) {
    const mins = Math.round(expiresIn / 60);
    console.log(`\nToken expires in ${mins} minutes.`);
    if (tokens.refresh_token) {
      console.log('A refresh token was also provided — the bot will use it to stay logged in automatically.');
    } else {
      console.log('No refresh token — re-run this script when the bot starts failing again.');
    }
  }
}

main().catch((err) => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});
