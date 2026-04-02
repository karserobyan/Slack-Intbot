/**
 * Local functionality test — exercises all core modules without
 * requiring Slack or Anthropic API connections.
 */

import { isAccountingTopic } from './src/utils/accounting-filter.js';
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildEmailModal,
} from './src/slack/blocks.js';
import { getCached, setCached, cacheStats, pruneExpired, deleteCache } from './src/slack/cache.js';
import { getHistory, appendToHistory, hasHistory, pruneConversations } from './src/slack/conversation.js';
import { parseClaudeResponse } from './src/claude/prompts.js';
import { getRelevantFeedback } from './src/slack/feedback.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// ── 1. Accounting Filter ─────────────────────────────────────────────────────
console.log('\n🔹 Accounting Filter');

assert(isAccountingTopic('How do I connect QuickBooks?') === true, 'Detects QuickBooks');
assert(isAccountingTopic('Sage Intacct sync is broken') === true, 'Detects Sage Intacct');
assert(isAccountingTopic('NetSuite GL accounts not mapping') === true, 'Detects NetSuite');
assert(isAccountingTopic('Net Suite sync is broken') === true, 'Detects Net Suite (space-separated)');
assert(isAccountingTopic('Xero integration setup') === true, 'Detects Xero');
assert(isAccountingTopic('Viewpoint Vista accounts payable') === true, 'Detects Viewpoint Vista');
assert(isAccountingTopic('accounts receivable report issue') === true, 'Detects accounts receivable');
assert(isAccountingTopic('QBO desktop connector') === true, 'Detects QBO abbreviation');

assert(isAccountingTopic('Zapier API access not working') === false, 'Zapier is NOT accounting');
assert(isAccountingTopic('Angi leads not syncing') === false, 'Angi is NOT accounting');
assert(isAccountingTopic('Reserve with Google location matching') === false, 'RwG is NOT accounting');
assert(isAccountingTopic('Thumbtack redirect loop') === false, 'Thumbtack is NOT accounting');
assert(isAccountingTopic('ServiceChannel photos not syncing') === false, 'ServiceChannel is NOT accounting');
assert(isAccountingTopic('Chat-to-text widget not showing') === false, 'Chat-to-Text is NOT accounting');

// False positive guard — these must NOT trigger accounting redirect
assert(isAccountingTopic('customer has zero Angi leads syncing') === false, 'zero does not match xero');
assert(isAccountingTopic('netsuitething not syncing') === false, 'netsuite word boundary: netsuitething must not match');
assert(isAccountingTopic('quickbooksreader tool installed') === false, 'quickbooks word boundary: quickbooksreader must not match');

// ── 2. Claude Response Parsing ───────────────────────────────────────────────
console.log('\n🔹 Claude Response Parsing');

const sampleJson = {
  issue_title: 'Zapier API Access Not Enabled',
  integration_type: 'Zapier',
  is_accounting_topic: false,
  agent_steps: [
    { num: 1, title: 'Check tenant Zapier config', detail: 'Go to Admin > Integrations > Zapier and verify API access is toggled on.', tag: 'action' },
    { num: 2, title: 'Enable API access on backend', detail: 'In the ST admin portal, find the tenant and enable Zapier API access under the Integrations tab.', tag: 'backend' },
    { num: 3, title: 'Verify connection', detail: 'Ask the customer to reconnect Zapier and confirm a test zap triggers successfully.', tag: 'verify' },
    { num: 4, title: 'Escalate if still failing', detail: 'If the issue persists after enabling API access, escalate to the Integrations Engineering team via #integrations-ts-specialists.', tag: 'escalate' },
  ],
  customer_email: {
    subject: 'Re: Zapier Integration Setup — ServiceTitan Integrations Support',
    body: "Hi there,\n\nThank you for reaching out about your Zapier integration.\n\nWe've enabled API access on your account, which was the missing piece for getting Zapier connected. You should now be able to complete the setup on your end by following these steps:\n\n1. Log into your Zapier account\n2. Search for ServiceTitan in the app directory\n3. Follow the prompts to connect your account\n\nPlease let us know if you run into any issues during setup -- we're happy to help!\n\nBest regards,\nServiceTitan Integrations Support Team",
    kb_links: [
      { label: 'How to set up Zapier with ServiceTitan', url: 'https://help.servicetitan.com/how-to/zapier' },
    ],
  },
  slack_refs: [
    { channel: 'ask-integrations', author: 'jsmith', issue_summary: 'Similar Zapier setup issue', resolution: 'Enabled API access on backend', was_resolved: true },
  ],
  atlassian_refs: [
    { type: 'confluence', title: 'Zapier Setup Guide', summary: 'Step-by-step Zapier config', url: 'https://company.atlassian.net/wiki/zapier', status: null, assignee: null },
    { type: 'jira', title: 'INT-4821', summary: 'Zapier not connecting for tenant', url: 'https://company.atlassian.net/browse/INT-4821', status: 'Done', assignee: 'jdoe' },
  ],
  sources_used: ['slack', 'confluence', 'jira', 'kb'],
};

// Parse from raw JSON string
const parsed = parseClaudeResponse(JSON.stringify(sampleJson));
assert(parsed.issue_title === 'Zapier API Access Not Enabled', 'Parses clean JSON');

// Parse with accidental markdown fences
const withFences = '```json\n' + JSON.stringify(sampleJson) + '\n```';
const parsed2 = parseClaudeResponse(withFences);
assert(parsed2.issue_title === 'Zapier API Access Not Enabled', 'Strips markdown fences');

// Parse invalid JSON should throw
let threwError = false;
try { parseClaudeResponse('not json at all'); } catch { threwError = true; }
assert(threwError, 'Throws on invalid JSON');

// ── 3. Block Kit Builders ────────────────────────────────────────────────────
console.log('\n🔹 Block Kit Builders');

const responseBlocks = buildResponseBlocks(sampleJson);
assert(Array.isArray(responseBlocks), 'buildResponseBlocks returns array');
assert(responseBlocks.length > 0 && responseBlocks.length <= 50, `Response blocks count: ${responseBlocks.length} (≤50 limit)`);
assert(responseBlocks[0].type === 'header', 'First block is header');
assert(responseBlocks.some(b => b.type === 'divider'), 'Contains dividers');
assert(responseBlocks.some(b => b.type === 'actions'), 'Contains copy email button');
assert(responseBlocks[responseBlocks.length - 1].type === 'context', 'Last block is context footer');

// Check header contains issue title
const headerText = responseBlocks[0].text.text;
assert(headerText.includes('Zapier API Access Not Enabled'), 'Header has issue title');

// Check steps are present
const stepBlocks = responseBlocks.filter(b => b.type === 'section' && b.text?.text?.match(/^\*\d+\.\*/));
assert(stepBlocks.length === 4, `All 4 agent steps rendered (found ${stepBlocks.length})`);

// Check tags render
assert(stepBlocks[0].text.text.includes('`action`'), 'Step 1 has action tag');
assert(stepBlocks[1].text.text.includes('`backend`'), 'Step 2 has backend tag');

// Accounting redirect
const redirectBlocks = buildAccountingRedirectBlocks('How do I set up QuickBooks?');
assert(redirectBlocks.length === 2, 'Redirect has 2 blocks');
assert(redirectBlocks[0].text.text.includes('#ask-partner-enabled-accounting-integrations'), 'Redirect mentions correct channel');

// Thinking blocks
const thinkingBlocks = buildThinkingBlocks('Zapier not working');
assert(thinkingBlocks.length === 2, 'Thinking has 2 blocks');
assert(thinkingBlocks[0].text.text.includes('Checking'), 'Thinking shows checking message');

// Error blocks
const errorBlocks = buildErrorBlocks('test query');
assert(errorBlocks.length === 2, 'Error has 2 blocks');
assert(errorBlocks[0].text.text.includes('went wrong'), 'Error shows error message');

// Email modal
const modal = buildEmailModal('Test Subject', 'Test body text');
assert(modal.type === 'modal', 'Modal has correct type');
assert(modal.blocks.length === 2, 'Modal has subject + body blocks');

// ── 4. Cache ─────────────────────────────────────────────────────────────────
console.log('\n🔹 Cache');

// Cache miss
assert(getCached('nonexistent query') === null, 'Cache miss returns null');

// Cache set + hit
setCached('Zapier API access not working', sampleJson);
const cached = getCached('Zapier API access not working');
assert(cached !== null, 'Cache hit after set');
assert(cached.issue_title === 'Zapier API Access Not Enabled', 'Cache returns correct data');

// Key normalisation (case + whitespace)
const cached2 = getCached('  ZAPIER   api ACCESS  not   working  ');
assert(cached2 !== null, 'Cache key normalisation works (case + whitespace)');

// Stats
const stats = cacheStats();
assert(stats.size === 1, `Cache size is 1 (got ${stats.size})`);

// Prune (nothing should expire since TTL is 1 hour)
pruneExpired();
assert(getCached('Zapier API access not working') !== null, 'Prune does not remove fresh entries');

// deleteCache
setCached('delete test query', sampleJson);
assert(getCached('delete test query') !== null, 'Entry exists before delete');
deleteCache('delete test query');
assert(getCached('delete test query') === null, 'deleteCache removes the entry');
// Key normalisation applies to delete too
setCached('normalise delete', sampleJson);
deleteCache('  NORMALISE   DELETE  ');
assert(getCached('normalise delete') === null, 'deleteCache normalises key');

// ── 5. Accounting + Non-Accounting Response Flow Simulation ──────────────────
console.log('\n🔹 End-to-End Flow Simulation');

// Simulate: agent asks about QuickBooks → should get redirect
const accountingQuery = 'Customer asking about QuickBooks sync failing with GL accounts';
assert(isAccountingTopic(accountingQuery) === true, 'Accounting query detected → redirect path');
const accountingBlocks = buildAccountingRedirectBlocks(accountingQuery);
assert(accountingBlocks[0].text.text.includes('accounting integration'), 'Redirect response generated');

// Simulate: agent asks about Zapier → should get full response
const zapierQuery = 'Customer says Zapier integration shows no API access on their tenant';
assert(isAccountingTopic(zapierQuery) === false, 'Zapier query NOT flagged as accounting');

// Simulate Claude returning a response
const mockClaudeOutput = JSON.stringify(sampleJson);
const parsedResponse = parseClaudeResponse(mockClaudeOutput);
assert(parsedResponse.is_accounting_topic === false, 'Claude confirms not accounting');
const finalBlocks = buildResponseBlocks(parsedResponse);
assert(finalBlocks.length <= 50, 'Final response within Slack block limit');

// ── 6. Edge Cases ────────────────────────────────────────────────────────────
console.log('\n🔹 Edge Cases');

// Empty agent_steps
const emptySteps = buildResponseBlocks({ ...sampleJson, agent_steps: [] });
assert(emptySteps.length > 0, 'Handles empty agent_steps without crashing');

// Missing customer_email
const noEmail = buildResponseBlocks({ ...sampleJson, customer_email: null });
assert(noEmail.length > 0, 'Handles null customer_email without crashing');

// Missing refs
const noRefs = buildResponseBlocks({ ...sampleJson, slack_refs: [], atlassian_refs: [] });
assert(noRefs.length > 0, 'Handles empty refs without crashing');

// Very long query in thinking/error blocks
const longQuery = 'A'.repeat(500);
const longThinking = buildThinkingBlocks(longQuery);
assert(longThinking[0].text.text.length < 3100, 'Long query is truncated in thinking block');

// Button value length guard — Slack's limit is 2000 chars
const longTitleBlocks = buildResponseBlocks({
  ...sampleJson,
  issue_title: 'A'.repeat(200),
  integration_type: 'B'.repeat(100),
  _originalQuery: 'C'.repeat(600),
});
const actionsBlock = longTitleBlocks.find(b => b.type === 'actions');
const wrongBtn = actionsBlock?.elements?.find(e => e.action_id === 'wrong_answer_modal');
assert(wrongBtn !== undefined, 'wrong_answer_modal button exists even with long values');
assert(wrongBtn.value.length <= 2000, `wrong_answer_modal value within 2000 chars (got ${wrongBtn?.value?.length})`);

// ── 7. Feedback Module ───────────────────────────────────────────────────────
console.log('\n🔹 Feedback Module');

// Test: getRelevantFeedback returns an array (empty when no feedback on disk)
const emptyFeedback = await getRelevantFeedback('zapier api access not working');
assert(Array.isArray(emptyFeedback), 'getRelevantFeedback returns array');

// Test: query with only short words (≤3 chars) — all words filtered, returns empty
const shortWordFeedback = await getRelevantFeedback('it is ok');
assert(Array.isArray(shortWordFeedback), 'Short-word query returns array');
assert(shortWordFeedback.length === 0, 'Short-word query matches nothing (all words ≤3 chars filtered)');

// ── 8. Conversation History ───────────────────────────────────────────────────
console.log('\n🔹 Conversation History');

// Miss — no history yet
assert(getHistory('ts-999') === null, 'getHistory returns null for unknown thread');
assert(hasHistory('ts-999') === false, 'hasHistory returns false for unknown thread');

// Append and retrieve
appendToHistory('ts-001', [
  { role: 'user', content: 'Zapier not working' },
  { role: 'assistant', content: '{"issue_title":"Zapier API Access"}' },
]);
const h1 = getHistory('ts-001');
assert(h1 !== null, 'getHistory returns history after append');
assert(h1.length === 2, 'History has 2 messages after one append');
assert(h1[0].role === 'user', 'First message is user');
assert(h1[1].role === 'assistant', 'Second message is assistant');
assert(hasHistory('ts-001') === true, 'hasHistory returns true after append');

// Append again (follow-up)
appendToHistory('ts-001', [
  { role: 'user', content: 'Can you rewrite the email?' },
  { role: 'assistant', content: 'Sure, here is a revised version...' },
]);
const h2 = getHistory('ts-001');
assert(h2.length === 4, 'History grows with subsequent appends');

// Max messages cap — adding 10 pairs should trim to 20
for (let i = 0; i < 10; i++) {
  appendToHistory('ts-cap', [
    { role: 'user', content: `msg ${i}` },
    { role: 'assistant', content: `reply ${i}` },
  ]);
}
const hCap = getHistory('ts-cap');
assert(hCap.length === 20, `Max 20 messages enforced (got ${hCap?.length})`);

// pruneConversations does not remove fresh entries
pruneConversations();
assert(getHistory('ts-001') !== null, 'pruneConversations keeps fresh entries');

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log('\n⚠️  Some tests failed — review above.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed! Core functionality is working correctly.');
  process.exit(0);
}
