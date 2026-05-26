import 'dotenv/config';
import { searchKnowledgeBase } from '../src/claude/kb-search.js';

const query = process.argv[2] ?? 'ServiceTitan QuickBooks integration setup';
const apiKey = process.env.ANTHROPIC_API_KEY;
const KB_DOMAIN = 'help.servicetitan.com';

function fail(reason, fix) {
  console.error(`\n[FAIL] ${reason}`);
  if (fix) console.error(`\n  → Fix: ${fix}\n`);
  process.exit(1);
}

function pass(msg) {
  console.log(`\n[PASS] ${msg}\n`);
  process.exit(0);
}

console.log(`Query:             ${query}`);
console.log(`Backend:           Anthropic web_search (scoped to ${KB_DOMAIN})`);
console.log(`ANTHROPIC_API_KEY: ${apiKey ? apiKey.slice(0, 10) + '…' + apiKey.slice(-4) : '(missing)'}`);

if (!apiKey) {
  fail(
    'ANTHROPIC_API_KEY is missing from .env',
    'Add the API key from https://console.anthropic.com/settings/keys to .env'
  );
}

console.log('\n--- raw Anthropic API call ---');

let res;
try {
  res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: [KB_DOMAIN],
        max_uses: 1,
      }],
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: query }],
    }),
  });
} catch (err) {
  fail(
    `Network error: ${err.message}`,
    'Check internet connection and that api.anthropic.com is reachable from this machine'
  );
}

const body = await res.json().catch(() => ({}));
const errType = body?.error?.type ?? '';
const errMsg = body?.error?.message ?? '';

console.log(`status: ${res.status} ${res.statusText || ''}`.trim());

if (res.status === 401) {
  fail(
    'Anthropic API key is invalid or has been revoked',
    'Regenerate the key at https://console.anthropic.com/settings/keys and update ANTHROPIC_API_KEY in .env'
  );
}

if (res.status === 403 && /web_search|tool.*not.*enabled|not.*available/i.test(errMsg)) {
  fail(
    'web_search tool is not enabled for this Anthropic account/workspace',
    'Visit https://console.anthropic.com/settings → enable web_search tool for the workspace, or contact Anthropic support'
  );
}

if (res.status === 429 || errType === 'rate_limit_error') {
  fail(
    `Anthropic rate limit hit: ${errMsg || '(no message)'}`,
    'Wait a minute and retry, or check usage at https://console.anthropic.com/settings/limits'
  );
}

if (res.status === 400 && /credit|balance|billing/i.test(errMsg)) {
  fail(
    'Anthropic account has no credit / billing issue',
    'Add credits at https://console.anthropic.com/settings/billing'
  );
}

if (!res.ok) {
  fail(
    `Unexpected ${res.status} from Anthropic API: ${errMsg || '(no message)'}`,
    `Full error type: ${errType}. Check https://console.anthropic.com for account status.`
  );
}

const toolResult = (body?.content ?? []).find((b) => b.type === 'web_search_tool_result');

if (!toolResult) {
  fail(
    `Response contained no web_search_tool_result block (got blocks: ${(body?.content ?? []).map(b => b.type).join(', ') || 'none'})`,
    'Claude refused to invoke the tool. Confirm tool_choice is set to "any" in kb-search.js, or try a more specific query.'
  );
}

const results = Array.isArray(toolResult?.content) ? toolResult.content : [];
const webResults = results.filter((r) => r?.type === 'web_search_result');

if (webResults.length === 0) {
  fail(
    `web_search returned 0 results for "${query}" (scoped to ${KB_DOMAIN})`,
    `Verify the KB domain is correct and indexed. Try a more general query, or confirm help.servicetitan.com is reachable from search engines.`
  );
}

const offDomain = webResults.filter((r) => r.url && !r.url.includes(KB_DOMAIN));
if (offDomain.length > 0) {
  fail(
    `web_search returned ${offDomain.length} result(s) outside ${KB_DOMAIN}: ${offDomain.map(r => r.url).join(', ')}`,
    `allowed_domains filter is not working as expected — check kb-search.js tool config`
  );
}

console.log(`\nReturned ${webResults.length} result(s) from ${KB_DOMAIN}:`);
webResults.forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.title}`);
  console.log(`     ${r.url}`);
});

console.log('\n--- searchKnowledgeBase() wrapper ---');
const wrapped = await searchKnowledgeBase(query);

if (!wrapped) {
  fail(
    'Raw Anthropic API works, but searchKnowledgeBase() returned null',
    'Bug in src/claude/kb-search.js — check parsing logic (raw call above succeeded)'
  );
}

if (!Array.isArray(wrapped.refs) || wrapped.refs.length === 0) {
  fail(
    'searchKnowledgeBase() returned an object but refs[] is empty',
    'Bug in src/claude/kb-search.js refs construction — tool result was present in raw response'
  );
}

console.log(`refs (${wrapped.refs.length}):`);
wrapped.refs.forEach((r, i) => console.log(`  ${i + 1}. ${r.title} — ${r.url}`));

pass(`KB search returned ${wrapped.refs.length} refs end-to-end via Anthropic web_search`);
