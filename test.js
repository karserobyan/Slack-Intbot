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
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildSourcesModal,
} from './src/slack/blocks.js';
import { getCached, setCached, cacheStats, pruneExpired, deleteCache } from './src/slack/cache.js';
import { getHistory, appendToHistory, hasHistory, pruneConversations } from './src/slack/conversation.js';
import { parseClaudeResponse, summarizeResultForHistory } from './src/claude/prompts.js';
import { getRelevantFeedback, getAllFeedback, saveFeedback, approveFeedback, rejectFeedback, getPendingFeedback } from './src/slack/feedback.js';
import { searchKnowledgeBase } from './src/claude/kb-search.js';

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
  findings_summary: {
    diagnosis: 'The Zapier integration is failing because API access has not been enabled on the ServiceTitan backend for this tenant.',
    actions: [
      'Enable Zapier API access via the ST backend admin panel',
      'Have the customer re-authenticate their Zapier account',
      'Verify the first trigger fires successfully after re-auth',
    ],
    guidance: 'If re-auth still fails, check whether the tenant is on a legacy Zapier plan that requires manual re-provisioning.',
  },
  slack_refs: [
    { url: 'https://servicetitan.slack.com/archives/C123/p456', channel: '#ask-integrations', title: 'Zapier API access not working after tenant migration' },
  ],
  atlassian_refs: [
    { type: 'confluence', url: 'https://company.atlassian.net/wiki/zapier', title: 'Zapier Integration Setup Guide' },
    { type: 'jira', url: 'https://company.atlassian.net/browse/INT-4821', title: 'INT-4821 — Zapier not connecting for tenant' },
  ],
  kb_refs: [
    { url: 'https://help.servicetitan.com/zapier-setup', title: 'Setting up Zapier with ServiceTitan', snippet: 'Enable API access in the ST admin portal before connecting Zapier.' },
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

// Parse clarifying-question-only response (no other fields)
const clarifyOnly = parseClaudeResponse('{"clarifying_question": "Has Zapier API access been enabled for this tenant?"}');
assert(clarifyOnly.clarifying_question === 'Has Zapier API access been enabled for this tenant?', 'Parses clarifying-question-only response');
assert(clarifyOnly.issue_title === undefined, 'No issue_title in clarifying-question-only response');

// Parse invalid JSON should throw
let threwError = false;
try { parseClaudeResponse('not json at all'); } catch { threwError = true; }
assert(threwError, 'Throws on invalid JSON');

// ── summarizeResultForHistory ────────────────────────────────────────────────
console.log('\n🔹 summarizeResultForHistory');

const resultWithEscalate = {
  customer_message: 'Hi Sarah, I can see exactly what happened — your Zapier connection was reset during our recent migration. I\'m re-enabling it right now.',
  agent_steps: [
    { num: 1, title: 'Enable Zapier API', detail: 'Go to Admin > Integrations > Zapier and toggle API access on.', tag: 'backend' },
    { num: 2, title: 'Verify connection', detail: 'Ask customer to reconnect Zapier.', tag: 'verify' },
  ],
  escalate_decision: { should_escalate: false, reason: 'CSA can handle this directly' },
  findings_summary: {
    diagnosis: 'Zapier API access needs enabling on the backend.',
    actions: ['Enable Zapier API access', 'Ask customer to re-authenticate'],
  },
  confidence: 'high',
  sources_used: ['slack', 'confluence'],
};

const histSummary = summarizeResultForHistory(resultWithEscalate);
assert(typeof histSummary === 'string', 'summarizeResultForHistory returns string');
assert(histSummary.includes('Hi Sarah'), 'summary includes customer_message');
assert(histSummary.includes('Enable Zapier API'), 'summary includes step title');
assert(histSummary.includes('backend'), 'summary includes step tag');
assert(histSummary.includes('No escalation needed'), 'summary includes no-escalation text');
assert(histSummary.includes('CSA can handle this directly'), 'summary includes escalation reason');
assert(histSummary.includes('Zapier API access needs enabling'), 'summary includes findings_summary diagnosis');
assert(histSummary.includes('high'), 'summary includes confidence');
assert(histSummary.includes('slack'), 'summary includes sources');
assert(!histSummary.includes('{'), 'summary contains no raw JSON');
assert(!histSummary.includes('"role"'), 'summary contains no JSON keys');

// Specialist mode — no escalate_decision field
const specialistResult = {
  customer_message: 'Hi Mike, the API token was invalidated during the migration — I\'m re-issuing it now.',
  agent_steps: [{ num: 1, title: 'Check backend config', detail: 'Access the ST admin portal.', tag: 'backend' }],
  confidence: 'medium',
  sources_used: ['jira'],
};
const specialistSummary = summarizeResultForHistory(specialistResult);
assert(!specialistSummary.includes('Escalation:'), 'no escalation line in specialist summary');
assert(specialistSummary.includes('Hi Mike'), 'specialist summary includes customer_message');

// Long step detail is truncated to 300 chars
const longDetailResult = {
  intro_message: 'Hey Dave.',
  agent_steps: [{ num: 1, title: 'Long step', detail: 'X'.repeat(400), tag: 'action' }],
  confidence: 'low',
  sources_used: [],
};
const longSummary = summarizeResultForHistory(longDetailResult);
const stepLine = longSummary.split('\n').find(l => l.includes('Long step'));
assert(stepLine !== undefined, 'long detail step line present');
assert(stepLine !== undefined && stepLine.length < 400, 'long step detail is truncated');

// Accounting topic returns empty string
assert(summarizeResultForHistory({ is_accounting_topic: true }) === '', 'accounting topic returns empty string');

// No customer_email (low confidence suppression)
const noEmailResult = {
  intro_message: 'Hey Lee.',
  agent_steps: [],
  confidence: 'low',
  sources_used: ['slack'],
};
const noEmailSummary = summarizeResultForHistory(noEmailResult);
assert(!noEmailSummary.includes('Customer email drafted'), 'no email line when customer_email absent');

// clarifying_question included in summary when present
const resultWithQuestion = {
  intro_message: 'Hey Sarah, let me look into this.',
  agent_steps: [{ num: 1, title: 'Enable API', detail: 'Toggle Zapier API access on.', tag: 'backend' }],
  confidence: 'medium',
  sources_used: ['slack'],
  clarifying_question: 'Has Zapier API access already been enabled on the backend, or is that still to check?',
};
const questionSummary = summarizeResultForHistory(resultWithQuestion);
assert(questionSummary.includes('I asked the agent:'), 'summary includes clarifying question label');
assert(questionSummary.includes('Has Zapier API access already been enabled'), 'summary includes clarifying question text');

// clarifying_question absent when null
const resultNoQuestion = {
  intro_message: 'Hey Mike.',
  agent_steps: [],
  confidence: 'high',
  sources_used: ['confluence'],
  clarifying_question: null,
};
const noQuestionSummary = summarizeResultForHistory(resultNoQuestion);
assert(!noQuestionSummary.includes('I asked the agent:'), 'no clarifying question line when null');

// summarizeResultForHistory with clarifying-question-only result (no intro, no steps)
const clarifyOnlyResult = { clarifying_question: 'Has Zapier API access been enabled for this tenant?' };
const clarifyOnlySummary = summarizeResultForHistory(clarifyOnlyResult);
assert(clarifyOnlySummary.includes('Has Zapier API access been enabled'), 'clarify-only summary includes the question');
assert(!clarifyOnlySummary.includes('Confidence:'), 'clarify-only summary omits noise when no confidence/sources');

// confidence: null should also suppress the line
const clarifyNullConf = { clarifying_question: 'Any question?', confidence: null };
const clarifyNullSummary = summarizeResultForHistory(clarifyNullConf);
assert(!clarifyNullSummary.includes('Confidence:'), 'null confidence suppresses confidence/sources line');

// ── 3. Block Kit Builders ────────────────────────────────────────────────────
console.log('\n🔹 Block Kit Builders');

const responseBlocks = buildResponseBlocks(sampleJson);
assert(Array.isArray(responseBlocks), 'buildResponseBlocks returns array');
assert(responseBlocks.length > 0 && responseBlocks.length <= 50, `Response blocks count: ${responseBlocks.length} (≤50 limit)`);
assert(responseBlocks[0].type === 'header', 'First block is header');
assert(responseBlocks.some(b => b.type === 'divider'), 'Contains dividers');
assert(responseBlocks.some(b => b.type === 'actions'), 'Contains action buttons');
assert(responseBlocks.some(b => b.type === 'context'), 'Contains confidence context block');

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

// Follow-up blocks
const followUpBlocks = buildFollowUpBlocks('Try re-enabling the Zapier connection and reconnecting.');
assert(Array.isArray(followUpBlocks), 'buildFollowUpBlocks returns array');
assert(followUpBlocks.length >= 2, 'buildFollowUpBlocks has at least 2 blocks');
const fuContext = followUpBlocks.find(b => b.type === 'context');
assert(fuContext !== undefined, 'buildFollowUpBlocks has context block');
assert(fuContext.elements[0].text.includes('Follow-up'), 'context block labels this as a follow-up');
const fuSection = followUpBlocks.find(b => b.type === 'section');
assert(fuSection !== undefined, 'buildFollowUpBlocks has section block');
assert(fuSection.text.text === 'Try re-enabling the Zapier connection and reconnecting.', 'section block contains reply text');
assert(fuSection.text.type === 'mrkdwn', 'section block uses mrkdwn for markdown rendering');

// intro_message rendering
const withIntro = buildResponseBlocks({ ...sampleJson, intro_message: 'Hey Sarah, this needs escalation.' });
assert(withIntro[0].text.text === 'Hey Sarah, this needs escalation.', 'intro_message renders as first block');

// escalate_decision rendering (CSA)
const withEscalate = buildResponseBlocks({
  ...sampleJson,
  intro_message: 'Hey Sarah.',
  escalate_decision: {
    should_escalate: true,
    reason: 'Requires backend access',
    escalation_path: 'Live Assist → Integrations Specialist',
  },
});
const escalateBlock = withEscalate.find(b => b.text?.text?.includes('escalate'));
assert(escalateBlock !== undefined, 'Escalate decision block rendered for CSA');

// No escalate_decision block for specialist (no escalate_decision field)
const specialistBlocks = buildResponseBlocks({ ...sampleJson, intro_message: 'Hey Mike.' });
const noEscalate = specialistBlocks.find(b => b.text?.text?.includes('Escalate') && b.text?.text?.includes('reason'));
assert(noEscalate === undefined, 'No escalate decision block when field absent');

// Show Specialist Detail button only when show_specialist_detail_value is present
const csaBlocks = buildResponseBlocks({
  ...sampleJson,
  intro_message: 'Hey Sarah.',
  escalate_decision: { should_escalate: false, reason: 'CSA can handle' },
  _showSpecialistValue: JSON.stringify({ threadTs: '123', channelId: 'C123', query: 'test' }),
});
const specialistBtn = csaBlocks.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'show_specialist_detail');
assert(specialistBtn !== undefined, 'Show Specialist Detail button present when _showSpecialistValue set');

const noSpecialistBtn = buildResponseBlocks({ ...sampleJson, intro_message: 'Hey Mike.' });
const noBtn = noSpecialistBtn.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'show_specialist_detail');
assert(noBtn === undefined, 'Show Specialist Detail button absent when _showSpecialistValue not set');

// channel_recommendation rendering
const withKsChannel = buildResponseBlocks({
  ...sampleJson,
  channel_recommendation: { channel: 'ks-integration', reason: 'Quick sanity check — no company-wide visibility needed.' },
});
const ksBlock = withKsChannel.find(b => b.text?.text?.includes('ks-integration') && b.text?.text?.includes('Quick sanity check'));
assert(ksBlock !== undefined, 'channel_recommendation renders ks-integration block');
assert(ksBlock && ksBlock.text.text.includes('Quick sanity check'), 'ks-integration block includes reason');

const withAskChannel = buildResponseBlocks({
  ...sampleJson,
  channel_recommendation: { channel: 'ask-integrations', reason: 'Complex issue worth the whole team seeing.' },
});
const askBlock = withAskChannel.find(b => b.text?.text?.includes('ask-integrations') && b.text?.text?.includes('Complex issue worth the whole team seeing'));
assert(askBlock !== undefined, 'channel_recommendation renders ask-integrations block');

const noChannelRec = buildResponseBlocks({ ...sampleJson });
const noChannelBlock = noChannelRec.find(b => b.text?.text?.includes('Post this in'));
assert(noChannelBlock === undefined, 'No channel recommendation block when field absent');

// confidence badge rendering
const highConfBlocks = buildResponseBlocks({ ...sampleJson, confidence: 'high' });
const highHeader = highConfBlocks.find(b => b.type === 'header');
assert(highHeader?.text?.text?.startsWith('🟢'), 'High confidence shows 🟢 in header');

const medConfBlocks = buildResponseBlocks({ ...sampleJson, confidence: 'medium' });
const medHeader = medConfBlocks.find(b => b.type === 'header');
assert(medHeader?.text?.text?.startsWith('🟡'), 'Medium confidence shows 🟡 in header');

const lowConfBlocks = buildResponseBlocks({ ...sampleJson, confidence: 'low' });
const lowHeader = lowConfBlocks.find(b => b.type === 'header');
assert(lowHeader?.text?.text?.startsWith('🔴'), 'Low confidence shows 🔴 in header');

// Confidence context block — shows level, sources, and guidance note
const highConfContext = highConfBlocks.find(b => b.type === 'context');
assert(highConfContext !== undefined, 'High confidence: context block present');
assert(highConfContext.elements[0].text.includes('🟢'), 'High confidence: green icon in context');
assert(highConfContext.elements[0].text.includes('High'), 'High confidence: label in context');
assert(highConfContext.elements[0].text.includes('slack'), 'Confidence context includes sources');

const lowConfContext = lowConfBlocks.find(b => b.type === 'context');
assert(lowConfContext !== undefined, 'Low confidence: context block present');
assert(lowConfContext.elements[0].text.includes('🔴'), 'Low confidence: red icon in context');
assert(lowConfContext.elements[0].text.includes('Low'), 'Low confidence: label in context');

// Bottom Line renders for all confidence levels
const lowBottomLine = lowConfBlocks.find(b => b.text?.text?.includes('Bottom Line'));
assert(lowBottomLine !== undefined, 'Low confidence: Bottom Line section still renders');
const highBottomLine = highConfBlocks.find(b => b.text?.text?.includes('Bottom Line'));
assert(highBottomLine !== undefined, 'High confidence: Bottom Line section renders');

// Bottom Line contains diagnosis (bold), actions (bullets), guidance (italic)
const bottomLineBlock = highBottomLine;
assert(bottomLineBlock?.text?.text?.includes('*The Zapier integration is failing'), 'Bottom Line diagnosis is bold');
assert(bottomLineBlock?.text?.text?.includes('• Enable Zapier API access'), 'Bottom Line contains action bullet');
assert(bottomLineBlock?.text?.text?.includes('_If re-auth still fails'), 'Bottom Line guidance is italic');

// No quoted email body anywhere
const noQuotedEmail = highConfBlocks.every(b => !b.text?.text?.startsWith('> '));
assert(noQuotedEmail, 'No quoted email body in any block');

// Wrong Answer button still present
const highActions = highConfBlocks.find(b => b.type === 'actions');
assert(highActions !== undefined, 'Action buttons still rendered');
const highWrongBtn = highActions?.elements?.find(e => e.action_id === 'wrong_answer_modal');
assert(highWrongBtn !== undefined, 'Wrong Answer button present');

// No Copy Email button
const noCopyEmail = highConfBlocks.every(b =>
  b.type !== 'actions' || !b.elements?.some(e => e.action_id === 'copy_email_modal')
);
assert(noCopyEmail, 'No Copy Email button in any actions block');

// unknown/missing confidence defaults to medium badge (no crash)
const noConfBlocks = buildResponseBlocks({ ...sampleJson, confidence: undefined });
assert(noConfBlocks.length > 0, 'Missing confidence field does not crash');

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

// Missing findings_summary
const noSummary = buildResponseBlocks({ ...sampleJson, findings_summary: undefined });
assert(noSummary.length > 0, 'Handles missing findings_summary without crashing');

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
assert(wrongBtn?.value?.length <= 2000, `wrong_answer_modal value within 2000 chars (got ${wrongBtn?.value?.length})`);

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

// ── 9. Role Detection ────────────────────────────────────────────────────────
console.log('\n🔹 Role Detection');

// Helper — mirrors the detection logic in mention.js
function detectRole(title) {
  if (!title) return 'csa';
  if (/Customer Support Advocate/i.test(title)) return 'csa';
  if (/Specialist/i.test(title) && /Integrat/i.test(title)) return 'specialist';
  return 'csa';
}

assert(detectRole('Customer Support Advocate I') === 'csa', 'CSA I detected');
assert(detectRole('Customer Support Advocate II') === 'csa', 'CSA II detected');
assert(detectRole('Senior Customer Support Advocate') === 'csa', 'Senior CSA detected');
assert(detectRole('Associate Integrations Specialist') === 'specialist', 'Associate Specialist detected');
assert(detectRole('Integrations Specialist') === 'specialist', 'Integrations Specialist detected');
assert(detectRole('Specialist, Integrations') === 'specialist', 'Specialist, Integrations detected');
assert(detectRole('Senior Specialist Integrations') === 'specialist', 'Senior Specialist detected');
assert(detectRole('Account Manager') === 'csa', 'Unknown role defaults to CSA');
assert(detectRole(null) === 'csa', 'Null title defaults to CSA');
assert(detectRole('') === 'csa', 'Empty title defaults to CSA');

// ── Feedback Moderation ───────────────────────────────────────────────────
console.log('\n🔹 Feedback Moderation');

// saveFeedback should write to pending, NOT active
const testRecord = await saveFeedback({
  query: 'zapier test query for moderation',
  issueTitle: 'Zapier API Access',
  integrationType: 'Zapier',
  feedbackType: 'wrong_answer',
  correction: 'The real fix is X',
  agentId: 'U12345',
  agentName: 'Test Agent',
});

const pending = await getPendingFeedback();
assert(Array.isArray(pending), 'getPendingFeedback returns array');
assert(pending.some(e => e.id === testRecord.id), 'New feedback is in pending queue');

// Schema check — pending entry must have reviewMessageTs and reviewChannelId
const pendingEntry = pending.find(e => e.id === testRecord.id);
assert(pendingEntry.reviewMessageTs === null, 'New pending entry has null reviewMessageTs');
assert('reviewChannelId' in pendingEntry, 'New pending entry has reviewChannelId field');

// Should NOT be in active feedback.json yet
const activeBefore = await getAllFeedback();
assert(!activeBefore.some(e => e.id === testRecord.id), 'New feedback NOT in active queue before approval');

// Approve it
await approveFeedback(testRecord.id);
const activeAfter = await getAllFeedback();
assert(activeAfter.some(e => e.id === testRecord.id), 'Feedback in active queue after approval');

const pendingAfter = await getPendingFeedback();
assert(!pendingAfter.some(e => e.id === testRecord.id), 'Feedback removed from pending after approval');

// Reject a second entry
const testRecord2 = await saveFeedback({
  query: 'angi test query for rejection',
  issueTitle: 'Angi Leads Issue',
  integrationType: 'Angi',
  feedbackType: 'outdated',
  correction: 'This is wrong info',
  agentId: 'U99999',
  agentName: 'Bad Actor',
});

await rejectFeedback(testRecord2.id);
const pendingAfterReject = await getPendingFeedback();
assert(!pendingAfterReject.some(e => e.id === testRecord2.id), 'Feedback removed from pending after rejection');

const activeAfterReject = await getRelevantFeedback('angi test query for rejection');
assert(!activeAfterReject.some(e => e.id === testRecord2.id), 'Rejected feedback NOT in active queue');

// Double-approve is idempotent — must NOT duplicate in active queue
await approveFeedback(testRecord.id); // already approved
const activeNoDup = await getAllFeedback();
const matchCount = activeNoDup.filter(e => e.id === testRecord.id).length;
assert(matchCount === 1, 'Double-approve does not duplicate entry in active queue');

assert(typeof approveFeedback === 'function', 'approveFeedback is a function');
assert(typeof rejectFeedback === 'function', 'rejectFeedback is a function');

// ── 10. Help Blocks ───────────────────────────────────────────────────────────
console.log('\n🔹 Help Blocks');

const helpBlocks = buildHelpBlocks();
assert(Array.isArray(helpBlocks), 'buildHelpBlocks returns array');
assert(helpBlocks.length > 0, 'buildHelpBlocks returns non-empty array');
assert(helpBlocks[0].type === 'header', 'buildHelpBlocks first block is header');
assert(helpBlocks[0].text.text.includes('IntegrationsBot'), 'help header mentions IntegrationsBot');
assert(helpBlocks.some(b => b.text?.text?.includes('Zapier')), 'help blocks mention Zapier');
assert(helpBlocks.some(b => b.text?.text?.includes('accounting')), 'help blocks mention accounting exclusion');
assert(helpBlocks.some(b => b.type === 'context'), 'help blocks have context footer');
assert(helpBlocks.every(b => b.type === 'header' || b.type === 'section' || b.type === 'context'), 'help blocks contain only valid block types');

const helpDetailBlocks = buildHelpDetailBlocks();
assert(Array.isArray(helpDetailBlocks), 'buildHelpDetailBlocks returns array');
assert(helpDetailBlocks.length > 0, 'buildHelpDetailBlocks returns non-empty array');
assert(helpDetailBlocks[0].type === 'header', 'buildHelpDetailBlocks first block is header');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('confidence')), 'detail blocks explain confidence levels');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('Wrong Answer')), 'detail blocks explain feedback');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('Specialist Detail')), 'detail blocks explain specialist button');
assert(helpDetailBlocks.some(b => b.text?.text?.includes('Thread continuation')), 'detail blocks explain thread mode');
assert(helpDetailBlocks.some(b => b.type === 'context'), 'detail blocks have context footer');

// ── 11. Sources Modal ─────────────────────────────────────────────────────────
console.log('\n🔹 Sources Modal');

// Modal with all three source types
const fullRefsModal = buildSourcesModal({
  slack_refs: [
    { url: 'https://slack.com/1', channel: '#ask-integrations', title: 'Zapier API not working' },
  ],
  atlassian_refs: [
    { type: 'confluence', url: 'https://atlassian.net/wiki/1', title: 'Zapier Setup Guide' },
    { type: 'jira', url: 'https://atlassian.net/browse/INT-1', title: 'INT-1 — Zapier auth failure' },
  ],
  kb_refs: [
    { url: 'https://help.servicetitan.com/zapier', title: 'Zapier Setup', snippet: 'Enable API access first.' },
  ],
});
assert(fullRefsModal.type === 'modal', 'buildSourcesModal returns modal type');
assert(typeof fullRefsModal.title === 'object', 'modal has title');
assert(Array.isArray(fullRefsModal.blocks), 'modal has blocks array');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('💬 Slack')), 'modal has Slack section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('📄 Atlassian')), 'modal has Atlassian section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('📚 Knowledge Base')), 'modal has KB section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('Zapier API not working')), 'slack ref title appears in modal');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('Zapier Setup Guide')), 'confluence ref title appears in modal');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('INT-1')), 'jira ref title appears in modal');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('Zapier Setup')), 'kb ref title appears in modal');

// Modal with only Slack refs — Atlassian and KB sections should not appear
const slackOnlyModal = buildSourcesModal({
  slack_refs: [{ url: 'https://slack.com/2', channel: '#ks-integration', title: 'Thread about Angi' }],
  atlassian_refs: [],
  kb_refs: [],
});
assert(!slackOnlyModal.blocks.some(b => b.text?.text?.includes('📄 Atlassian')), 'Atlassian section hidden when no atlassian_refs');
assert(!slackOnlyModal.blocks.some(b => b.text?.text?.includes('📚 Knowledge Base')), 'KB section hidden when no kb_refs');

// Modal with no refs — shows fallback message
const emptyRefsModal = buildSourcesModal({ slack_refs: [], atlassian_refs: [], kb_refs: [] });
assert(emptyRefsModal.blocks.some(b => b.text?.text?.includes('No specific sources')), 'empty refs modal shows fallback message');

// Missing arrays default gracefully (no crash)
const noArgsModal = buildSourcesModal({});
assert(noArgsModal.type === 'modal', 'buildSourcesModal handles missing arrays without crash');

// ── 12. Sources Button in buildResponseBlocks ─────────────────────────────────
console.log('\n🔹 Sources Button');

// Sources button appears when refs are present
const withRefsBlocks = buildResponseBlocks({
  ...sampleJson,
  slack_refs: [{ url: 'https://slack.com/1', channel: '#ask-integrations', title: 'Zapier thread' }],
  atlassian_refs: [],
  kb_refs: [],
});
const withRefsActions = withRefsBlocks.find(b => b.type === 'actions');
const sourcesBtn = withRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(sourcesBtn !== undefined, 'Sources button appears when refs present');
assert(sourcesBtn?.value?.length <= 2000, 'Sources button value within 2000 chars');

// Sources button hidden when all ref arrays are empty
const noRefsBlocks = buildResponseBlocks({
  ...sampleJson,
  slack_refs: [],
  atlassian_refs: [],
  kb_refs: [],
});
const noRefsActions = noRefsBlocks.find(b => b.type === 'actions');
const noSourcesBtn = noRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(noSourcesBtn === undefined, 'Sources button hidden when all ref arrays empty');

// Sources button hidden when ref fields are absent (legacy responses)
const legacyNoRefsBlocks = buildResponseBlocks({
  issue_title: 'Test',
  agent_steps: [],
  confidence: 'high',
  sources_used: [],
});
const legacyActions = legacyNoRefsBlocks.find(b => b.type === 'actions');
const legacySourcesBtn = legacyActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(legacySourcesBtn === undefined, 'Sources button hidden when ref fields absent');

// Button value is capped to fit within Slack's 2000-char limit (adaptive: up to 3 per type)
const manyRefsBlocks = buildResponseBlocks({
  ...sampleJson,
  slack_refs: Array.from({ length: 10 }, (_, i) => ({ url: `https://servicetitan.slack.com/archives/C0123456789/p${String(i).padStart(16, '0')}`, channel: '#ask-integrations', title: `Zapier API access not working after tenant migration — case ${i}` })),
  atlassian_refs: Array.from({ length: 10 }, (_, i) => ({ type: 'confluence', url: `https://servicetitan.atlassian.net/wiki/spaces/INT/pages/123456789${i}/Zapier-Integration-Setup-Guide`, title: `Zapier Integration Setup and Troubleshooting Guide for ServiceTitan v${i}` })),
  kb_refs: Array.from({ length: 10 }, (_, i) => ({ url: `https://help.servicetitan.com/hc/en-us/articles/36000000000${i}-Setting-Up-Zapier-Integration`, title: `Setting Up and Configuring the Zapier Integration with ServiceTitan`, snippet: `To enable Zapier API access, navigate to your ServiceTitan admin portal and find the tenant settings under Integrations tab. Enable Zapier API access for tenant ${i}.` })),
});
const manyRefsActions = manyRefsBlocks.find(b => b.type === 'actions');
const manySourcesBtn = manyRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(manySourcesBtn !== undefined, 'Sources button present with many refs');
const parsedValue = JSON.parse(manySourcesBtn.value);
assert(parsedValue.slack_refs.length >= 1 && parsedValue.slack_refs.length <= 3, 'slack_refs capped to 1–3 entries in button value');
assert(parsedValue.atlassian_refs.length >= 1 && parsedValue.atlassian_refs.length <= 3, 'atlassian_refs capped to 1–3 entries in button value');
assert(parsedValue.kb_refs.length >= 1 && parsedValue.kb_refs.length <= 3, 'kb_refs capped to 1–3 entries in button value');
assert(manySourcesBtn.value.length <= 2000, 'Button value within Slack 2000-char limit');

// ── 13. KB Search ─────────────────────────────────────────────────────────────
console.log('\n🔹 KB Search');

// Exported function exists and is async
assert(typeof searchKnowledgeBase === 'function', 'searchKnowledgeBase is a function');
assert(searchKnowledgeBase.constructor.name === 'AsyncFunction', 'searchKnowledgeBase is async');

// Returns null when GOOGLE_CSE_API_KEY is not set (will not be set in CI)
const kbResult = await searchKnowledgeBase('zapier api access not working');
assert(kbResult === null, 'searchKnowledgeBase returns null when env vars not set');

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
