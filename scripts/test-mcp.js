/**
 * MCP connectivity diagnostic.
 * Run with: node scripts/test-mcp.js
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const atlassianToken = process.env.ATLASSIAN_MCP_TOKEN;
const slackToken = process.env.SLACK_USER_TOKEN;

console.log('─── Token check ──────────────────────────────');
console.log('ATLASSIAN_MCP_TOKEN:', atlassianToken ? `set (${atlassianToken.slice(0, 8)}…)` : 'MISSING');
console.log('SLACK_USER_TOKEN:   ', slackToken ? `set (${slackToken.slice(0, 8)}…)` : 'MISSING');

const mcpServers = [];
if (atlassianToken) {
  mcpServers.push({
    type: 'url',
    url: 'https://mcp.atlassian.com/v1/sse',
    name: 'atlassian',
    authorization_token: atlassianToken,
  });
}
if (slackToken && slackToken !== 'xoxp-replace-me') {
  mcpServers.push({
    type: 'url',
    url: 'https://mcp.slack.com/mcp',
    name: 'slack',
    authorization_token: slackToken,
  });
}

console.log('\n─── MCP servers configured ───────────────────');
mcpServers.forEach(s => console.log(` • ${s.name}: ${s.url}`));
if (mcpServers.length === 0) {
  console.error('No MCP servers — check token env vars above.');
  process.exit(1);
}

console.log('\n─── Sending test request … ───────────────────');

try {
  const response = await anthropic.beta.messages.create({
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a test assistant. When asked to search, use your available MCP tools to do so. List the tool names you have available before searching.',
    messages: [{ role: 'user', content: 'List the tools available to you, then search Confluence for "Zapier integration" and report what you find.' }],
    mcp_servers: mcpServers,
    betas: ['mcp-client-2025-04-04'],
  });

  console.log('\n─── Response ─────────────────────────────────');
  console.log('Stop reason:', response.stop_reason);
  console.log('Content blocks:');
  for (const block of response.content) {
    if (block.type === 'text') {
      console.log('  [text]', block.text.slice(0, 500));
    } else if (block.type === 'tool_use') {
      console.log('  [tool_use]', block.name, JSON.stringify(block.input).slice(0, 200));
    } else {
      console.log('  [' + block.type + ']', JSON.stringify(block).slice(0, 200));
    }
  }

  const toolsUsed = response.content.filter(b => b.type === 'tool_use').map(b => b.name);
  console.log('\n─── Verdict ──────────────────────────────────');
  if (toolsUsed.length > 0) {
    console.log('✅ MCP tools called:', toolsUsed.join(', '));
  } else {
    console.log('❌ No MCP tools called — Claude answered without searching.');
    console.log('   This means the MCP server is unreachable or the token is invalid.');
    console.log('   Check that ATLASSIAN_MCP_TOKEN is a valid OAuth 2.0 access token (not an API key or PAT).');
  }
} catch (err) {
  console.error('\n─── Error ────────────────────────────────────');
  console.error(err.message);
  if (err.status) console.error('HTTP status:', err.status);
  if (err.error) console.error('API error:', JSON.stringify(err.error, null, 2));
}
