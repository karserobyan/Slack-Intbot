/**
 * Local functionality test — exercises all core modules without
 * requiring Slack or Anthropic API connections.
 */

import { isAccountingTopic } from './src/utils/accounting-filter.js';
import {
  buildResponseBlocks,
  buildWelcomeCard,
  buildSessionCard,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildSourcesModal,
  buildChatResolutionBlocks,
  buildProgressBlocks,
} from './src/slack/blocks.js';
import { getCached, setCached, cacheStats, pruneExpired, deleteCache } from './src/slack/cache.js';
import { getHistory, appendToHistory, hasHistory, pruneConversations } from './src/slack/conversation.js';
import { parseClaudeResponse, summarizeResultForHistory } from './src/claude/prompts.js';
import { parseChatResponse } from './src/claude/query.js';
import { getRelevantFeedback, getAllFeedback, saveFeedback, approveFeedback, rejectFeedback, getPendingFeedback } from './src/slack/feedback.js';
import { searchKnowledgeBase } from './src/claude/kb-search.js';
import { buildNominationBlocks, nominateResponse, rejectNomination, _setStoreForTest } from './src/slack/nominations.js';
import {
  getModeratorIds,
  isAuthorizedModerator,
  requireAuthorizedModerator,
  sendUnauthorizedResponse,
} from './src/slack/moderation.js';
import {
  handleFeedbackReviewAction,
  handleNominationReviewAction,
} from './src/slack/review-actions.js';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { buildChannelPostModal } from './src/slack/modal.js';
import {
  appendKbArticle,
  appendBotResponse,
  hasKbUrl,
  hasIssueTitle,
} from './src/slack/knowledge-writer.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNewPipelineEnabled } from './src/utils/feature-flags.js';
import { searchSlackMessages } from './src/slack/search-client.js';
import { executeSearchPlan } from './src/claude/search-executor.js';
import { runAnswerer } from './src/claude/answerer.js';

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
  confidence: 'high',
  customer_message: 'Hi [Name], I can see exactly what happened — your Zapier connection was reset during our recent migration on our end. I\'m re-enabling it right now, and you\'ll just need to reconnect Zapier after. Give me one moment.',
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
  customer_message: 'Hey Dave, quick heads up on this one.',
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
  customer_message: 'Hey Lee, checking this now.',
  agent_steps: [],
  confidence: 'low',
  sources_used: ['slack'],
};
const noEmailSummary = summarizeResultForHistory(noEmailResult);
assert(!noEmailSummary.includes('Customer email drafted'), 'no email line when customer_email absent');

// clarifying_question included in summary when present
const resultWithQuestion = {
  customer_message: 'Hey Sarah, I\'m looking into this right now.',
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
  customer_message: 'Hey Mike, on it.',
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
const infoLine = responseBlocks.find(b => b.type === 'context');
assert(infoLine !== undefined, 'Compact info line is a context block');
assert(infoLine.elements[0].text.includes('High'), 'Info line: confidence label present (Specialist mode)');
assert(infoLine.elements[0].text.includes('Sources:'), 'Info line: sources label present (Specialist mode)');
assert(infoLine.elements[0].text.includes('🟢'), 'Info line: confidence icon present');

// CSA info line — escalate_decision present
const csaHandleBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'high',
  escalate_decision: { should_escalate: false, reason: 'CSA can handle with single backend enable' },
  channel_recommendation: { channel: 'ks-integration', reason: 'CSA can handle with single backend enable' },
});
const csaInfoLine = csaHandleBlocks.find(b => b.type === 'context');
assert(csaInfoLine.elements[0].text.includes('✅'), 'Info line: ✅ signal for CSA handle yourself');
assert(csaInfoLine.elements[0].text.includes('Handle yourself'), 'Info line: handle yourself text');
assert(csaInfoLine.elements[0].text.includes('CSA can handle'), 'Info line: routing reason present');

// Check header contains issue title
const headerText = responseBlocks[0].text.text;
assert(headerText.includes('Zapier API Access Not Enabled'), 'Header has issue title');

// Check steps are present
const stepBlocks = responseBlocks.filter(b => b.type === 'section' && /\*\d+\. /.test(b.text?.text ?? ''));
assert(stepBlocks.length === 4, `All 4 agent steps rendered (found ${stepBlocks.length})`);

// Check tags render
assert(stepBlocks[0].text.text.includes('`action`'), 'Step 1 has action tag');
assert(stepBlocks[1].text.text.includes('`backend`'), 'Step 2 has backend tag');
assert(stepBlocks[0].text.text.startsWith('🔵'), 'Action step has blue circle');
assert(stepBlocks[1].text.text.startsWith('🟠'), 'Backend step has orange circle');
assert(stepBlocks[2].text.text.startsWith('🟢'), 'Verify step has green circle');
assert(stepBlocks[3].text.text.startsWith('🔴'), 'Escalate step has red circle');

// Diagnosis no longer inline — moved to modal
const noDiagBlock = responseBlocks.every(b => !b.text?.text?.includes('🔍 Root Cause'));
assert(noDiagBlock, 'Diagnosis block is not inline in response (moved to modal)');

// Customer message — label removed, just the message
const talktackBlock = responseBlocks.find(b => b.text?.text?.includes('Zapier connection was reset'));
assert(talktackBlock !== undefined, 'Customer message block present');
assert(!talktackBlock.text.text.includes('Message the customer'), 'Customer message has no label text');
assert(talktackBlock.text.text.startsWith('💬'), 'Customer message starts with 💬 emoji');

// Steps header
const stepsHeader = responseBlocks.find(b => b.text?.text === '*🔧 What you do*');
assert(stepsHeader !== undefined, 'Steps section header renders as "🔧 What you do"');

// ── Routing signal scenarios ─────────────────────────────────────────────────

// Handle yourself — no escalation, high confidence
const handleYourselfBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'high',
  escalate_decision: { should_escalate: false, reason: 'CSA can handle this' },
  channel_recommendation: { channel: 'ks-integration', reason: 'CSA can handle this' },
});
const handleBlock = handleYourselfBlocks.find(b => b.type === 'context');
assert(handleBlock !== undefined, 'Routing signal: handle yourself renders ✅');
assert(handleBlock.elements[0].text.includes('✅'), 'Routing signal: handle yourself has ✅ signal');
assert(handleBlock.elements[0].text.includes('Handle yourself'), 'Routing signal: handle yourself text correct');

// Post in channel — should_escalate: true
const escalateRoutingBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'high',
  escalate_decision: { should_escalate: true, reason: 'Needs backend access' },
  channel_recommendation: { channel: 'ask-integrations', reason: 'Team visibility needed' },
  suggested_channel_post: 'Anyone seen Zapier failing after migration for this tenant?',
});
const postBlock = escalateRoutingBlocks.find(b => b.type === 'context');
assert(postBlock !== undefined, 'Routing signal: post in channel renders 📢');
assert(postBlock.elements[0].text.includes('📢'), 'Routing signal: post in channel has 📢 signal');
assert(postBlock.elements[0].text.includes('ask-integrations'), 'Routing signal: post in channel includes channel name');

// Post to verify — low confidence
const lowConfRoutingBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'low',
  escalate_decision: { should_escalate: false, reason: 'Worth verifying with team' },
  channel_recommendation: { channel: 'ks-integration', reason: 'Worth verifying with team' },
  suggested_channel_post: 'Uncertain about this one — anyone confirm?',
});
const lowVerifyBlock = lowConfRoutingBlocks.find(b => b.type === 'context');
assert(lowVerifyBlock !== undefined, 'Routing signal: post to verify renders 🔎 for low confidence');
assert(lowVerifyBlock.elements[0].text.includes('🔎'), 'Routing signal: post to verify has 🔎 signal');
assert(lowVerifyBlock.elements[0].text.includes('Post to verify'), 'Routing signal: post to verify text correct');

// Post to verify — medium confidence
const medConfRoutingBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'medium',
  escalate_decision: { should_escalate: false, reason: 'Partial match only' },
  channel_recommendation: { channel: 'ks-integration', reason: 'Partial match only' },
});
const medVerifyBlock = medConfRoutingBlocks.find(b => b.type === 'context');
assert(medVerifyBlock !== undefined, 'Routing signal: post to verify renders 🔎 for medium confidence');
assert(medVerifyBlock.elements[0].text.includes('🔎'), 'Routing signal: post to verify has 🔎 signal for medium');

// No routing signal when escalate_decision absent (Specialist)
const noRoutingBlocks = buildResponseBlocks({ ...sampleJson });
const noRouting = noRoutingBlocks.find(b =>
  ['✅', '📢', '🔎'].some(s => {
    const elemText = b.elements?.[0]?.text;
    return b.text?.text?.includes(s) || (typeof elemText === 'string' && elemText.includes(s));
  })
);
assert(noRouting === undefined, 'Routing signal: absent when no escalate_decision (Specialist mode)');

// should_escalate wins over low confidence (escalation more urgent)
const escalatePlusLowBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'low',
  escalate_decision: { should_escalate: true, reason: 'Escalation needed' },
  channel_recommendation: { channel: 'ask-integrations', reason: 'Team needed' },
});
const escalatePlusLowBlock = escalatePlusLowBlocks.find(b => b.type === 'context');
assert(escalatePlusLowBlock !== undefined, 'Routing signal: should_escalate wins over low confidence');
assert(escalatePlusLowBlock.elements[0].text.includes('📢'), 'Routing signal: 📢 shown when should_escalate true');

// ── Sensitivity filtering ────────────────────────────────────────────────────
const sensitiveData = {
  ...sampleJson,
  slack_refs: [
    { url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#escalations', title: 'Internal escalation notes', sensitive: true },
    { url: 'https://servicetitan.slack.com/archives/C2/p2', channel: '#integrations', title: 'Public Zapier thread' },
  ],
  atlassian_refs: [
    { type: 'confluence', url: 'https://wiki/internal', title: 'Internal runbook', sensitive: true },
    { type: 'confluence', url: 'https://wiki/public', title: 'Public Zapier guide' },
  ],
  kb_refs: [{ url: 'https://help.servicetitan.com/zapier', title: 'Zapier Setup', snippet: 'Enable API access...' }],
  findings_summary: { diagnosis: 'Zapier API access not enabled.' },
};

// CSA: sensitive refs hidden, public refs visible, hint shown
const csaSensBlocks = buildResponseBlocks(sensitiveData, { role: 'csa' });
const csaChipBlock = csaSensBlocks.find(b => b.type === 'context' && b.elements[0].text.includes('💬'));
assert(csaChipBlock !== undefined, 'sensitivity CSA: public Slack chip shown');
assert(csaChipBlock.elements[0].text.includes('📄 Confluence'), 'sensitivity CSA: public Confluence chip shown');
assert(csaChipBlock.elements[0].text.includes('_+2 specialist-only_'), 'sensitivity CSA: specialist-only hint shown');
const csaSrcBtn = csaSensBlocks.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(csaSrcBtn !== undefined, 'sensitivity CSA: sources button present for visible refs');
const csaSrcVal = JSON.parse(csaSrcBtn.value);
assert(csaSrcVal.slack_refs.length === 1, 'sensitivity CSA: sources button only contains non-sensitive Slack ref');
assert(csaSrcVal.atlassian_refs.length === 1, 'sensitivity CSA: sources button only contains non-sensitive Atlassian ref');
assert(csaSrcVal.slack_refs[0].title === 'Public Zapier thread', 'sensitivity CSA: correct Slack ref in button');

// Specialist: all refs visible, no hint
const specSensBlocks = buildResponseBlocks(sensitiveData, { role: 'specialist' });
const specChipBlock = specSensBlocks.find(b => b.type === 'context' && b.elements[0].text.includes('💬'));
assert(specChipBlock !== undefined, 'sensitivity Specialist: Slack chip shown');
assert(!specChipBlock.elements[0].text.includes('specialist-only'), 'sensitivity Specialist: no specialist-only hint');
const specSrcBtn = specSensBlocks.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'view_sources_modal');
const specSrcVal = JSON.parse(specSrcBtn.value);
assert(specSrcVal.slack_refs.length === 2, 'sensitivity Specialist: sources button contains all Slack refs');
assert(specSrcVal.atlassian_refs.length === 2, 'sensitivity Specialist: sources button contains all Atlassian refs');

// No visible refs for CSA when all are sensitive — sources button absent
const allSensitiveData = {
  ...sampleJson,
  slack_refs: [{ url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#esc', title: 'Internal', sensitive: true }],
  atlassian_refs: [],
  kb_refs: [],
};
const csaAllSensBlocks = buildResponseBlocks(allSensitiveData, { role: 'csa' });
const csaAllSensSrcBtn = csaAllSensBlocks.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(csaAllSensSrcBtn === undefined, 'sensitivity CSA: sources button absent when all refs are sensitive');
const csaAllSensChip = csaAllSensBlocks.find(b => b.type === 'context' && b.elements[0].text.includes('specialist-only'));
assert(csaAllSensChip !== undefined, 'sensitivity CSA: specialist-only hint still shown when all refs sensitive');

// Accounting redirect
const redirectBlocks = buildAccountingRedirectBlocks('How do I set up QuickBooks?');
assert(redirectBlocks.length === 2, 'Redirect has 2 blocks');
assert(redirectBlocks[0].text.text.includes('#ask-partner-enabled-accounting-integrations'), 'Redirect mentions correct channel');

// Thinking blocks
const thinkingBlocks = buildThinkingBlocks('Zapier not working');
assert(thinkingBlocks.length === 2, 'Thinking has 2 blocks');
assert(thinkingBlocks[0].text.text.includes('Looking into this'), 'Thinking shows looking-into-this message');

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

// Show Specialist Detail button only when _showSpecialistValue is present
const csaBlocksWithSpecBtn = buildResponseBlocks({
  ...sampleJson,
  _showSpecialistValue: JSON.stringify({ threadTs: '123', channelId: 'C123', query: 'test' }),
});
const specialistBtn = csaBlocksWithSpecBtn.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'show_specialist_detail');
assert(specialistBtn !== undefined, 'Show Specialist Detail button present when _showSpecialistValue set');

const noSpecialistBtn = buildResponseBlocks({ ...sampleJson });
const noBtn = noSpecialistBtn.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'show_specialist_detail');
assert(noBtn === undefined, 'Show Specialist Detail button absent when _showSpecialistValue not set');

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

// isDm: true appends New chat button; isDm: false (default) does not
const isDmBlocks = buildResponseBlocks(sampleJson, { isDm: true });
const dmActions = isDmBlocks.find(b => b.type === 'actions');
assert(dmActions !== undefined, 'isDm response has actions block');
assert(dmActions.elements.some(e => e.action_id === 'new_chat'), 'isDm: true appends new_chat button');
assert(dmActions.elements.at(-1).text.text === '💬 New chat', 'New chat button is last in actions');

const nonDmActions = responseBlocks.find(b => b.type === 'actions');
assert(!nonDmActions.elements.some(e => e.action_id === 'new_chat'), 'isDm: false (default) has no new_chat button');

// ── 3b. Welcome Card & Session Card ──────────────────────────────────────────
console.log('\n🔹 Welcome Card & Session Card');

const welcomeBlocks = buildWelcomeCard();
assert(Array.isArray(welcomeBlocks), 'buildWelcomeCard returns array');
assert(welcomeBlocks.some(b => b.type === 'actions'), 'welcome card has actions block');
const welcomeActions = welcomeBlocks.find(b => b.type === 'actions');
assert(welcomeActions.elements[0].action_id === 'new_chat', 'welcome card button action_id is new_chat');
assert(welcomeActions.elements[0].text.text === '💬 New chat', 'welcome card button text is 💬 New chat');
assert(welcomeActions.elements[0].style === 'primary', 'welcome card button style is primary');
assert(welcomeBlocks.some(b => b.text?.text?.includes('Welcome to IntBot')), 'welcome card contains welcome text');

const sessionBlocks = buildSessionCard();
assert(Array.isArray(sessionBlocks), 'buildSessionCard returns array');
assert(sessionBlocks.some(b => b.text?.text?.includes('🟢 Integration chat')), 'session card has 🟢 Integration chat text');
assert(sessionBlocks.some(b => b.type === 'actions'), 'session card has actions block');
const sessionActions = sessionBlocks.find(b => b.type === 'actions');
assert(sessionActions.elements[0].action_id === 'start_chat_thread', 'session card button action_id is start_chat_thread');
assert(sessionActions.elements[0].text.text === '💬 Ask an integration question', 'session card button text correct');

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
  diagnosis: 'Zapier cannot authenticate because API access was never enabled on this tenant.',
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
assert(fullRefsModal.title.text === '🔍 Diagnosis & Sources', 'modal title updated');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('🔍 Root Cause')), 'modal has diagnosis Root Cause section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('API access was never enabled')), 'modal diagnosis text present');
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

// Diagnosis-only modal (no refs) — fallback does NOT fire; Root Cause section is shown
const diagnosisOnlyModal = buildSourcesModal({ diagnosis: 'Root cause text here' });
assert(diagnosisOnlyModal.blocks.some(b => b.text?.text?.includes('🔍 Root Cause')), 'diagnosis-only modal shows Root Cause section');
assert(!diagnosisOnlyModal.blocks.some(b => b.text?.text?.includes('No specific sources')), 'diagnosis-only modal does not show fallback message');

// Confirm no Root Cause section when diagnosis is omitted
assert(!slackOnlyModal.blocks.some(b => b.text?.text?.includes('🔍 Root Cause')), 'no Root Cause section when diagnosis omitted');

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
assert(sourcesBtn?.text?.text === '🔍 Diagnosis + Sources', 'Sources button text updated');
const parsedSrcBtnValue = JSON.parse(sourcesBtn.value);
assert('diagnosis' in parsedSrcBtnValue, 'Sources button value contains diagnosis field');
assert(parsedSrcBtnValue.diagnosis !== null, 'Sources button value has non-null diagnosis when findings_summary present');

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

// Returns null when ANTHROPIC_API_KEY is not set (will not be set in CI)
const _savedKbApiKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const kbResult = await searchKnowledgeBase('zapier api access not working');
assert(kbResult === null, 'searchKnowledgeBase returns null when env vars not set');
if (_savedKbApiKey) process.env.ANTHROPIC_API_KEY = _savedKbApiKey;

// ── 14. Knowledge Writer ─────────────────────────────────────────────────────
console.log('\n🔹 Knowledge Writer');

const TEST_KB = join(process.cwd(), 'data', '__test-knowledge.md');
try { await writeFile(TEST_KB, '', 'utf-8'); } catch { /* ok */ }

assert(await hasKbUrl('https://help.servicetitan.com/zapier', TEST_KB) === false, 'hasKbUrl returns false on empty file');

await appendKbArticle('Zapier', 'https://help.servicetitan.com/zapier-setup', 'Setting Up Zapier', 'Enable API access first.', TEST_KB);
const kb1 = await readFile(TEST_KB, 'utf-8');
assert(kb1.includes('## Zapier'), 'appendKbArticle creates integration section');
assert(kb1.includes('[kb,'), 'appendKbArticle writes [kb, ...] tag');
assert(kb1.includes('https://help.servicetitan.com/zapier-setup'), 'appendKbArticle writes URL');
assert(kb1.includes('Setting Up Zapier'), 'appendKbArticle writes title');
assert(kb1.includes('Enable API access first.'), 'appendKbArticle writes snippet');

assert(await hasKbUrl('https://help.servicetitan.com/zapier-setup', TEST_KB) === true, 'hasKbUrl returns true after write');

await appendKbArticle('Zapier', 'https://help.servicetitan.com/zapier-setup', 'Setting Up Zapier Again', 'Different snippet.', TEST_KB);
const kb2 = await readFile(TEST_KB, 'utf-8');
assert((kb2.match(/zapier-setup/g) ?? []).length === 1, 'appendKbArticle deduplicates by URL');

await appendBotResponse('Zapier', 'API access resets after migration', ['Re-enable via ST backend', 'Verify in admin panel'], ['Slack #ask-integrations'], TEST_KB);
const kb3 = await readFile(TEST_KB, 'utf-8');
assert(kb3.includes('[auto,'), 'appendBotResponse writes [auto, ...] tag');
assert(kb3.includes('API access resets after migration'), 'appendBotResponse writes issue title');
assert(kb3.includes('Re-enable via ST backend'), 'appendBotResponse includes steps');

assert(await hasIssueTitle('Zapier', 'API access resets after migration', TEST_KB) === true, 'hasIssueTitle returns true after write');

await appendBotResponse('Zapier', 'API access resets after migration', ['Different step'], [], TEST_KB);
const kb4 = await readFile(TEST_KB, 'utf-8');
assert((kb4.match(/API access resets after migration/g) ?? []).length === 1, 'appendBotResponse deduplicates by issue title within section');

await appendKbArticle('Angi', 'https://help.servicetitan.com/angi-setup', 'Angi Leads Setup', 'Check booking provider IDs.', TEST_KB);
const kb5 = await readFile(TEST_KB, 'utf-8');
assert(kb5.includes('## Angi'), 'appendKbArticle creates new section for unknown integration');
assert(kb5.includes('## Zapier'), 'appendKbArticle preserves existing sections');

try { await writeFile(TEST_KB, '', 'utf-8'); } catch { /* ok */ }

// ── 15. Nominations ──────────────────────────────────────────────────────────
console.log('\n🔹 Nominations');

const nomRecord = {
  id: 'nom_test_001',
  timestamp: '2026-04-22T10:00:00.000Z',
  integration: 'Zapier',
  issueTitle: 'API access resets after tenant migration',
  steps: ['Re-enable via ST backend admin panel', 'Verify in admin portal'],
  refs: ['Slack #ask-integrations', 'Confluence Zapier guide'],
  proposedEntry: '- [auto, 2026-04-22] API access resets after tenant migration: Re-enable via ST backend admin panel; Verify in admin portal. Confirmed in Slack #ask-integrations + Confluence Zapier guide.',
};

const nomBlocks = buildNominationBlocks(nomRecord);

assert(Array.isArray(nomBlocks), 'buildNominationBlocks returns array');
assert(nomBlocks.length > 0, 'buildNominationBlocks returns non-empty array');

const hasTitle = nomBlocks.some(b =>
  (b.type === 'header' || b.type === 'section') && b.text?.text?.includes('Zapier')
);
assert(hasTitle, 'buildNominationBlocks includes integration name');

const hasEntry = nomBlocks.some(b => b.text?.text?.includes('API access resets after tenant migration'));
assert(hasEntry, 'buildNominationBlocks shows proposed entry text');

const nomActionsBlock = nomBlocks.find(b => b.type === 'actions');
assert(nomActionsBlock !== undefined, 'buildNominationBlocks has actions block');

const approveBtn = nomActionsBlock?.elements?.find(e => e.action_id === 'approve_nomination');
assert(approveBtn !== undefined, 'buildNominationBlocks has approve_nomination button');
assert(approveBtn?.style === 'primary', 'approve_nomination button has primary style');

const rejectBtn = nomActionsBlock?.elements?.find(e => e.action_id === 'reject_nomination');
assert(rejectBtn !== undefined, 'buildNominationBlocks has reject_nomination button');
assert(rejectBtn?.style === 'danger', 'reject_nomination button has danger style');

const approvePayload = JSON.parse(approveBtn.value);
assert(approvePayload.nominationId === 'nom_test_001', 'approve button value encodes nominationId');
const rejectPayload = JSON.parse(rejectBtn.value);
assert(rejectPayload.nominationId === 'nom_test_001', 'reject button value encodes nominationId');

const nomContextBlock = nomBlocks.find(b => b.type === 'context');
assert(nomContextBlock !== undefined, 'buildNominationBlocks has context footer');
assert(nomContextBlock.elements[0].text.includes('nom_test_001'), 'context footer includes nomination ID');

// — persistence: pending nominations survive a restart —
const nomTmp = join(tmpdir(), `noms-test-${Date.now()}.json`);
_setStoreForTest(nomTmp);
process.env.FEEDBACK_REVIEW_CHANNEL_ID = 'C_REVIEW';
const mockNomClient = { chat: { postMessage: async () => ({ ts: '111.222' }), update: async () => ({}) } };

const persistedNom = await nominateResponse(mockNomClient, {
  integration: 'Zapier', issueTitle: 'API access never enabled', steps: ['Enable API access'], refs: ['slack'],
});
assert(persistedNom && persistedNom.id, 'nominateResponse returns a nomination with an id');

// Simulate a restart/redeploy: drop the in-memory map, reload from the same file.
_setStoreForTest(nomTmp);
const survived = await rejectNomination(persistedNom.id, mockNomClient, 'Tester');
assert(survived && survived.id === persistedNom.id, 'pending nomination survives restart — found from disk after reload');

// And once handled, it's gone from disk (no double-processing on a later restart).
_setStoreForTest(nomTmp);
const goneAfter = await rejectNomination(persistedNom.id, mockNomClient, 'Tester');
assert(goneAfter === null, 'handled nomination is removed from disk — idempotent across restarts');

delete process.env.FEEDBACK_REVIEW_CHANNEL_ID;
await rm(nomTmp, { force: true });
_setStoreForTest(join(process.cwd(), 'data', 'nominations-pending.json')); // restore default store

// ── Moderation authorization ─────────────────────────────────────────────────
console.log('\n🔹 Moderation authorization');

const modEnv = { MODERATOR_USER_IDS: 'U1, U2 ,,U3' };
assert([...getModeratorIds(modEnv)].join(',') === 'U1,U2,U3', 'moderator IDs parse comma-separated env');
assert(isAuthorizedModerator('U2', modEnv) === true, 'configured moderator is authorized');
assert(isAuthorizedModerator('U4', modEnv) === false, 'unlisted user is not authorized');
assert(isAuthorizedModerator('U1', {}) === false, 'missing moderator list fails closed');

let unauthorizedThrown = false;
try { requireAuthorizedModerator('U4', modEnv); } catch (err) {
  unauthorizedThrown = err.code === 'not_authorized' && err.userId === 'U4';
}
assert(unauthorizedThrown, 'requireAuthorizedModerator throws tagged authorization error');

const denialCalls = [];
await sendUnauthorizedResponse({
  body: { user: { id: 'U4' }, channel: { id: 'C_REVIEW' } },
  client: { chat: { postEphemeral: async (payload) => { denialCalls.push(['ephemeral', payload]); } } },
  respond: async (payload) => { denialCalls.push(['respond', payload]); },
  logger: { warn: () => {} },
  actionName: 'approve_feedback',
});
assert(denialCalls.some(([kind]) => kind === 'respond'), 'unauthorized response prefers respond');
assert(JSON.stringify(denialCalls).includes('not authorized'), 'unauthorized response explains denial');

let approveFeedbackCalled = false;
const unauthorizedFeedbackResult = await handleFeedbackReviewAction({
  decision: 'approve',
  feedbackId: 'fb_1',
  body: { user: { id: 'U4', name: 'Nope' }, channel: { id: 'C_REVIEW' } },
  client: { chat: { postMessage: async () => ({}), update: async () => ({}) }, users: { info: async () => ({ user: { profile: {} } }) } },
  respond: async () => {},
  logger: { warn: () => {}, info: () => {} },
  env: modEnv,
  deps: {
    approveFeedback: async () => { approveFeedbackCalled = true; return null; },
    rejectFeedback: async () => { throw new Error('should not run'); },
  },
});
assert(unauthorizedFeedbackResult.status === 'unauthorized', 'unauthorized feedback action returns unauthorized');
assert(approveFeedbackCalled === false, 'unauthorized feedback approval does not mutate feedback');

let approveNominationCalled = false;
const unauthorizedNominationResult = await handleNominationReviewAction({
  decision: 'approve',
  nominationId: 'nom_1',
  body: { user: { id: 'U4', name: 'Nope' }, channel: { id: 'C_REVIEW' } },
  client: { chat: { update: async () => ({}) }, users: { info: async () => ({ user: { profile: {} } }) } },
  respond: async () => {},
  logger: { warn: () => {}, info: () => {} },
  env: modEnv,
  deps: {
    approveNomination: async () => { approveNominationCalled = true; return null; },
    rejectNomination: async () => { throw new Error('should not run'); },
  },
});
assert(unauthorizedNominationResult.status === 'unauthorized', 'unauthorized nomination action returns unauthorized');
assert(approveNominationCalled === false, 'unauthorized nomination approval does not mutate nominations');

// ── 16. parseChatResponse ─────────────────────────────────────────────────────
console.log('\n🔹 parseChatResponse');

// Valid diagnosing JSON
const diagnosingJson = '{"state":"diagnosing","acknowledgement":"Got it — that rules out auth.","question":"Has the customer tried reconnecting Zapier from scratch?"}';
const parsedDiag = parseChatResponse(diagnosingJson);
assert(parsedDiag.state === 'diagnosing', 'parseChatResponse: diagnosing state parsed');
assert(parsedDiag.acknowledgement === 'Got it — that rules out auth.', 'parseChatResponse: acknowledgement parsed');
assert(parsedDiag.question === 'Has the customer tried reconnecting Zapier from scratch?', 'parseChatResponse: question parsed');

// Valid resolved JSON (no escalation)
const resolvedJson = '{"state":"resolved","title":"Stale Zapier Auth Token","diagnosis":"Enabling API access invalidates existing tokens.","steps":[{"tag":"action","text":"Disconnect Zapier."},{"tag":"verify","text":"Confirm sync resumes."}],"escalate":false,"escalation_path":null,"suggested_channel_post":null,"refs":[{"source":"confluence","title":"Zapier Setup Guide"}]}';
const parsedResolved = parseChatResponse(resolvedJson);
assert(parsedResolved.state === 'resolved', 'parseChatResponse: resolved state parsed');
assert(parsedResolved.title === 'Stale Zapier Auth Token', 'parseChatResponse: title parsed');
assert(parsedResolved.diagnosis === 'Enabling API access invalidates existing tokens.', 'parseChatResponse: diagnosis parsed');
assert(Array.isArray(parsedResolved.steps), 'parseChatResponse: steps is array');
assert(parsedResolved.steps.length === 2, 'parseChatResponse: correct step count');
assert(parsedResolved.escalate === false, 'parseChatResponse: escalate false');
assert(Array.isArray(parsedResolved.refs), 'parseChatResponse: refs is array');

// Valid resolved JSON with escalation
const escalateJson = '{"state":"resolved","title":"Enterprise Tier Required","diagnosis":"Backend config needed.","steps":[{"tag":"escalate","text":"Escalate via Live Assist."}],"escalate":true,"escalation_path":"Live Assist → Integrations Specialist","suggested_channel_post":"Customer needs escalation — please assist.","refs":[]}';
const parsedEscalate = parseChatResponse(escalateJson);
assert(parsedEscalate.escalate === true, 'parseChatResponse: escalate true');
assert(parsedEscalate.escalation_path === 'Live Assist → Integrations Specialist', 'parseChatResponse: escalation_path parsed');
assert(parsedEscalate.suggested_channel_post === 'Customer needs escalation — please assist.', 'parseChatResponse: suggested_channel_post parsed');

// JSON wrapped in markdown fences
const fencedJson = '```json\n{"state":"diagnosing","acknowledgement":"OK.","question":"Is sync still failing?"}\n```';
const parsedFenced = parseChatResponse(fencedJson);
assert(parsedFenced.state === 'diagnosing', 'parseChatResponse: strips markdown fences');
assert(parsedFenced.question === 'Is sync still failing?', 'parseChatResponse: question parsed from fenced JSON');

// Plain text fallback
const parsedFallback = parseChatResponse('This is plain text, not JSON.');
assert(parsedFallback.state === 'diagnosing', 'parseChatResponse: plain text → diagnosing state');
assert(parsedFallback.acknowledgement === '', 'parseChatResponse: plain text → empty acknowledgement');
assert(parsedFallback.question === 'This is plain text, not JSON.', 'parseChatResponse: plain text → question field holds raw text');

// Invalid JSON object (valid JSON but wrong schema)
const parsedWrongSchema = parseChatResponse('{"foo":"bar"}');
assert(parsedWrongSchema.state === 'diagnosing', 'parseChatResponse: wrong-schema JSON → fallback to diagnosing');

// JSON embedded in surrounding prose (Claude adds preamble/postamble after tool use)
const proseWrapped = 'Here is my analysis:\n{"state":"diagnosing","acknowledgement":"Got it.","question":"Has the webhook been reconfigured?"}\nLet me know if you need more.';
const parsedProse = parseChatResponse(proseWrapped);
assert(parsedProse.state === 'diagnosing', 'parseChatResponse: extracts JSON from surrounding prose');
assert(parsedProse.acknowledgement === 'Got it.', 'parseChatResponse: acknowledgement correct from prose-wrapped JSON');
assert(parsedProse.question === 'Has the webhook been reconfigured?', 'parseChatResponse: question correct from prose-wrapped JSON');

// ── 17. buildFollowUpBlocks — label param ─────────────────────────────────────
console.log('\n🔹 buildFollowUpBlocks — label param');

const followUpDefault = buildFollowUpBlocks('Some text');
const followUpDefaultCtx = followUpDefault.find(b => b.type === 'context');
assert(followUpDefaultCtx.elements[0].text === '_Follow-up_', 'buildFollowUpBlocks: default label is Follow-up');

const followUpLabeled = buildFollowUpBlocks('Diagnosing text', { label: 'Diagnosing…' });
const followUpLabeledCtx = followUpLabeled.find(b => b.type === 'context');
assert(followUpLabeledCtx.elements[0].text === '_Diagnosing…_', 'buildFollowUpBlocks: custom label rendered');
assert(followUpLabeled.find(b => b.type === 'section').text.text === 'Diagnosing text', 'buildFollowUpBlocks: text unchanged with label');

// ── 18. buildChatResolutionBlocks ─────────────────────────────────────────────
console.log('\n🔹 buildChatResolutionBlocks');

const resolvedData = {
  state: 'resolved',
  title: 'Stale Zapier Auth Token',
  diagnosis: 'Enabling API access invalidates existing tokens — re-auth required.',
  steps: [
    { tag: 'action', text: 'Disconnect Zapier in account settings.' },
    { tag: 'action', text: 'Re-authenticate from scratch.' },
    { tag: 'verify', text: 'Confirm sync resumes.' },
  ],
  escalate: false,
  escalation_path: null,
  suggested_channel_post: null,
  refs: [
    { source: 'confluence', title: 'Zapier Setup Guide' },
    { source: 'slack', title: 'Zapier token issue thread' },
  ],
};

const chatResBlocks = buildChatResolutionBlocks(resolvedData);
assert(Array.isArray(chatResBlocks), 'buildChatResolutionBlocks returns array');
assert(chatResBlocks.length > 0, 'buildChatResolutionBlocks returns non-empty array');

// Badge
const resBadge = chatResBlocks[0];
assert(resBadge.type === 'context', 'first block is context (badge)');
assert(resBadge.elements[0].text.includes('Root cause found'), 'resolved badge: Root cause found');
assert(!resBadge.elements[0].text.includes('Needs escalation'), 'resolved badge: no escalation text');

// Title + diagnosis
const resTitleBlock = chatResBlocks[1];
assert(resTitleBlock.type === 'section', 'second block is section');
assert(resTitleBlock.text.text.includes('Stale Zapier Auth Token'), 'title block has title');
assert(resTitleBlock.text.text.includes('Enabling API access invalidates'), 'title block has diagnosis');

// Steps
const resStepBlocks = chatResBlocks.filter(b => b.type === 'section' && b.text?.text?.includes('`action`'));
assert(resStepBlocks.length === 2, 'buildChatResolutionBlocks renders 2 action steps');
const verifyStep = chatResBlocks.find(b => b.type === 'section' && b.text?.text?.includes('`verify`'));
assert(verifyStep !== undefined, 'buildChatResolutionBlocks renders verify step');

// Source chips
const resChipBlock = chatResBlocks.find(b => b.type === 'context' && b.elements[0].text?.includes('Verified:'));
assert(resChipBlock !== undefined, 'buildChatResolutionBlocks renders source chips');
assert(resChipBlock.elements[0].text.includes('Confluence'), 'source chips include Confluence');
assert(resChipBlock.elements[0].text.includes('Slack'), 'source chips include Slack');

// Actions
const resActions = chatResBlocks.find(b => b.type === 'actions');
assert(resActions !== undefined, 'buildChatResolutionBlocks has actions block');
const resWrongBtn = resActions.elements.find(e => e.action_id === 'wrong_answer_modal');
assert(resWrongBtn !== undefined, 'buildChatResolutionBlocks has wrong_answer_modal button');
const resNewChatBtn = resActions.elements.find(e => e.action_id === 'new_chat');
assert(resNewChatBtn !== undefined, 'buildChatResolutionBlocks has new_chat button');
const resChannelPostBtn = resActions.elements.find(e => e.action_id === 'copy_channel_post');
assert(resChannelPostBtn === undefined, 'no copy_channel_post button when escalate: false');

// Escalation state
const escalationData = {
  state: 'resolved',
  title: 'Enterprise Tier Required',
  diagnosis: 'This tenant requires backend config only available to Specialists.',
  steps: [
    { tag: 'action', text: 'Collect error details from customer.' },
    { tag: 'escalate', text: 'Escalate via Live Assist → Integrations Specialist.' },
  ],
  escalate: true,
  escalation_path: 'Live Assist → Integrations Specialist',
  suggested_channel_post: 'Customer has Enterprise tier issue — escalating now.',
  refs: [{ source: 'kb', title: 'Enterprise Tier Config' }],
};

const escBlocks = buildChatResolutionBlocks(escalationData);
const escBadge = escBlocks[0];
assert(escBadge.elements[0].text.includes('Needs escalation'), 'escalation badge: Needs escalation');

const escPathBlock = escBlocks.find(b => b.type === 'context' && b.elements[0].text?.includes('Escalation path:'));
assert(escPathBlock !== undefined, 'escalation path context block rendered');
assert(escPathBlock.elements[0].text.includes('Live Assist → Integrations Specialist'), 'escalation path text correct');

const escActions = escBlocks.find(b => b.type === 'actions');
const escChannelPostBtn = escActions.elements.find(e => e.action_id === 'copy_channel_post');
assert(escChannelPostBtn !== undefined, 'copy_channel_post button present when escalate: true');
assert(escChannelPostBtn.value === 'Customer has Enterprise tier issue — escalating now.', 'copy_channel_post value is suggested_channel_post');
const escNewChatBtn = escActions.elements.find(e => e.action_id === 'new_chat');
assert(escNewChatBtn !== undefined, 'new_chat button still present in escalation state');

// No chips when refs is empty
const noRefsData = { ...resolvedData, refs: [] };
const noRefsChatBlocks = buildChatResolutionBlocks(noRefsData);
const noRefsChip = noRefsChatBlocks.find(b => b.type === 'context' && b.elements[0].text?.includes('Verified:'));
assert(noRefsChip === undefined, 'no source chips when refs is empty');

// ── 19. buildChannelPostModal ─────────────────────────────────────────────────
console.log('\n🔹 buildChannelPostModal');

const cpModal = buildChannelPostModal('Anyone seen Zapier failing after enabling API access? Need a hand here.');
assert(cpModal.type === 'modal', 'buildChannelPostModal returns modal');
assert(cpModal.title.text === '📋 Channel post', 'modal title is 📋 Channel post');
assert(!('submit' in cpModal), 'buildChannelPostModal has no submit button (view-only)');
assert(cpModal.close.text === 'Close', 'modal has Close button');
const cpSection = cpModal.blocks.find(b => b.type === 'section');
assert(cpSection !== undefined, 'modal has section block');
assert(cpSection.text.text === 'Anyone seen Zapier failing after enabling API access? Need a hand here.', 'modal section contains the provided text');
const cpContext = cpModal.blocks.find(b => b.type === 'context');
assert(cpContext !== undefined, 'modal has context block with instructions');
assert(cpContext.elements[0].text.includes('Select all and copy'), 'instructions say to select and copy');

// ── 20. buildResponseBlocks — diagnosis + chips + channel post button ──────────
console.log('\n🔹 buildResponseBlocks — new fields');

// Diagnosis line present when findings_summary.diagnosis is set
const withDiagBlocks = buildResponseBlocks({
  ...sampleJson,
  escalate_decision: { should_escalate: false, reason: 'CSA can handle' },
});
const diagBlock = withDiagBlocks.filter(b => b.type === 'context').find(b => b.elements[0].text?.includes('🔍'));
assert(diagBlock !== undefined, 'diagnosis context block present when findings_summary.diagnosis set');
assert(diagBlock.elements[0].text.includes('Zapier integration is failing'), 'diagnosis text is from findings_summary.diagnosis');
assert(diagBlock.elements[0].text.includes('_'), 'diagnosis text is italicised with markdown');

// Diagnosis line absent when findings_summary is missing
const noDiagBlocks = buildResponseBlocks({ ...sampleJson, findings_summary: undefined, escalate_decision: { should_escalate: false, reason: 'x' } });
const noDiagBlock2 = noDiagBlocks.filter(b => b.type === 'context').find(b => b.elements[0].text?.includes('🔍'));
assert(noDiagBlock2 === undefined, 'no diagnosis block when findings_summary missing');

// Source chips: Confluence chip when atlassian_refs has confluence entry
const chipsBlocks = buildResponseBlocks({ ...sampleJson, escalate_decision: { should_escalate: false, reason: 'x' } });
const chipsBlock = chipsBlocks.filter(b => b.type === 'context').find(b => b.elements[0].text?.includes('📄 Confluence'));
assert(chipsBlock !== undefined, 'Confluence chip present when atlassian_refs has confluence');
assert(chipsBlock.elements[0].text.includes('📄 Jira'), 'Jira chip present when atlassian_refs has jira');
assert(chipsBlock.elements[0].text.includes('💬 Slack'), 'Slack chip present when slack_refs non-empty');
assert(chipsBlock.elements[0].text.includes('📖 KB'), 'KB chip present when kb_refs non-empty');

// No chips when all ref arrays are empty
const noChipsBlocks = buildResponseBlocks({ ...sampleJson, slack_refs: [], atlassian_refs: [], kb_refs: [], escalate_decision: { should_escalate: false, reason: 'x' } });
const noChipsBlock = noChipsBlocks.filter(b => b.type === 'context').find(b => b.elements[0].text?.includes('📄 Confluence') || b.elements[0].text?.includes('📄 Jira') || b.elements[0].text?.includes('💬 Slack') || b.elements[0].text?.includes('📖 KB'));
assert(noChipsBlock === undefined, 'no chips context block when all ref arrays empty');

// Channel post button present when should_escalate:true and suggested_channel_post set
const channelPostBlocks = buildResponseBlocks({
  ...sampleJson,
  escalate_decision: { should_escalate: true, reason: 'Needs backend' },
  channel_recommendation: { channel: 'ask-integrations', reason: 'Team visibility' },
  suggested_channel_post: 'Anyone seen this Zapier issue?',
});
const cpActionsBlock = channelPostBlocks.find(b => b.type === 'actions');
const cpBtn = cpActionsBlock?.elements?.find(e => e.action_id === 'copy_channel_post');
assert(cpBtn !== undefined, 'copy_channel_post button present when should_escalate and suggested_channel_post set');
assert(cpBtn.value === 'Anyone seen this Zapier issue?', 'copy_channel_post button value is suggested_channel_post');

// Channel post button absent when should_escalate:false
const noCpBlocks = buildResponseBlocks({
  ...sampleJson,
  escalate_decision: { should_escalate: false, reason: 'CSA handles' },
  suggested_channel_post: 'This should not appear.',
});
const noCpActionsBlock = noCpBlocks.find(b => b.type === 'actions');
const noCpBtn = noCpActionsBlock?.elements?.find(e => e.action_id === 'copy_channel_post');
assert(noCpBtn === undefined, 'copy_channel_post button absent when should_escalate: false');

// Channel post button absent when suggested_channel_post missing
const noCpNoTextBlocks = buildResponseBlocks({
  ...sampleJson,
  escalate_decision: { should_escalate: true, reason: 'x' },
  suggested_channel_post: undefined,
});
const noCpNoTextBtn = noCpNoTextBlocks.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'copy_channel_post');
assert(noCpNoTextBtn === undefined, 'copy_channel_post button absent when suggested_channel_post missing');

// new_chat button still last when isDm + escalation + channel post
const fullDmBlocks = buildResponseBlocks({
  ...sampleJson,
  escalate_decision: { should_escalate: true, reason: 'Needs backend' },
  channel_recommendation: { channel: 'ask-integrations', reason: 'x' },
  suggested_channel_post: 'Post this.',
}, { isDm: true });
const fullDmActions = fullDmBlocks.find(b => b.type === 'actions');
assert(fullDmActions.elements.at(-1).action_id === 'new_chat', 'new_chat button is last even with channel post + isDm');

// ── buildProgressBlocks ───────────────────────────────────────────────────────
console.log('\n🔹 buildProgressBlocks');

// Basic structure — empty steps
const progEmpty = buildProgressBlocks('Zapier stopped syncing', []);
assert(Array.isArray(progEmpty), 'buildProgressBlocks returns array');
assert(progEmpty.length === 2, 'buildProgressBlocks returns 2 blocks');
assert(progEmpty[0].type === 'section', 'first block is section');
assert(progEmpty[0].text.type === 'mrkdwn', 'section uses mrkdwn');
assert(progEmpty[0].text.text.includes('⚙️ Looking into this'), 'header includes ⚙️ Looking into this');
assert(progEmpty[1].type === 'context', 'second block is context');

// tool_start step → ⟳ Confluence  searching…
const progStart = buildProgressBlocks('test', [
  { tool: 'confluence', phase: 'tool_start', count: null },
]);
assert(progStart[0].text.text.includes('⟳'), 'tool_start shows ⟳');
assert(progStart[0].text.text.includes('Confluence'), 'tool name is capitalized');
assert(progStart[0].text.text.toLowerCase().includes('searching'), 'tool_start shows searching');

// tool_done count > 0 → ✓ Confluence  · 3 results
const progDone3 = buildProgressBlocks('test', [
  { tool: 'confluence', phase: 'tool_done', count: 3 },
]);
assert(progDone3[0].text.text.includes('✓'), 'tool_done count > 0 shows ✓');
assert(progDone3[0].text.text.includes('3 results'), 'count > 0 shows N results');

// tool_done count === 1 → singular "result"
const progDone1 = buildProgressBlocks('test', [
  { tool: 'confluence', phase: 'tool_done', count: 1 },
]);
assert(progDone1[0].text.text.includes('1 result'), 'count 1 uses singular "result"');
assert(!progDone1[0].text.text.includes('1 results'), 'count 1 does not say "1 results"');

// tool_done count === 0 → –  Jira  · no results (no ✓)
const progZero = buildProgressBlocks('test', [
  { tool: 'jira', phase: 'tool_done', count: 0 },
]);
assert(progZero[0].text.text.includes('–'), 'tool_done count 0 shows dash');
assert(progZero[0].text.text.includes('no results'), 'tool_done count 0 shows no results');
assert(!progZero[0].text.text.includes('✓'), 'tool_done count 0 does not show ✓');

// Slack is rendered in the context line, not the section rows
const progSlackSearching = buildProgressBlocks('Zapier API access', [
  { tool: 'slack', phase: 'tool_start', count: null },
]);
assert(!progSlackSearching[0].text.text.includes('Slack'), 'slack does not appear in section rows');
assert(progSlackSearching[1].elements[0].text.includes('Now: searching Slack'),
  'slack searching shown in context line');
assert(progSlackSearching[1].elements[0].text.includes('"Zapier API access"'),
  'context line includes the user query');

// Slack tool_done clears the searching state — falls back to default context line
const progSlackDone = buildProgressBlocks('test', [
  { tool: 'slack', phase: 'tool_start', count: null },
  { tool: 'slack', phase: 'tool_done',  count: null },
]);
assert(!progSlackDone[1].elements[0].text.includes('Now: searching Slack'),
  'slack done removes the "now: searching" line');

// writing step → context shows "writing answer"
const progWriting = buildProgressBlocks('test', [
  { tool: null, phase: 'writing', count: null },
]);
assert(!progWriting[0].text.text.includes('✏️'),
  'writing indicator no longer lives in section');
assert(progWriting[1].elements[0].text.toLowerCase().includes('writing answer'),
  'writing shown in context line');

// writing supersedes slack searching in context
const progWritingOverSlack = buildProgressBlocks('test', [
  { tool: 'slack', phase: 'tool_start', count: null },
  { tool: null,    phase: 'writing',    count: null },
]);
assert(progWritingOverSlack[1].elements[0].text.toLowerCase().includes('writing'),
  'writing supersedes slack in context');
assert(!progWritingOverSlack[1].elements[0].text.includes('searching Slack'),
  'writing supersedes slack — no "searching Slack" text');

// Long query truncates to keep the context line tidy
const longQ = 'Zapier integration is not syncing leads after the recent tenant migration and customer is asking when it will be fixed';
const progLongQ = buildProgressBlocks(longQ, [{ tool: 'slack', phase: 'tool_start', count: null }]);
assert(progLongQ[1].elements[0].text.includes('…'), 'long query truncated with …');

// Multi-step: confluence done, jira 0 — slack and writing surface via context
const progMulti = buildProgressBlocks('Zapier stopped syncing after API access enabled', [
  { tool: 'confluence', phase: 'tool_done', count: 3 },
  { tool: 'jira',       phase: 'tool_done', count: 0 },
  { tool: 'slack',      phase: 'tool_start', count: null },
  { tool: null,         phase: 'writing',    count: null },
]);
const multiText = progMulti[0].text.text;
assert(multiText.includes('✓') && multiText.includes('Confluence'), 'multi: confluence done ✓');
assert(multiText.includes('–') && multiText.includes('Jira'),       'multi: jira 0 shows –');
assert(!multiText.includes('Slack'), 'multi: slack no longer in section');
assert(progMulti[1].elements[0].text.toLowerCase().includes('writing'),
  'multi: writing surfaces in context (overrides slack)');

// ── feature-flags ─────────────────────────────────────────────────────────────
console.log('\n🔹 feature-flags');

delete process.env.NEW_PIPELINE;
assert(isNewPipelineEnabled() === true, 'unset NEW_PIPELINE → true (default ON post-Phase-2)');

process.env.NEW_PIPELINE = 'false';
assert(isNewPipelineEnabled() === false, '"false" → false (kill-switch back to legacy)');

process.env.NEW_PIPELINE = 'FALSE';
assert(isNewPipelineEnabled() === false, '"FALSE" (case-insensitive) → false');

process.env.NEW_PIPELINE = 'true';
assert(isNewPipelineEnabled() === true, '"true" → true');

process.env.NEW_PIPELINE = 'TRUE';
assert(isNewPipelineEnabled() === true, '"TRUE" → true');

process.env.NEW_PIPELINE = '1';
assert(isNewPipelineEnabled() === true, '"1" → true (anything not "false" enables)');

process.env.NEW_PIPELINE = 'fals';
assert(isNewPipelineEnabled() === true, 'typo "fals" → true (strict disable protects from accidental rollback)');

delete process.env.NEW_PIPELINE;

// ── slack search-client ───────────────────────────────────────────────────────
console.log('\n🔹 slack search-client');

// No token → null
delete process.env.SLACK_USER_TOKEN;
const noToken = await searchSlackMessages('zapier');
assert(noToken === null, 'searchSlackMessages returns null when SLACK_USER_TOKEN is missing');

// Placeholder token → null
process.env.SLACK_USER_TOKEN = 'xoxp-replace-me';
const placeholder = await searchSlackMessages('zapier');
assert(placeholder === null, 'searchSlackMessages returns null for placeholder token');

// Successful response → parsed refs
process.env.SLACK_USER_TOKEN = 'xoxp-test-token';
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  assert(url.startsWith('https://slack.com/api/search.messages'), 'hits Slack API');
  assert(opts.headers.Authorization === 'Bearer xoxp-test-token', 'uses Bearer auth');
  return new Response(JSON.stringify({
    ok: true,
    messages: {
      matches: [
        { permalink: 'https://slack.com/archives/C1/p123', channel: { name: 'integrations' }, text: 'Zapier issue resolved by enabling API' },
        { permalink: 'https://slack.com/archives/C1/p124', channel: { name: 'support' }, text: 'Another Zapier thread' },
      ],
    },
  }), { status: 200 });
};
const ok = await searchSlackMessages('zapier');
assert(ok !== null, 'parses successful response');
assert(ok.refs.length === 2, 'returns two refs');
assert(ok.refs[0].url === 'https://slack.com/archives/C1/p123', 'extracts permalink');
assert(ok.refs[0].channel === '#integrations', 'prefixes channel with #');
assert(ok.text.includes('integrations'), 'text contains channel');

// Empty matches → null
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, messages: { matches: [] } }), { status: 200 });
const empty = await searchSlackMessages('zapier');
assert(empty === null, 'returns null when no matches');

// Non-200 → null
globalThis.fetch = async () => new Response('{}', { status: 500 });
const fail = await searchSlackMessages('zapier');
assert(fail === null, 'returns null on non-200');

// Slack-level error (ok: false) → null
globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 });
const slackErr = await searchSlackMessages('zapier');
assert(slackErr === null, 'returns null on Slack-level error');

// Thrown exception → null
globalThis.fetch = async () => { throw new Error('network down'); };
const thrown = await searchSlackMessages('zapier');
assert(thrown === null, 'returns null when fetch throws');

globalThis.fetch = origFetch;
delete process.env.SLACK_USER_TOKEN;

// ── search-executor ───────────────────────────────────────────────────────────
console.log('\n🔹 search-executor');

const origFetchSE = globalThis.fetch;

// Helper fetch returns a per-URL fixture
globalThis.fetch = async (url) => {
  const u = typeof url === 'string' ? url : url.toString();
  if (u.includes('api.anthropic.com')) {
    return new Response(JSON.stringify({
      content: [{
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_test',
        content: [{ type: 'web_search_result', title: 'KB hit', url: 'https://help.servicetitan.com/x' }],
      }],
    }), { status: 200 });
  }
  if (u.includes('atlassian.net/wiki')) {
    return new Response(JSON.stringify({ results: [{ title: 'Confluence hit', url: '/page/1', excerpt: 'bar' }] }), { status: 200 });
  }
  if (u.includes('atlassian.net/rest/api/3/search')) {
    return new Response(JSON.stringify({ issues: [{ key: 'JIRA-1', fields: { summary: 'Jira hit', status: { name: 'Open' } } }] }), { status: 200 });
  }
  if (u.includes('slack.com/api/search.messages')) {
    return new Response(JSON.stringify({ ok: true, messages: { matches: [{ permalink: 'https://slack.com/archives/C1/p1', channel: { name: 'c' }, text: 'Slack hit' }] } }), { status: 200 });
  }
  return new Response('{}', { status: 500 });
};
const _savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.ATLASSIAN_EMAIL = 'a@b.c';
process.env.ATLASSIAN_API_TOKEN = 't';
process.env.SLACK_USER_TOKEN = 'xoxp-real';

const plan = {
  sources: [
    { name: 'kb',         priority: 'medium', query: 'kb query' },
    { name: 'confluence', priority: 'high',   query: 'confluence query' },
    { name: 'jira',       priority: 'low',    query: 'jira query' },
    { name: 'slack',      priority: 'high',   query: 'slack query' },
  ],
};
const seResult = await executeSearchPlan(plan);

assert(seResult.kb !== null, 'kb executed');
assert(seResult.kb.priority === 'medium', 'kb priority passed through');
assert(seResult.confluence !== null, 'confluence executed');
assert(seResult.confluence.priority === 'high', 'confluence priority passed through');
assert(seResult.jira !== null, 'jira executed');
assert(seResult.jira.priority === 'low', 'jira priority passed through');
assert(seResult.slack !== null, 'slack executed');
assert(seResult.slack.priority === 'high', 'slack priority passed through');

// Plan with only two sources → the other two are null
const partialPlan = { sources: [{ name: 'kb', priority: 'high', query: 'kb only' }, { name: 'slack', priority: 'high', query: 'slack only' }] };
const partial = await executeSearchPlan(partialPlan);
assert(partial.kb !== null, 'kb runs');
assert(partial.slack !== null, 'slack runs');
assert(partial.confluence === null, 'confluence stays null');
assert(partial.jira === null, 'jira stays null');

// One failing source does not break others
globalThis.fetch = async (url) => {
  const u = typeof url === 'string' ? url : url.toString();
  if (u.includes('api.anthropic.com')) throw new Error('boom');
  if (u.includes('atlassian.net/wiki')) {
    return new Response(JSON.stringify({ results: [{ title: 'OK', url: '/x', excerpt: '' }] }), { status: 200 });
  }
  return new Response('{}', { status: 500 });
};
const partialFail = await executeSearchPlan({ sources: [{ name: 'kb', priority: 'high', query: 'q' }, { name: 'confluence', priority: 'high', query: 'q' }] });
assert(partialFail.kb === null, 'failing kb returns null');
assert(partialFail.confluence !== null, 'confluence still succeeds');

// Empty plan / null plan
const emptyPlan = await executeSearchPlan({ sources: [] });
assert(emptyPlan.kb === null && emptyPlan.confluence === null && emptyPlan.jira === null && emptyPlan.slack === null, 'empty plan returns all null');
const nullPlan = await executeSearchPlan(null);
assert(nullPlan.kb === null && nullPlan.confluence === null && nullPlan.jira === null && nullPlan.slack === null, 'null plan returns all null');

// Unknown source name in plan is silently ignored
const unknown = await executeSearchPlan({ sources: [{ name: 'mysteriousSource', priority: 'high', query: 'q' }] });
assert(unknown.kb === null && unknown.confluence === null && unknown.jira === null && unknown.slack === null, 'unknown source ignored');

globalThis.fetch = origFetchSE;
if (_savedAnthropicKey) process.env.ANTHROPIC_API_KEY = _savedAnthropicKey;
else delete process.env.ANTHROPIC_API_KEY;
delete process.env.ATLASSIAN_EMAIL;
delete process.env.ATLASSIAN_API_TOKEN;
delete process.env.SLACK_USER_TOKEN;

// ── answerer ──────────────────────────────────────────────────────────────────
console.log('\n🔹 answerer');

const origFetchAns = globalThis.fetch;
let lastAnthropicBody;
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url.toString();
  if (u.includes('anthropic.com')) {
    lastAnthropicBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: '{"issue_title":"Test","integration_type":"Zapier","is_accounting_topic":false,"confidence":"high","customer_message":"Hi.","escalate_decision":{"should_escalate":false,"reason":""},"channel_recommendation":{"channel":"","reason":""},"agent_steps":[],"findings_summary":{"diagnosis":"","actions":[]},"slack_refs":[],"atlassian_refs":[],"kb_refs":[],"sources_used":["slack"]}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 100 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchAns(url, opts);
};
process.env.ANTHROPIC_API_KEY = 'test-key';

const ansResult = await runAnswerer({
  cleanedQuestion: 'Zapier not syncing',
  searchResults: {
    kb: null,
    confluence: { text: 'C content', refs: [], priority: 'high' },
    jira: null,
    slack: { text: 'S content', refs: [], priority: 'high' },
  },
  role: 'csa',
  teamKnowledge: 'TK content',
  feedbackContext: '\n\nIMPORTANT — Past corrections: X',
});

assert(ansResult !== null, 'answerer returns parsed JSON');
assert(ansResult.issue_title === 'Test', 'parses issue_title');
assert(ansResult.integration_type === 'Zapier', 'parses integration_type');
assert(lastAnthropicBody.system.includes('CSA') || lastAnthropicBody.system.includes('Customer Support') || lastAnthropicBody.system.length > 1000, 'uses non-empty CSA system prompt for csa role');
assert(lastAnthropicBody.messages[0].content.includes('Issue: Zapier not syncing'), 'user content starts with cleaned question');
assert(lastAnthropicBody.messages[0].content.includes('TK content'), 'user content includes team knowledge');
assert(lastAnthropicBody.messages[0].content.includes('[TEAM KNOWLEDGE]'), 'user content has TEAM KNOWLEDGE delimiter');
assert(lastAnthropicBody.messages[0].content.includes('C content'), 'user content includes confluence');
assert(lastAnthropicBody.messages[0].content.includes('[CONFLUENCE RESULTS]'), 'user content has CONFLUENCE RESULTS delimiter');
assert(lastAnthropicBody.messages[0].content.includes('S content'), 'user content includes slack');
assert(lastAnthropicBody.messages[0].content.includes('[SLACK RESULTS]'), 'user content has SLACK RESULTS delimiter');
assert(!lastAnthropicBody.messages[0].content.includes('[KB RESULTS]'), 'kb absent → no KB delimiter');
assert(!lastAnthropicBody.messages[0].content.includes('[JIRA RESULTS]'), 'jira absent → no JIRA delimiter');
assert(lastAnthropicBody.messages[0].content.includes('IMPORTANT — Past corrections'), 'user content includes feedback');
assert(!('mcp_servers' in lastAnthropicBody), 'no mcp_servers in answerer call (Slack moved to Web API)');
assert(!('betas' in lastAnthropicBody), 'no betas: ["mcp-client-..."] in answerer call');

// Specialist role uses specialist prompt
await runAnswerer({
  cleanedQuestion: 'q',
  searchResults: { kb: null, confluence: null, jira: null, slack: null },
  role: 'specialist',
  teamKnowledge: null,
  feedbackContext: '',
});
assert(lastAnthropicBody.system.includes('Specialist') || lastAnthropicBody.system.includes('specialist'), 'uses Specialist prompt for specialist role');

// agentName must NOT leak into system prompt (caused third-person customer_message bug)
await runAnswerer({
  cleanedQuestion: 'q',
  searchResults: { kb: null, confluence: null, jira: null, slack: null },
  role: 'csa',
  teamKnowledge: null,
  feedbackContext: '',
  agentName: 'Sarah',
});
assert(!lastAnthropicBody.system.includes('Sarah'), 'system prompt does NOT include agent name (prevents third-person customer_message)');

// Empty feedback context doesn't add anything
await runAnswerer({
  cleanedQuestion: 'q',
  searchResults: { kb: null, confluence: null, jira: null, slack: null },
  role: 'csa',
  teamKnowledge: null,
  feedbackContext: '',
});
assert(lastAnthropicBody.messages[0].content === 'Issue: q', 'empty feedback adds nothing');

globalThis.fetch = origFetchAns;
delete process.env.ANTHROPIC_API_KEY;

// ── interpreter ───────────────────────────────────────────────────────────────
console.log('\n🔹 interpreter');

import { runInterpreter } from './src/claude/interpreter.js';

const origFetchInt = globalThis.fetch;
let lastInterpreterBody;

globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    lastInterpreterBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"cleaned_question":"Zapier stopped syncing","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"stopped syncing"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"confluence","priority":"high","query":"Zapier sync"}],"rationale":"r"}}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchInt(url, opts);
};
process.env.ANTHROPIC_API_KEY = 'test';

const okInterp = await runInterpreter('Zapier stopped syncing');
assert(okInterp.cleaned_question === 'Zapier stopped syncing', 'parses cleaned_question');
assert(okInterp.intent === 'troubleshooting', 'parses intent');
assert(okInterp.question_confidence === 'high', 'parses question_confidence');
assert(lastInterpreterBody.model === 'claude-haiku-4-5-20251001' || lastInterpreterBody.model.includes('haiku'), 'uses Haiku model');

await runInterpreter('still not working', { threadHistory: [
  { role: 'user', content: 'My Zapier broke' },
  { role: 'assistant', content: 'Did you check the API toggle?' },
]});
assert(lastInterpreterBody.messages.length >= 1, 'has user message');
const lastMsg = lastInterpreterBody.messages[lastInterpreterBody.messages.length - 1].content;
assert(lastMsg.includes('still not working'), 'includes current message');
assert(lastMsg.includes('Zapier broke'), 'includes prior thread history');

let attempts = 0;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    attempts++;
    if (attempts === 1) return new Response('upstream error', { status: 503 });
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"cleaned_question":"q","intent":"unclear","entities":{"integration":null,"error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":null},"question_confidence":"low","clarifying_question":"Which?","search_plan":null}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchInt(url, opts);
};
const retried = await runInterpreter('vague');
assert(attempts === 2, 'retried exactly once on 5xx');
assert(retried.question_confidence === 'low', 'got the eventual response');

attempts = 0;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    attempts++;
    return new Response('boom', { status: 503 });
  }
  return origFetchInt(url, opts);
};
const fallback = await runInterpreter('test');
assert(attempts === 2, 'tries twice total before giving up');
assert(fallback.question_confidence === 'low', 'fallback confidence is low');
assert(fallback.intent === 'unclear', 'fallback intent is unclear');
assert(fallback.clarifying_question && fallback.clarifying_question.length > 0, 'fallback includes clarifying_question');
assert(fallback.search_plan === null, 'fallback skips search');

globalThis.fetch = origFetchInt;
delete process.env.ANTHROPIC_API_KEY;

// ── evaluator ─────────────────────────────────────────────────────────────────
console.log('\n🔹 evaluator');

import { runEvaluator } from './src/claude/evaluator.js';

const origFetchEv = globalThis.fetch;

globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"sufficient":true,"rationale":"good","refined_plan":null}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchEv(url, opts);
};
process.env.ANTHROPIC_API_KEY = 'test';

const suff = await runEvaluator({
  cleanedQuestion: 'q',
  searchResults: { kb: null, confluence: { text: 't', refs: [] }, jira: null, slack: null },
  originalPlan: { sources: [] },
});
assert(suff.sufficient === true, 'parses sufficient: true');
assert(suff.refined_plan === null, 'refined_plan null when sufficient');

globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"sufficient":false,"rationale":"results off-topic","refined_plan":{"sources":[{"name":"slack","priority":"high","query":"better keywords"}]}}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchEv(url, opts);
};
const insuff = await runEvaluator({
  cleanedQuestion: 'q',
  searchResults: { kb: null, confluence: null, jira: null, slack: null },
  originalPlan: { sources: [] },
});
assert(insuff.sufficient === false, 'parses sufficient: false');
assert(insuff.refined_plan.sources[0].query === 'better keywords', 'parses refined query');

globalThis.fetch = async () => new Response('boom', { status: 503 });
const failedEval = await runEvaluator({
  cleanedQuestion: 'q',
  searchResults: { kb: null, confluence: null, jira: null, slack: null },
  originalPlan: { sources: [] },
});
assert(failedEval.sufficient === true, 'failure assumes sufficient (skip refinement)');
assert(failedEval.refined_plan === null, 'no refined plan on failure');

globalThis.fetch = origFetchEv;
delete process.env.ANTHROPIC_API_KEY;

// ── cache two-key support ─────────────────────────────────────────────────────
console.log('\n🔹 cache two-key');

import { setCachedMulti } from './src/slack/cache.js';
const dummyCacheData = { issue_title: 'X' };

setCachedMulti(['raw text here', 'raw text'], dummyCacheData);
assert(getCached('raw text here') !== null, 'raw key1 hits');
assert(getCached('raw text') !== null, 'raw key2 hits');
assert(getCached('totally unrelated key') === null, 'unrelated key misses');

setCachedMulti(['only one'], dummyCacheData);
assert(getCached('only one') !== null, 'single-key write works');

setCachedMulti(['valid key', null, '', undefined], dummyCacheData);
assert(getCached('valid key') !== null, 'valid key in mixed array is written');

// ── transient cache fields (stale-thread / cross-channel leak guard) ──────────
console.log('\n🔹 transient cache fields');

import { stripTransient, withRequestContext } from './src/handlers/mention.js';

const bakedResult = {
  issue_title: 'Zapier broke',
  integration_type: 'Zapier',
  _originalQuery: 'original asker query',
  _showSpecialistValue: JSON.stringify({ threadTs: 'T_OLD', channelId: 'C_OLD', query: 'old' }),
  _cleanedQuestion: 'zapier broke',
};

const stripped = stripTransient(bakedResult);
assert(stripped._originalQuery === undefined, 'stripTransient drops _originalQuery');
assert(stripped._showSpecialistValue === undefined, 'stripTransient drops _showSpecialistValue');
assert(stripped._cleanedQuestion === undefined, 'stripTransient drops _cleanedQuestion');
assert(stripped.issue_title === 'Zapier broke', 'stripTransient keeps real fields');
assert(bakedResult._originalQuery === 'original asker query', 'stripTransient does not mutate the input');

// A CSA in a NEW thread must get a button pointing at THEIR thread, not the cached one
const csaView = withRequestContext(bakedResult, { query: 'new query', threadTs: 'T_NEW', channelId: 'C_NEW', role: 'csa' });
const csaVal = JSON.parse(csaView._showSpecialistValue);
assert(csaVal.threadTs === 'T_NEW' && csaVal.channelId === 'C_NEW', 'withRequestContext rebinds specialist button to current thread/channel');
assert(csaView._originalQuery === 'new query', 'withRequestContext sets _originalQuery to current query');
assert(bakedResult._showSpecialistValue.includes('T_OLD'), 'withRequestContext does not mutate the cached input');

// A specialist must NOT receive the "Show Specialist Detail" affordance
const specialistView = withRequestContext(bakedResult, { query: 'q', threadTs: 'T2', channelId: 'C2', role: 'specialist' });
assert(specialistView._showSpecialistValue === undefined, 'withRequestContext withholds specialist button from specialists');

// ── Block Kit clamping (invalid_blocks / stuck-thinking guard) ────────────────
console.log('\n🔹 Block Kit clamping');

// Helper: assert no section/header text in a block array exceeds Slack limits.
function assertWithinSlackLimits(blocks, label) {
  for (const b of blocks) {
    if (b.type === 'header' && b.text?.type === 'plain_text') {
      assert(b.text.text.length <= 150, `${label}: header within 150 chars (got ${b.text.text.length})`);
    }
    if (b.type === 'section' && b.text?.type === 'mrkdwn') {
      assert(b.text.text.length <= 3000, `${label}: section within 3000 chars (got ${b.text.text.length})`);
    }
  }
}

const HUGE = 'x'.repeat(5000);
const overflowResult = {
  issue_title: HUGE,
  confidence: 'high',
  customer_message: HUGE,
  findings_summary: { diagnosis: HUGE },
  agent_steps: [
    { num: 1, title: HUGE, detail: HUGE, tag: 'action' },
    { num: 2, title: 'ok', detail: HUGE, tag: 'verify' },
  ],
  sources_used: ['kb'],
};
const overflowBlocks = buildResponseBlocks(overflowResult, { role: 'csa' });
assertWithinSlackLimits(overflowBlocks, 'buildResponseBlocks');
assert(overflowBlocks.some(b => b.type === 'header'), 'overflow response still produces a header');

const overflowChat = buildChatResolutionBlocks({
  title: HUGE,
  diagnosis: HUGE,
  steps: [{ tag: 'action', text: HUGE }],
  refs: [],
});
assertWithinSlackLimits(overflowChat, 'buildChatResolutionBlocks');

const overflowModal = buildSourcesModal({
  diagnosis: HUGE,
  slack_refs: [{ url: 'https://x', title: HUGE, channel: HUGE }],
  atlassian_refs: [{ url: 'https://y', title: HUGE, type: 'jira' }],
  kb_refs: [{ url: 'https://z', title: HUGE, snippet: HUGE }],
});
assertWithinSlackLimits(overflowModal.blocks, 'buildSourcesModal');

// Normal-length content must be left intact (no spurious truncation)
const normalBlocks = buildResponseBlocks({
  issue_title: 'Zapier API access',
  confidence: 'high',
  customer_message: 'Short message.',
  agent_steps: [{ num: 1, title: 'Do it', detail: 'Details here.', tag: 'action' }],
}, { role: 'csa' });
assert(JSON.stringify(normalBlocks).includes('Zapier API access'), 'normal title not truncated');
assert(!JSON.stringify(normalBlocks).includes('…'), 'normal content has no ellipsis');

// ── pipeline orchestrator ─────────────────────────────────────────────────────
console.log('\n🔹 pipeline');

import { runPipeline } from './src/claude/pipeline.js';

const origFetchPipe = globalThis.fetch;
process.env.ANTHROPIC_API_KEY = 'test';

let stepCounter = 0;
const sequenceResponses = [];
function nextResponse() {
  const r = sequenceResponses[stepCounter++];
  if (!r) throw new Error(`No response queued for step ${stepCounter}`);
  return r;
}
function anthropicMock(body) {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: body }],
    stop_reason: 'end_turn',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
async function passThroughFetch(url) {
  if (typeof url === 'string' && url.includes('anthropic.com')) return nextResponse();
  return new Response(JSON.stringify({ results: [], items: [], issues: [], messages: { matches: [] } }), { status: 200 });
}

// Test A: question_confidence: low → clarifying-question shortcut
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  anthropicMock('{"cleaned_question":"vague","intent":"unclear","entities":{"integration":null,"error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":null},"question_confidence":"low","clarifying_question":"Which one?","search_plan":null}'),
);
globalThis.fetch = passThroughFetch;
const lowConfResult = await runPipeline({ rawQuery: 'vague', role: 'csa' });
assert(lowConfResult.clarifying_question === 'Which one?', 'low-confidence shortcut returns clarifying_question');
assert(stepCounter === 1, 'only Interpreter was called');

// Test B: sufficient:true → skips refinement
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  anthropicMock('{"cleaned_question":"q","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"x"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"slack","priority":"high","query":"q"}],"rationale":"r"}}'),
  anthropicMock('{"sufficient":true,"rationale":"good","refined_plan":null}'),
  anthropicMock('{"issue_title":"T","integration_type":"Zapier","is_accounting_topic":false,"confidence":"high","customer_message":"","escalate_decision":{"should_escalate":false,"reason":""},"channel_recommendation":{"channel":"","reason":""},"agent_steps":[],"findings_summary":{"diagnosis":"","actions":[]},"slack_refs":[],"atlassian_refs":[],"kb_refs":[],"sources_used":["slack"]}'),
);
globalThis.fetch = passThroughFetch;
const okPipeResult = await runPipeline({ rawQuery: 'Zapier broke', role: 'csa' });
assert(okPipeResult.issue_title === 'T', 'Answerer ran');
assert(stepCounter === 3, 'Interpreter + Evaluator + Answerer (no refinement)');

// Test C: sufficient:false → exactly one refinement
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  anthropicMock('{"cleaned_question":"q","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"x"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"slack","priority":"high","query":"q"}],"rationale":"r"}}'),
  anthropicMock('{"sufficient":false,"rationale":"miss","refined_plan":{"sources":[{"name":"slack","priority":"high","query":"q2"}]}}'),
  anthropicMock('{"issue_title":"T2","integration_type":"Zapier","is_accounting_topic":false,"confidence":"medium","customer_message":"","escalate_decision":{"should_escalate":false,"reason":""},"channel_recommendation":{"channel":"","reason":""},"agent_steps":[],"findings_summary":{"diagnosis":"","actions":[]},"slack_refs":[],"atlassian_refs":[],"kb_refs":[],"sources_used":["slack"]}'),
);
globalThis.fetch = passThroughFetch;
const refinedResult = await runPipeline({ rawQuery: 'Zapier broke', role: 'csa' });
assert(refinedResult.issue_title === 'T2', 'Answerer ran after refinement');
assert(stepCounter === 3, 'Interpreter + Evaluator + Answerer (refinement triggers a second SEARCH, not a second Evaluator)');

// Test D: low confidence BUT clarification capped (thread follow-up) → answers
// best-effort instead of re-asking. Guards against the clarification loop.
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  anthropicMock('{"cleaned_question":"still vague","intent":"unclear","entities":{"integration":null,"error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":null},"question_confidence":"low","clarifying_question":"Which one?","search_plan":null}'),
  anthropicMock('{"sufficient":true,"rationale":"ok","refined_plan":null}'),
  anthropicMock('{"issue_title":"Best effort","integration_type":"General","is_accounting_topic":false,"confidence":"low","customer_message":"","escalate_decision":{"should_escalate":true,"reason":"thin"},"channel_recommendation":{"channel":"ask-integrations","reason":""},"agent_steps":[],"findings_summary":{"diagnosis":"","actions":[]},"slack_refs":[],"atlassian_refs":[],"kb_refs":[],"sources_used":[]}'),
);
globalThis.fetch = passThroughFetch;
const cappedResult = await runPipeline({ rawQuery: 'still vague', role: 'csa', allowClarify: false });
assert(!cappedResult.clarifying_question, 'allowClarify:false does NOT return a clarifying question on low confidence (no re-ask loop)');
assert(cappedResult.issue_title === 'Best effort', 'clarification-capped low-confidence query still gets a best-effort answer');
assert(stepCounter === 3, 'capped path runs Interpreter + Evaluator + Answerer instead of shortcutting to clarify');

// Test E: low confidence with clarification allowed (initial turn) still asks once
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  anthropicMock('{"cleaned_question":"vague","intent":"unclear","entities":{"integration":null,"error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":null},"question_confidence":"low","clarifying_question":"Which integration?","search_plan":null}'),
);
globalThis.fetch = passThroughFetch;
const firstAskResult = await runPipeline({ rawQuery: 'vague', role: 'csa', allowClarify: true });
assert(firstAskResult.clarifying_question === 'Which integration?', 'allowClarify:true (initial turn) still asks exactly one clarifying question');
assert(stepCounter === 1, 'clarify shortcut still short-circuits before search when allowed');

// Test F: even if the ANSWERER emits a clarifying-question-only response, a capped
// follow-up must not re-ask — the pipeline strips it and coerces to best-effort.
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  anthropicMock('{"cleaned_question":"q","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"x"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"slack","priority":"high","query":"q"}],"rationale":"r"}}'),
  anthropicMock('{"sufficient":true,"rationale":"ok","refined_plan":null}'),
  anthropicMock('{"clarifying_question":"Is it the API or the webhook?"}'),
);
globalThis.fetch = passThroughFetch;
const answererClarifyCapped = await runPipeline({ rawQuery: 'follow up', role: 'csa', allowClarify: false });
assert(!answererClarifyCapped.clarifying_question, 'answerer clarifying-only is stripped when clarification is capped (no loop via the answerer stage)');
assert(answererClarifyCapped.issue_title === 'Not enough detail to resolve', 'capped answerer-clarify coerces to an escalate-style best-effort result');

globalThis.fetch = origFetchPipe;
delete process.env.ANTHROPIC_API_KEY;

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
