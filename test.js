/**
 * Local functionality test — exercises all core modules without
 * requiring Slack or Anthropic API connections.
 */

import { isAccountingTopic } from './src/utils/accounting-filter.js';
import {
  buildResponseBlocks,
  buildAutoAnswerBlocks,
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
import { escapeMrkdwn, safeSlackLink } from './src/slack/mrkdwn.js';
import { getCached, setCached, cacheStats, pruneExpired, deleteCache } from './src/slack/cache.js';
import { getHistory, appendToHistory, hasHistory, pruneConversations } from './src/slack/conversation.js';
import { parseClaudeResponse, summarizeResultForHistory } from './src/claude/prompts.js';
import { parseChatResponse } from './src/claude/query.js';
import { getRelevantFeedback, getAllFeedback, saveFeedback, approveFeedback, rejectFeedback, getPendingFeedback, notifyFeedbackChannel, _setFeedbackStorageForTest } from './src/slack/feedback.js';
import { handleFeedbackSubmission } from './src/slack/feedback-submission.js';
import { searchKnowledgeBase } from './src/claude/kb-search.js';
import { buildNominationBlocks, nominateResponse, approveNomination, rejectNomination, _setStoreForTest } from './src/slack/nominations.js';
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
import { rm, mkdtemp } from 'node:fs/promises';
import { deepEqual } from 'node:assert/strict';
import { buildChannelPostModal } from './src/slack/modal.js';
import {
  appendKbArticle,
  appendBotResponse,
  hasKbUrl,
  hasIssueTitle,
  _setKnowledgeWriterFailureForTest,
  _setKnowledgeWriterDefaultFileForTest,
} from './src/slack/knowledge-writer.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNewPipelineEnabled } from './src/utils/feature-flags.js';
import { searchSlackMessages } from './src/slack/search-client.js';
import { executeSearchPlan } from './src/claude/search-executor.js';
import { runAnswerer } from './src/claude/answerer.js';
import { classifySourceRef, filterRefsForRole } from './src/slack/source-policy.js';
import { handleQuery, registerMentionHandler, stripTransient, withRequestContext } from './src/handlers/mention.js';
import { shouldSkipMessage, verifyChannelAccess } from './src/handlers/auto-answer.js';
import { isQualityLayerEnabled, isQualityNominationPolicyEnabled, isQualityShadowMode, getQualityShadowRetention } from './src/quality/config.js';
import { sanitizePreview, hashValue, makeQualityId, normalizeForQuality } from './src/quality/privacy.js';
import { refToEvidence, scoreEvidenceSource, scoreEvidenceSources } from './src/quality/source-scoring.js';
import { buildAnswerEvidenceContract, isValidAnswerEvidenceContract } from './src/quality/evidence-contract.js';
import {
  evidenceByIdFirstWins,
  normalizeQualityEvidence,
  normalizeQualitySteps,
  sanitizeCountMap,
} from './src/quality/shadow-normalization.js';
import {
  CLAIM_TYPES,
  POLICY_BLOCKERS,
  POLICY_ELIGIBLE_REASONS,
  buildClaimCandidates,
  emptyEvidenceSummary,
  evaluateNominationEligibility,
  evaluateContractNominationPolicy,
  summarizeNominationPolicy,
} from './src/quality/nomination-policy.js';
import { appendQualityShadowRecord, _setQualityShadowFileForTest } from './src/quality/shadow-store.js';
import { appendQualityAuditEvent, _setQualityAuditFileForTest } from './src/quality/audit-log.js';
import { recordQualityShadow } from './src/quality/shadow-recorder.js';

let passed = 0;
let failed = 0;
const DANGEROUS_TEXT = 'A&B <@U123> <https://evil.test|click>';
const DANGEROUS_ESCAPED = 'A&amp;B &lt;@U123&gt; &lt;https://evil.test|click&gt;';

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

assert.deepEqual = (actual, expected, label) => {
  try {
    deepEqual(actual, expected);
    assert(true, label);
  } catch {
    assert(false, label);
  }
};

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

// ── Slack mrkdwn safety ──────────────────────────────────────────────────────
console.log('\n🔹 Slack mrkdwn safety');

assert(escapeMrkdwn(DANGEROUS_TEXT) === DANGEROUS_ESCAPED, 'escapeMrkdwn escapes Slack control chars');
assert(safeSlackLink('https://servicetitan.slack.com/archives/C123/p456', 'Safe <label>').includes('<https://servicetitan.slack.com/archives/C123/p456|Safe &lt;label&gt;'), 'safeSlackLink allows Slack host and escapes label');
assert(safeSlackLink('https://slack.com/archives/C123/p456', 'Slack') === 'Slack', 'safeSlackLink rejects non-ServiceTitan Slack host');
assert(safeSlackLink('https://evil.test/x', 'Bad <label>') === 'Bad &lt;label&gt;', 'safeSlackLink rejects unknown hosts');
assert(safeSlackLink('http://help.servicetitan.com/article', 'KB') === 'KB', 'safeSlackLink rejects non-HTTPS allowlisted hosts');
assert(safeSlackLink('not a url', 'Broken <label>') === 'Broken &lt;label&gt;', 'safeSlackLink rejects invalid URLs');

// ── Source sensitivity policy ────────────────────────────────────────────────
console.log('\n🔹 Source sensitivity policy');

const modelSensitive = classifySourceRef({ title: 'Normal', sensitive: true });
assert(modelSensitive.sensitive === true, 'source policy preserves model sensitive flag');
const backendSlack = classifySourceRef({ channel: '#backend-tools', title: 'Zapier fix' });
assert(backendSlack.sensitive === true, 'backend Slack channels are sensitive');
const incidentJira = classifySourceRef({ type: 'jira', title: 'INC-123 customer incident' });
assert(incidentJira.sensitive === true, 'incident-like Jira refs are sensitive');
const publicKb = classifySourceRef({ url: 'https://help.servicetitan.com/article', title: 'Public KB' });
assert(publicKb.sensitive !== true, 'KB host is not marked sensitive by default');
const sensitiveKb = classifySourceRef({ url: 'https://help.servicetitan.com/private', title: 'Customer incident runbook' });
assert(sensitiveKb.sensitive === true, 'KB refs with sensitive titles stay sensitive');
const spoofedKb = classifySourceRef({ url: 'https://evil.test/help.servicetitan.com/private', title: 'Customer incident runbook' });
assert(spoofedKb.sensitive === true, 'substring-spoofed KB URL does not bypass sensitivity checks');
const csaRefs = filterRefsForRole([backendSlack, publicKb], 'csa');
assert(csaRefs.length === 1 && csaRefs[0].title === 'Public KB', 'CSA refs filter sensitive refs');
const specialistRefs = filterRefsForRole([backendSlack, publicKb], 'specialist');
assert(specialistRefs.length === 2, 'Specialists see sensitive refs');

const dangerousResponseBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'low',
  escalate_decision: { should_escalate: true, reason: DANGEROUS_TEXT },
  channel_recommendation: { channel: DANGEROUS_TEXT, reason: DANGEROUS_TEXT },
  agent_steps: [{ num: 1, title: 'Safe title', detail: 'Safe detail', tag: DANGEROUS_TEXT }],
  sources_used: [DANGEROUS_TEXT],
});
const dangerousResponseJson = JSON.stringify(dangerousResponseBlocks);
assert(!dangerousResponseJson.includes(DANGEROUS_TEXT), 'response blocks escape dangerous sources, routing text, and step tags');
assert(dangerousResponseJson.includes(DANGEROUS_ESCAPED), 'response blocks keep escaped dangerous text visible');

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

const codeSensitiveBlocks = buildResponseBlocks({
  issue_title: 'Sensitive Source',
  confidence: 'high',
  customer_message: 'Hi [Name], done.',
  agent_steps: [],
  slack_refs: [
    { url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#backend-tools', title: 'Backend fix' },
  ],
  atlassian_refs: [],
  kb_refs: [],
  sources_used: ['slack'],
}, { role: 'csa' });
const codeSensitiveText = JSON.stringify(codeSensitiveBlocks);
assert(codeSensitiveText.includes('specialist-only'), 'CSA response indicates hidden specialist-only refs');
assert(!codeSensitiveText.includes('Diagnosis + Sources'), 'CSA response does not expose sources button for sensitive-only refs');

const kbSensitiveBlocks = buildResponseBlocks({
  issue_title: 'Sensitive KB Source',
  confidence: 'high',
  customer_message: 'Hi [Name], done.',
  agent_steps: [],
  slack_refs: [],
  atlassian_refs: [],
  kb_refs: [
    { url: 'https://help.servicetitan.com/private', title: 'Sensitive KB', sensitive: true },
  ],
  sources_used: ['kb'],
}, { role: 'csa' });
const kbSensitiveText = JSON.stringify(kbSensitiveBlocks);
assert(kbSensitiveText.includes('specialist-only'), 'CSA response indicates hidden specialist-only KB refs');
assert(!kbSensitiveText.includes('Diagnosis + Sources'), 'CSA response does not expose sources button for sensitive-only KB refs');

const kbSensitiveSpecialistBlocks = buildResponseBlocks({
  issue_title: 'Sensitive KB Source',
  confidence: 'high',
  customer_message: 'Hi [Name], done.',
  agent_steps: [],
  slack_refs: [],
  atlassian_refs: [],
  kb_refs: [
    { url: 'https://help.servicetitan.com/private', title: 'Sensitive KB', sensitive: true },
  ],
  sources_used: ['kb'],
}, { role: 'specialist' });
const kbSensitiveSpecialistText = JSON.stringify(kbSensitiveSpecialistBlocks);
assert(kbSensitiveSpecialistText.includes('Diagnosis + Sources'), 'Specialist response still exposes sensitive KB refs');

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

process.env.FEEDBACK_REVIEW_CHANNEL_ID = 'C_REVIEW';
let postedFeedbackReviewBlocks = null;
await notifyFeedbackChannel(
  {
    chat: {
      postMessage: async ({ blocks }) => {
        postedFeedbackReviewBlocks = blocks;
        return { ts: '123.456' };
      },
    },
  },
  {
    id: 'fb_escape_001',
    timestamp: '2026-07-06T12:00:00.000Z',
    query: 'query text',
    issueTitle: 'Issue title',
    integrationType: '<#C123>&bad',
    feedbackType: 'wrong_answer',
    correction: 'correct this',
    agentId: 'U12345',
    agentName: 'Test Agent',
  },
);
const postedFeedbackReviewJson = JSON.stringify(postedFeedbackReviewBlocks);
assert(postedFeedbackReviewJson.includes('&lt;#C123&gt;&amp;bad'), 'feedback review card escapes integrationType in mrkdwn');
assert(!postedFeedbackReviewJson.includes('<#C123>&bad'), 'feedback review card does not include raw integrationType control chars');

// ── feedback persistence failures ───────────────────────────────────────────

const feedbackTempDir = await mkdtemp(join(tmpdir(), 'intbot-feedback-'));
_setFeedbackStorageForTest({ dir: feedbackTempDir });
const feedbackToApprove = await saveFeedback({
  query: 'Zapier broken',
  issueTitle: 'Zapier',
  integrationType: 'Zapier',
  feedbackType: 'wrong_answer',
  correction: 'Correct it',
  agentId: 'U_AGENT',
  agentName: 'Agent',
});
const pendingBeforeFailure = await getPendingFeedback();
assert(pendingBeforeFailure.length === 1, 'feedback test setup has one pending entry');
const activeBeforeFailure = await getAllFeedback();
assert(activeBeforeFailure.length === 0, 'feedback failure test setup has empty active cache');

await rm(feedbackTempDir, { recursive: true, force: true });
await writeFile(feedbackTempDir, 'not a directory');
let saveRejected = false;
try {
  await saveFeedback({
    query: 'RwG broken',
    issueTitle: 'RwG',
    integrationType: 'RwG',
    feedbackType: 'wrong_answer',
    correction: 'Correct it',
    agentId: 'U_AGENT',
    agentName: 'Agent',
  });
} catch {
  saveRejected = true;
}
assert(saveRejected, 'saveFeedback rejects when pending write fails');
const pendingAfterFailedSave = await getPendingFeedback();
assert(pendingAfterFailedSave.length === 1, 'failed save leaves pending count unchanged');
assert(!pendingAfterFailedSave.some((e) => e.query === 'RwG broken'), 'failed save does not leak new entry into pending cache');

let approveRejected = false;
try {
  await approveFeedback(feedbackToApprove.id);
} catch {
  approveRejected = true;
}
assert(approveRejected, 'approveFeedback rejects when active/pending read or write fails');
const pendingAfterFailedApprove = await getPendingFeedback();
assert(pendingAfterFailedApprove.length === 1, 'failed approve leaves pending count unchanged');
assert(pendingAfterFailedApprove.some((e) => e.id === feedbackToApprove.id), 'failed approve keeps record pending in cache');
const activeAfterFailedApprove = await getAllFeedback();
assert(activeAfterFailedApprove.length === 0, 'failed approve leaves active count unchanged');
assert(!activeAfterFailedApprove.some((e) => e.id === feedbackToApprove.id), 'failed approve does not leak record into active cache');

const feedbackRejectDir = await mkdtemp(join(tmpdir(), 'intbot-feedback-reject-'));
_setFeedbackStorageForTest({ dir: feedbackRejectDir });
const feedbackToReject = await saveFeedback({
  query: 'Angi broken',
  issueTitle: 'Angi',
  integrationType: 'Angi',
  feedbackType: 'wrong_answer',
  correction: 'Correct it',
  agentId: 'U_AGENT',
  agentName: 'Agent',
});
await rm(feedbackRejectDir, { recursive: true, force: true });
await writeFile(feedbackRejectDir, 'not a directory');
let rejectRejected = false;
try {
  await rejectFeedback(feedbackToReject.id);
} catch {
  rejectRejected = true;
}
assert(rejectRejected, 'rejectFeedback rejects when pending write fails');
const pendingAfterFailedReject = await getPendingFeedback();
assert(pendingAfterFailedReject.length === 1, 'failed reject leaves pending count unchanged');
assert(pendingAfterFailedReject.some((e) => e.id === feedbackToReject.id), 'failed reject keeps record pending in cache');

_setFeedbackStorageForTest({ dir: join(process.cwd(), 'data') });
await rm(feedbackTempDir, { force: true });
await rm(feedbackRejectDir, { force: true });

const feedbackSubmissionCalls = [];
const feedbackSubmissionResult = await handleFeedbackSubmission({
  body: { user: { id: 'U_SUBMIT', name: 'Submitter' } },
  view: {
    private_metadata: JSON.stringify({
      query: 'Dangerous query',
      issueTitle: 'Dangerous issue',
      integrationType: 'Dangerous integration',
    }),
    state: {
      values: {
        feedback_type_block: { feedback_type_select: { selected_option: { value: 'wrong_answer' } } },
        correction_block: { correction_input: { value: 'Correct answer' } },
      },
    },
  },
  client: {
    chat: {
      postMessage: async (payload) => {
        feedbackSubmissionCalls.push(['chat.postMessage', payload]);
        return {};
      },
    },
  },
  logger: {
    error: (...args) => feedbackSubmissionCalls.push(['error', args]),
    warn: (...args) => feedbackSubmissionCalls.push(['warn', args]),
    info: (...args) => feedbackSubmissionCalls.push(['info', args]),
  },
  deps: {
    saveFeedback: async () => {
      throw new Error('disk full');
    },
    notifyFeedbackChannel: async () => {
      feedbackSubmissionCalls.push(['notifyFeedbackChannel']);
    },
  },
});
assert(feedbackSubmissionResult.status === 'save_failed', 'feedback submission helper returns save_failed when persistence fails');
assert(feedbackSubmissionCalls.some(([kind]) => kind === 'error'), 'feedback submission helper logs save failure context');
assert(!feedbackSubmissionCalls.some(([kind]) => kind === 'notifyFeedbackChannel'), 'feedback submission helper skips review notification when save fails');
const failedSaveDm = feedbackSubmissionCalls.find(([kind, payload]) => kind === 'chat.postMessage' && payload.channel === 'U_SUBMIT');
assert(failedSaveDm?.[1]?.text?.includes("couldn't save your feedback"), 'feedback submission helper DMs controlled save failure message');
assert(feedbackSubmissionCalls.filter(([kind]) => kind === 'chat.postMessage').length === 1, 'feedback submission helper skips success confirmation when save fails');

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

const unsafeSourcesModal = buildSourcesModal({
  slack_refs: [{ url: 'https://evil.test/x', title: '<@U123> click', channel: '<#C123>' }],
});
const unsafeSourcesText = JSON.stringify(unsafeSourcesModal);
assert(!unsafeSourcesText.includes('<https://evil.test'), 'unsafe source URL is not rendered as clickable Slack link');
assert(unsafeSourcesText.includes('&lt;@U123&gt;'), 'unsafe source title is escaped');
assert(unsafeSourcesText.includes('&lt;#C123&gt;'), 'unsafe source channel is escaped');

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

// — nomination approval preserves pending state when knowledge write fails —
const nomFailFile = join(tmpdir(), `intbot-nominations-${Date.now()}.json`);
const nomFailKb = join(tmpdir(), `intbot-knowledge-${Date.now()}.md`);
_setStoreForTest(nomFailFile);
_setKnowledgeWriterDefaultFileForTest(nomFailKb);
const nomFailClient = { chat: { postMessage: async () => ({ ts: '222.333' }), update: async () => ({}) } };
const failingNomination = await nominateResponse(nomFailClient, {
  integration: 'Zapier',
  issueTitle: 'Write Failure Nomination',
  steps: ['Do the thing'],
  refs: ['Slack thread'],
});
_setKnowledgeWriterFailureForTest(true);
let nominationRejected = false;
try {
  await approveNomination(failingNomination.id, nomFailClient, 'Reviewer');
} catch {
  nominationRejected = true;
}
_setKnowledgeWriterFailureForTest(false);
assert(nominationRejected, 'approveNomination rejects when knowledge write fails');
const stillPending = await approveNomination(failingNomination.id, nomFailClient, 'Reviewer');
assert(stillPending?.id === failingNomination.id, 'nomination remains pending after failed knowledge write');
_setKnowledgeWriterDefaultFileForTest(null);
await rm(nomFailFile, { force: true });
await rm(nomFailKb, { force: true });

// — duplicate nomination approval succeeds and clears pending state —
const nomDupFile = join(tmpdir(), `intbot-nominations-dup-${Date.now()}.json`);
const nomDupKb = join(tmpdir(), `intbot-knowledge-dup-${Date.now()}.md`);
_setStoreForTest(nomDupFile);
_setKnowledgeWriterDefaultFileForTest(nomDupKb);
await appendBotResponse('Zapier', 'Duplicate Nomination', ['Existing step'], [], nomDupKb, null);
const nomDupClient = { chat: { postMessage: async () => ({ ts: '333.444' }), update: async () => ({}) } };
const duplicateNomination = await nominateResponse(nomDupClient, {
  integration: 'Zapier',
  issueTitle: 'Duplicate Nomination',
  steps: ['New step that should be skipped as duplicate'],
  refs: ['Slack thread'],
});
const duplicateApproved = await approveNomination(duplicateNomination.id, nomDupClient, 'Reviewer');
assert(duplicateApproved?.id === duplicateNomination.id, 'approveNomination succeeds for duplicate knowledge title');
_setStoreForTest(nomDupFile);
const duplicateGoneAfter = await approveNomination(duplicateNomination.id, nomDupClient, 'Reviewer');
assert(duplicateGoneAfter === null, 'duplicate nomination approval clears pending state');
_setKnowledgeWriterDefaultFileForTest(null);
await rm(nomDupFile, { force: true });
await rm(nomDupKb, { force: true });

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

const feedbackActionCalls = [];
let approvedFeedbackId = null;
const authorizedFeedbackResult = await handleFeedbackReviewAction({
  decision: 'approve',
  feedbackId: 'fb_2',
  body: { user: { id: 'U2', name: 'Fallback Reviewer' }, channel: { id: 'C_REVIEW' } },
  client: {
    users: {
      info: async ({ user }) => {
        feedbackActionCalls.push(['users.info', user]);
        return { user: { profile: { display_name: 'Mod Display' } } };
      },
    },
    chat: {
      update: async (payload) => {
        feedbackActionCalls.push(['chat.update', payload]);
        return {};
      },
      postMessage: async (payload) => {
        feedbackActionCalls.push(['chat.postMessage', payload]);
        return {};
      },
    },
  },
  respond: async () => {
    feedbackActionCalls.push(['respond']);
  },
  logger: {
    warn: (...args) => feedbackActionCalls.push(['warn', args]),
    info: (...args) => feedbackActionCalls.push(['info', args]),
  },
  env: modEnv,
  deps: {
    approveFeedback: async (feedbackId) => {
      approvedFeedbackId = feedbackId;
      return {
        id: feedbackId,
        issueTitle: 'Broken sync',
        agentId: 'U_AGENT',
        reviewMessageTs: '111.222',
        reviewChannelId: 'C_REVIEW',
      };
    },
    rejectFeedback: async () => {
      throw new Error('should not run');
    },
  },
});
assert(approvedFeedbackId === 'fb_2', 'authorized feedback action passes feedback id to approveFeedback');
assert(authorizedFeedbackResult.status === 'approved', 'authorized feedback action returns approved');
assert(feedbackActionCalls.some(([kind, value]) => kind === 'users.info' && value === 'U2'), 'authorized feedback action resolves reviewer profile');
const feedbackUpdateCall = feedbackActionCalls.find(([kind]) => kind === 'chat.update');
assert(feedbackUpdateCall?.[1]?.text === '✅ Approved by Mod Display', 'authorized feedback action updates review card with reviewer display name');
assert(feedbackUpdateCall?.[1]?.blocks?.[0]?.text?.text?.includes('Approved by Mod Display'), 'authorized feedback action uses reviewer display name in review card block');
const feedbackDmCall = feedbackActionCalls.find(([kind, value]) => kind === 'chat.postMessage' && value.channel === 'U_AGENT');
assert(feedbackDmCall?.[1]?.text?.includes('Broken sync'), 'authorized feedback action DMs the submitting agent');
assert(feedbackActionCalls.some(([kind, args]) => kind === 'info' && args[0].includes('Mod Display')), 'authorized feedback action logs resolved reviewer name');

const dangerousFeedbackCalls = [];
await handleFeedbackReviewAction({
  decision: 'approve',
  feedbackId: 'fb_danger',
  body: { user: { id: 'U2', name: 'Fallback Reviewer' }, channel: { id: 'C_REVIEW' } },
  client: {
    users: {
      info: async () => ({ user: { profile: { display_name: DANGEROUS_TEXT } } }),
    },
    chat: {
      update: async (payload) => {
        dangerousFeedbackCalls.push(['chat.update', payload]);
        return {};
      },
      postMessage: async (payload) => {
        dangerousFeedbackCalls.push(['chat.postMessage', payload]);
        return {};
      },
    },
  },
  respond: async () => {},
  logger: { warn: () => {}, info: () => {} },
  env: modEnv,
  deps: {
    approveFeedback: async () => ({
      id: 'fb_danger',
      issueTitle: DANGEROUS_TEXT,
      agentId: 'U_AGENT',
      reviewMessageTs: '123.456',
      reviewChannelId: 'C_REVIEW',
    }),
    rejectFeedback: async () => {
      throw new Error('should not run');
    },
  },
});
const dangerousFeedbackJson = JSON.stringify(dangerousFeedbackCalls);
assert(!dangerousFeedbackJson.includes(DANGEROUS_TEXT), 'feedback review action updates and DMs escape dangerous reviewer and title text');
assert(dangerousFeedbackJson.includes(DANGEROUS_ESCAPED), 'feedback review action keeps escaped dangerous text visible');

const nominationActionCalls = [];
const nominationApproveCalls = [];
const authorizedNominationResult = await handleNominationReviewAction({
  decision: 'approve',
  nominationId: 'nom_2',
  body: { user: { id: 'U2', name: 'Fallback Reviewer' }, channel: { id: 'C_REVIEW' } },
  client: {
    users: {
      info: async ({ user }) => {
        nominationActionCalls.push(['users.info', user]);
        return { user: { profile: { display_name: 'Nom Mod' } } };
      },
    },
    chat: {
      update: async (payload) => {
        nominationActionCalls.push(['chat.update', payload]);
        return {};
      },
    },
  },
  respond: async () => {
    nominationActionCalls.push(['respond']);
  },
  logger: {
    warn: (...args) => nominationActionCalls.push(['warn', args]),
    info: (...args) => nominationActionCalls.push(['info', args]),
  },
  env: modEnv,
  deps: {
    approveNomination: async (...args) => {
      nominationApproveCalls.push(args);
      nominationActionCalls.push(['approveNomination', args]);
      return { id: 'nom_2', integration: 'Zapier', issueTitle: 'Broken auth' };
    },
    rejectNomination: async () => {
      throw new Error('should not run');
    },
  },
});
assert(nominationApproveCalls.length === 1, 'authorized nomination action calls approveNomination once');
assert(nominationApproveCalls[0][0] === 'nom_2', 'authorized nomination action passes nomination id to approveNomination');
assert(nominationApproveCalls[0][1] && nominationApproveCalls[0][1].users, 'authorized nomination action passes the Slack client to approveNomination');
assert(nominationApproveCalls[0][2] === 'Nom Mod', 'authorized nomination action passes resolved reviewer name to approveNomination');
assert(authorizedNominationResult.status === 'approved', 'authorized nomination action returns approved');
assert(nominationActionCalls.some(([kind, value]) => kind === 'users.info' && value === 'U2'), 'authorized nomination action resolves reviewer profile');

process.env.FEEDBACK_REVIEW_CHANNEL_ID = 'C_REVIEW';
const nominationEscapeFile = join(tmpdir(), `intbot-nominations-escape-${Date.now()}.json`);
const nominationEscapeKb = join(tmpdir(), `intbot-knowledge-escape-${Date.now()}.md`);
const nominationUpdateCalls = [];
_setStoreForTest(nominationEscapeFile);
_setKnowledgeWriterDefaultFileForTest(nominationEscapeKb);
const nominationEscapeClient = {
  chat: {
    postMessage: async () => ({ ts: '444.555' }),
    update: async (payload) => {
      nominationUpdateCalls.push(payload);
      return {};
    },
  },
};
const nominationForApprove = await nominateResponse(nominationEscapeClient, {
  integration: DANGEROUS_TEXT,
  issueTitle: DANGEROUS_TEXT,
  steps: ['Do the safe thing'],
  refs: [DANGEROUS_TEXT],
});
await approveNomination(nominationForApprove.id, nominationEscapeClient, DANGEROUS_TEXT);
const approvedNominationJson = JSON.stringify(nominationUpdateCalls.at(-1));
assert(!approvedNominationJson.includes(DANGEROUS_TEXT), 'approveNomination review update escapes dangerous reviewer and nomination text');
assert(approvedNominationJson.includes(DANGEROUS_ESCAPED), 'approveNomination keeps escaped dangerous text visible');

const nominationForReject = await nominateResponse(nominationEscapeClient, {
  integration: DANGEROUS_TEXT,
  issueTitle: DANGEROUS_TEXT,
  steps: ['Do the safe thing'],
  refs: [DANGEROUS_TEXT],
});
await rejectNomination(nominationForReject.id, nominationEscapeClient, DANGEROUS_TEXT);
const rejectedNominationJson = JSON.stringify(nominationUpdateCalls.at(-1));
assert(!rejectedNominationJson.includes(DANGEROUS_TEXT), 'rejectNomination review update escapes dangerous reviewer and nomination text');
assert(rejectedNominationJson.includes(DANGEROUS_ESCAPED), 'rejectNomination keeps escaped dangerous text visible');
_setKnowledgeWriterDefaultFileForTest(null);
await rm(nominationEscapeFile, { force: true });
await rm(nominationEscapeKb, { force: true });
_setStoreForTest(join(process.cwd(), 'data', 'nominations-pending.json'));
delete process.env.FEEDBACK_REVIEW_CHANNEL_ID;

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

const dangerousChatBlocks = buildChatResolutionBlocks({
  title: DANGEROUS_TEXT,
  diagnosis: DANGEROUS_TEXT,
  steps: [{ tag: DANGEROUS_TEXT, text: DANGEROUS_TEXT }],
  escalate: true,
  escalation_path: DANGEROUS_TEXT,
  suggested_channel_post: 'Escalate this.',
  refs: [{ source: 'kb', title: 'KB ref' }],
});
const dangerousChatJson = JSON.stringify(dangerousChatBlocks);
assert(!dangerousChatJson.includes(DANGEROUS_TEXT), 'chat resolution blocks escape dangerous mrkdwn fields');
assert(dangerousChatJson.includes(DANGEROUS_ESCAPED), 'chat resolution blocks keep escaped dangerous text visible');

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

const dangerousProgress = buildProgressBlocks(DANGEROUS_TEXT, [{ tool: 'slack', phase: 'tool_start', count: null }]);
const dangerousProgressJson = JSON.stringify(dangerousProgress);
assert(!dangerousProgressJson.includes(DANGEROUS_TEXT), 'progress blocks escape the live Slack query text');
assert(dangerousProgressJson.includes(DANGEROUS_ESCAPED), 'progress blocks preserve escaped query text');

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

// ── auto-answer ───────────────────────────────────────────────────────────────
console.log('\n🔹 auto-answer');

process.env.AUTO_ANSWER_SOURCE_CHANNEL = 'C_ASK_INTEGRATIONS';
process.env.AUTO_ANSWER_TARGET_CHANNEL = 'C_BOT_DRAFTS';

const procTs = new Set();

// — filter rules —
assert(shouldSkipMessage(null, { processedTs: procTs }) === true, 'null event is skipped');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '1.0', text: 'hello world here' }, { processedTs: procTs }) === false, 'plain top-level msg passes');
assert(shouldSkipMessage({ channel: 'C_OTHER', ts: '2.0', text: 'hello world here' }, { processedTs: procTs }) === true, 'wrong channel skipped');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '3.0', text: 'short' }, { processedTs: procTs }) === true, 'too-short text skipped');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '4.0', text: 'hello world here', subtype: 'message_changed' }, { processedTs: procTs }) === true, 'edited msg skipped');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '5.0', text: 'hello world here', subtype: 'bot_message' }, { processedTs: procTs }) === true, 'bot_message subtype skipped');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '6.0', text: 'hello world here', bot_id: 'B123' }, { processedTs: procTs }) === true, 'bot_id present skipped');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '7.0', thread_ts: '6.5', text: 'hello world here' }, { processedTs: procTs }) === true, 'thread reply skipped');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '8.0', thread_ts: '8.0', text: 'hello world here' }, { processedTs: procTs }) === false, 'thread parent (thread_ts === ts) passes');

procTs.add('9.0');
assert(shouldSkipMessage({ channel: 'C_ASK_INTEGRATIONS', ts: '9.0', text: 'hello world here' }, { processedTs: procTs }) === true, 'already-processed ts deduped');

// — block-kit shape —
const sampleResult = {
  issue_title: 'Zapier API access',
  confidence: 'high',
  customer_message: 'Hi customer, here is the fix.',
  findings_summary: { diagnosis: 'API access disabled at backend.' },
  agent_steps: [
    { num: 1, title: 'Enable API access', detail: 'Toggle in admin settings.', tag: 'action' },
    { num: 2, title: 'Verify token', detail: 'Reissue if needed.', tag: 'verify' },
  ],
  sources_used: ['slack', 'kb'],
};
const aaBlocks = buildAutoAnswerBlocks({
  originalUrl: 'https://servicetitan.slack.com/archives/C_ASK_INTEGRATIONS/p123',
  sourceChannelId: 'C_ASK_INTEGRATIONS',
  originalUserId: 'U999',
  query: 'Customer says Zapier broke after migration',
  result: sampleResult,
});
assert(Array.isArray(aaBlocks), 'buildAutoAnswerBlocks returns array');
assert(aaBlocks.length > 0 && aaBlocks.length < 50, 'block count is within Slack 50-block limit');
const firstCtx = JSON.stringify(aaBlocks[0]);
assert(firstCtx.includes('View original') && firstCtx.includes('U999') && firstCtx.includes('C_ASK_INTEGRATIONS'), 'first block has link, author, and source channel');
const allText = JSON.stringify(aaBlocks);
assert(allText.includes('Zapier API access'), 'issue title rendered');
assert(allText.includes('Diagnosis'), 'diagnosis section rendered');
assert(allText.includes('Draft email'), 'customer_message section rendered');
assert(allText.includes('Suggested steps'), 'steps section rendered');
assert(allText.includes('Enable API access'), 'first step rendered');
assert(allText.includes('High confidence'), 'confidence rendered');
assert(allText.includes('`slack`') && allText.includes('`kb`'), 'sources_used chips rendered');

const dangerousAutoAnswerBlocks = buildAutoAnswerBlocks({
  query: DANGEROUS_TEXT,
  result: {
    confidence: 'medium',
    issue_title: 'Safe title',
    sources_used: [DANGEROUS_TEXT],
  },
});
const dangerousAutoAnswerJson = JSON.stringify(dangerousAutoAnswerBlocks);
assert(!dangerousAutoAnswerJson.includes(DANGEROUS_TEXT), 'auto-answer blocks escape dangerous source chips and mrkdwn text');
assert(dangerousAutoAnswerJson.includes(DANGEROUS_ESCAPED), 'auto-answer blocks keep escaped dangerous text visible');

// graceful with missing fields
const minimalBlocks = buildAutoAnswerBlocks({
  query: 'q',
  result: { confidence: 'low' },
});
assert(Array.isArray(minimalBlocks) && minimalBlocks.length >= 2, 'works with minimal result object (no crash)');

// — auto-answer docs/config expectations —
const readmeText = await readFile('README.md', 'utf-8');
const envExampleText = await readFile('.env.example', 'utf-8');
assert(readmeText.includes('message.channels'), 'README documents message.channels for auto-answer');
assert(readmeText.includes('channels:read'), 'README documents channels:read for auto-answer');
assert(readmeText.includes('channels:history'), 'README documents channels:history for auto-answer');
assert(envExampleText.includes('AUTO_ANSWER_ENABLED=false'), '.env.example keeps auto-answer disabled by default');

// — startup self-check (verifyChannelAccess): turns silent failure into a loud warning —
function makeLogger() {
  const warns = [];
  const infos = [];
  return { warn: (m) => warns.push(m), info: (m) => infos.push(m), warns, infos };
}

const memberLog = makeLogger();
await verifyChannelAccess(
  { conversations: { info: async () => ({ ok: true, channel: { is_member: true } }) } },
  'C_SRC', memberLog,
);
assert(memberLog.warns.length === 0 && memberLog.infos.some((m) => m.includes('access verified')), 'member channel verifies with no warning');

const notMemberLog = makeLogger();
await verifyChannelAccess(
  { conversations: { info: async () => ({ ok: true, channel: { is_member: false } }) } },
  'C_SRC', notMemberLog,
);
assert(notMemberLog.warns.some((m) => m.includes('NOT a member')), 'non-member channel warns to invite the bot');

const scopeLog = makeLogger();
await verifyChannelAccess(
  { conversations: { info: async () => { const e = new Error('missing_scope'); e.data = { error: 'missing_scope', needed: 'channels:history' }; throw e; } } },
  'C_SRC', scopeLog,
);
assert(scopeLog.warns.some((m) => m.includes('channels:history')), 'missing_scope names the needed scope');

const missingScopeLog = makeLogger();
await verifyChannelAccess(
  { conversations: { info: async () => { const e = new Error('missing_scope'); e.data = { error: 'missing_scope', needed: 'channels:read' }; throw e; } } },
  'C_SRC',
  missingScopeLog,
);
assert(missingScopeLog.warns.some((m) => m.includes('message.channels')), 'auto-answer missing-scope warning mentions message.channels event setup');

const notFoundLog = makeLogger();
await verifyChannelAccess(
  { conversations: { info: async () => { const e = new Error('channel_not_found'); e.data = { error: 'channel_not_found' }; throw e; } } },
  'BADID', notFoundLog,
);
assert(notFoundLog.warns.some((m) => m.includes('not found')), 'channel_not_found warns about bad channel ID');

delete process.env.AUTO_ANSWER_SOURCE_CHANNEL;
delete process.env.AUTO_ANSWER_TARGET_CHANNEL;

// ── mention handler event-boundary catch ─────────────────────────────────────
console.log('\n🔹 mention handler event-boundary catch');

let mentionCallback;
const mentionPosts = [];
const mentionLogs = [];
registerMentionHandler({
  event: (_name, cb) => { mentionCallback = cb; },
}, {
  dedupeTtlMs: 0,
  queryHandler: async () => { throw new Error('forced handler failure'); },
});
await mentionCallback({
  event: { channel: 'C123', user: 'U123', ts: '123.456', text: '<@UBOT> Zapier broken' },
  body: { event_id: 'Ev123' },
  client: { chat: { postMessage: async (payload) => { mentionPosts.push(payload); } } },
  logger: { warn: (m) => mentionLogs.push(m), error: (m) => mentionLogs.push(m), info: () => {} },
});
assert(mentionPosts.length === 1, 'mention top-level catch posts fallback');
assert(mentionPosts[0].thread_ts === '123.456', 'mention fallback posts in the request thread');
assert(JSON.stringify(mentionLogs).includes('unhandled failure'), 'mention top-level catch logs failure');

// ── quality config/privacy ───────────────────────────────────────────────────
console.log('\n🔹 quality config/privacy');

const originalQualityEnv = {
  QUALITY_LAYER_ENABLED: process.env.QUALITY_LAYER_ENABLED,
  QUALITY_NOMINATION_POLICY_ENABLED: process.env.QUALITY_NOMINATION_POLICY_ENABLED,
  QUALITY_LAYER_SHADOW_MODE: process.env.QUALITY_LAYER_SHADOW_MODE,
  QUALITY_SHADOW_MAX_RECORDS: process.env.QUALITY_SHADOW_MAX_RECORDS,
  QUALITY_SHADOW_MAX_AGE_DAYS: process.env.QUALITY_SHADOW_MAX_AGE_DAYS,
  QUALITY_SHADOW_MAX_BYTES: process.env.QUALITY_SHADOW_MAX_BYTES,
};

delete process.env.QUALITY_LAYER_ENABLED;
delete process.env.QUALITY_NOMINATION_POLICY_ENABLED;
delete process.env.QUALITY_LAYER_SHADOW_MODE;
delete process.env.QUALITY_SHADOW_MAX_RECORDS;
delete process.env.QUALITY_SHADOW_MAX_AGE_DAYS;
delete process.env.QUALITY_SHADOW_MAX_BYTES;

assert(isQualityLayerEnabled() === false, 'quality layer defaults disabled');
assert(isQualityNominationPolicyEnabled() === false, 'quality nomination policy defaults disabled');
assert(isQualityShadowMode() === true, 'quality shadow mode defaults true');
assert.deepEqual(getQualityShadowRetention(), {
  maxRecords: 2000,
  maxAgeDays: 14,
  maxBytes: 5 * 1024 * 1024,
}, 'quality shadow retention defaults are fixed');

for (const disabledValue of ['', 'false', '0', 'off', 'definitely']) {
  process.env.QUALITY_LAYER_ENABLED = disabledValue;
  assert(isQualityLayerEnabled() === false, `QUALITY_LAYER_ENABLED=${JSON.stringify(disabledValue)} keeps quality layer disabled`);
  process.env.QUALITY_NOMINATION_POLICY_ENABLED = disabledValue;
  assert(isQualityNominationPolicyEnabled() === false, `QUALITY_NOMINATION_POLICY_ENABLED=${JSON.stringify(disabledValue)} keeps nomination policy disabled`);
}

process.env.QUALITY_LAYER_ENABLED = 'true';
process.env.QUALITY_NOMINATION_POLICY_ENABLED = 'true';
process.env.QUALITY_LAYER_SHADOW_MODE = 'false';
process.env.QUALITY_SHADOW_MAX_RECORDS = '3';
process.env.QUALITY_SHADOW_MAX_AGE_DAYS = '2';
process.env.QUALITY_SHADOW_MAX_BYTES = '1000';

assert(isQualityLayerEnabled() === true, 'QUALITY_LAYER_ENABLED=true enables quality layer');
assert(isQualityNominationPolicyEnabled() === true, 'QUALITY_NOMINATION_POLICY_ENABLED=true enables nomination policy');
process.env.QUALITY_LAYER_ENABLED = 'TRUE';
process.env.QUALITY_NOMINATION_POLICY_ENABLED = 'TRUE';
assert(isQualityLayerEnabled() === true, 'QUALITY_LAYER_ENABLED=TRUE enables quality layer');
assert(isQualityNominationPolicyEnabled() === true, 'QUALITY_NOMINATION_POLICY_ENABLED=TRUE enables nomination policy');
assert(isQualityShadowMode() === false, 'QUALITY_LAYER_SHADOW_MODE=false disables shadow mode');
assert.deepEqual(getQualityShadowRetention(), {
  maxRecords: 3,
  maxAgeDays: 2,
  maxBytes: 1000,
}, 'quality shadow retention reads env overrides');

for (const [key, value] of Object.entries(originalQualityEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

assert(sanitizePreview('  hello\nworld  ', 20) === 'hello world', 'sanitizePreview collapses whitespace');
assert(sanitizePreview('secret '.repeat(50), 30).length <= 30, 'sanitizePreview clamps long text');
assert(!sanitizePreview('xoxb-1234567890-secret').includes('xoxb-1234567890-secret'), 'sanitizePreview redacts Slack-like tokens');
assert(hashValue('same input') === hashValue('same input'), 'hashValue is stable');
assert(hashValue('same input') !== hashValue('different input'), 'hashValue changes with input');
assert(makeQualityId('ans', new Date('2026-07-09T00:00:00.000Z')).startsWith('ans_20260709T000000000Z_'), 'makeQualityId includes prefix and timestamp');
assert(normalizeForQuality(' Zapier API   Access! ') === 'zapier api access', 'normalizeForQuality lowercases and strips punctuation');

// ── quality source scoring ───────────────────────────────────────────────────
console.log('\n🔹 quality source scoring');

const directConfluenceEvidence = refToEvidence({
  type: 'confluence',
  url: 'https://servicetitan.atlassian.net/wiki/spaces/INT/pages/1',
  title: 'Zapier API access setup',
  snippet: 'Enable Zapier API access for the tenant.',
}, {
  source: 'confluence',
  query: 'Zapier API access disabled',
  integrationType: 'Zapier',
  issueTitle: 'Zapier API access',
});

assert(directConfluenceEvidence.source === 'confluence', 'refToEvidence keeps confluence source');
assert(directConfluenceEvidence.title === 'Zapier API access setup', 'refToEvidence keeps sanitized source title');
assert(directConfluenceEvidence.snippetPreview.includes('Enable Zapier API access'), 'refToEvidence stores snippet preview only');
assert(directConfluenceEvidence.url === undefined, 'refToEvidence does not store raw source URL');
assert(directConfluenceEvidence.urlHash.startsWith('sha256:'), 'refToEvidence stores URL hash');

const directScore = scoreEvidenceSource(directConfluenceEvidence, {
  query: 'Zapier API access disabled',
  integrationType: 'Zapier',
  issueTitle: 'Zapier API access',
});
assert(directScore.sourceQuality === 'high', 'direct confluence source quality high');
assert(directScore.directness === 'direct', 'exact integration and symptom is direct');
assert(directScore.reuseValue === 'high', 'setup source has high reuse value');
assert(directScore.sensitivity === 'safe', 'safe confluence source is safe');

const tenantJiraEvidence = refToEvidence({
  type: 'jira',
  url: 'https://servicetitan.atlassian.net/browse/INT-123',
  title: 'INT-123 Tenant 12345 Zapier outage',
  snippet: 'Resolved for tenant 12345 only.',
}, {
  source: 'jira',
  query: 'Zapier outage tenant 12345',
  integrationType: 'Zapier',
  issueTitle: 'Zapier outage',
});
const tenantScore = scoreEvidenceSource(tenantJiraEvidence, {
  query: 'Zapier outage tenant 12345',
  integrationType: 'Zapier',
  issueTitle: 'Zapier outage',
});
assert(tenantScore.sourceQuality === 'high', 'tenant-specific resolved Jira can be high quality');
assert(tenantScore.reuseValue === 'low', 'tenant-specific Jira has low reuse value');

const sensitiveEvidence = refToEvidence({
  type: 'jira',
  url: 'https://servicetitan.atlassian.net/browse/SEC-1',
  title: 'Security incident backend-only token rotation',
}, {
  source: 'jira',
  query: 'token issue',
  integrationType: 'Zapier',
  issueTitle: 'Token issue',
});
const sensitiveScore = scoreEvidenceSource(sensitiveEvidence, {
  query: 'token issue',
  integrationType: 'Zapier',
  issueTitle: 'Token issue',
});
assert(sensitiveScore.sensitivity === 'specialist_only', 'source scoring preserves source-policy sensitivity');

const unclassifiedSensitiveScore = scoreEvidenceSource({
  id: 'ev_unclassified',
  source: 'jira',
  url: 'https://servicetitan.atlassian.net/browse/SEC-1?token=secret',
  title: 'Security incident backend-only token rotation',
  snippetPreview: '',
}, {
  query: 'token issue',
  integrationType: 'Zapier',
  issueTitle: 'Token issue',
});
assert(unclassifiedSensitiveScore.sensitivity === 'specialist_only', 'source scoring applies source-policy to unclassified evidence-like inputs');
assert(unclassifiedSensitiveScore.url === undefined, 'source scoring strips raw URL from prebuilt evidence-like inputs');

const scoredSources = scoreEvidenceSources({
  slack_refs: [{ url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#ask-integrations', title: 'Zapier API access answer' }],
  atlassian_refs: [{ type: 'confluence', url: 'https://servicetitan.atlassian.net/wiki/x', title: 'Zapier API access' }],
  kb_refs: [{ url: 'https://help.servicetitan.com/docs/zapier', title: 'Zapier help article' }],
}, {
  query: 'Zapier API access',
  integrationType: 'Zapier',
  issueTitle: 'Zapier API access',
});
assert(scoredSources.length === 3, 'scoreEvidenceSources flattens all current ref groups');
assert(scoredSources.every(e => e.id.startsWith('ev_')), 'scoreEvidenceSources assigns evidence ids');

// ── quality evidence contract ────────────────────────────────────────────────
console.log('\n🔹 quality evidence contract');

const contractAnswer = {
  issue_title: 'Zapier API Access',
  integration_type: 'Zapier',
  confidence: 'high',
  customer_message: 'Hi [Name], Zapier API access is disabled and we are enabling it.',
  escalate_decision: { should_escalate: false, reason: 'CSA can handle this.' },
  channel_recommendation: { channel: 'ks-integration', reason: 'Known setup issue.' },
  findings_summary: { diagnosis: 'Zapier API access is disabled.', actions: ['Enable access'] },
  agent_steps: [
    { num: 1, title: 'Enable API access', detail: 'Enable Zapier API access for the tenant.', tag: 'backend' },
    { num: 2, title: 'Verify reconnect', detail: 'Ask the customer to reconnect Zapier.', tag: 'verify' },
  ],
  slack_refs: [{ url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#ask-integrations', title: 'Zapier API access fix' }],
  atlassian_refs: [{ type: 'confluence', url: 'https://servicetitan.atlassian.net/wiki/x', title: 'Zapier API access setup' }],
  kb_refs: [{ url: 'https://help.servicetitan.com/docs/zapier', title: 'Zapier API access help', snippet: 'Enable access.' }],
  sources_used: ['slack', 'confluence', 'kb'],
};

const contract = buildAnswerEvidenceContract({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  now: new Date('2026-07-09T00:00:00.000Z'),
});

assert(isValidAnswerEvidenceContract(contract), 'contract validates');
assert(contract.version === 1, 'contract version is 1');
assert(contract.mode === 'shadow', 'contract mode is shadow');
assert(contract.quality.approximateMapping === true, 'phase 1 contract marks approximate mapping');
assert(contract.queryHash.startsWith('sha256:'), 'contract stores query hash');
assert(contract.queryPreview === 'Zapier API access disabled', 'contract stores short sanitized query preview');
assert(contract.issueTitle === 'Zapier API Access', 'contract maps issue title');
assert(contract.integrationType === 'Zapier', 'contract maps integration type');
assert(contract.sections.steps.length === 2, 'contract maps each agent step');
assert(contract.sections.steps[0].id.startsWith('claim_'), 'contract creates claim ids');
assert(contract.evidence.length === 3, 'contract maps all refs to evidence');
assert(contract.evidence.every(e => e.snippet === undefined), 'contract does not store raw snippet field');
assert(contract.evidence.some(e => e.snippetPreview), 'contract stores sanitized snippetPreview when present');
assert(contract.sections.diagnosis.evidenceIds.length > 0, 'diagnosis gets approximate evidence ids');
assert(contract.sections.customerMessage.evidenceIds.every(id => contract.evidence.find(e => e.id === id)?.sensitivity === 'safe'), 'customer message maps only safe evidence ids');

const sparseContract = buildAnswerEvidenceContract({
  answer: { issue_title: 'Unknown issue', agent_steps: [] },
  query: '',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  now: new Date('2026-07-09T00:00:00.000Z'),
});
assert(isValidAnswerEvidenceContract(sparseContract), 'sparse answer still produces valid contract');
assert(sparseContract.evidence.length === 0, 'sparse answer has empty evidence');

// ── quality shared normalization and nomination policy skeleton ──────────────
console.log('\n🔹 quality shared normalization and nomination policy skeleton');

const normalizedEvidence = normalizeQualityEvidence([
  { id: 'Bad Customer 123', source: 'kb', directness: 'direct' },
  {
    id: 'ev_first',
    source: 'kb',
    hostname: 'help.servicetitan.com',
    urlHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceQuality: 'HIGH',
    directness: 'DIRECT',
    freshness: 'FRESH',
    sensitivity: 'SAFE',
    reuseValue: 'HIGH',
    reasons: ['direct_source_match', 'tenant 123'],
  },
  {
    id: 'ev_dup',
    source: 'jira',
    hostname: 'servicetitan.atlassian.net',
    sourceQuality: 'medium',
    directness: 'related',
    freshness: 'unknown',
    sensitivity: 'internal',
    reuseValue: 'medium',
  },
  {
    id: 'ev_dup',
    source: 'confluence',
    sourceQuality: 'high',
    directness: 'direct',
    freshness: 'fresh',
    sensitivity: 'safe',
    reuseValue: 'high',
  },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `ev_bound_${index}`,
    source: index === 0 ? 'bad source' : 'kb',
    hostname: 'not-servicetitan.example.com',
    sourceQuality: 'excellent',
    directness: 'exact',
    freshness: 'ancient',
    sensitivity: 'public',
    reuseValue: 'forever',
  })),
]);
assert(normalizedEvidence.length === 10, 'shared evidence normalization applies the ten-record bound after dropping invalid IDs');
assert(normalizedEvidence.every(e => e.id.startsWith('ev_')), 'shared evidence normalization retains only valid evidence IDs');
assert(normalizedEvidence[0].source === 'kb', 'shared evidence normalization keeps valid source enum');
assert(normalizedEvidence[0].sourceQuality === 'high', 'shared evidence normalization lowercases valid source quality enum');
assert(normalizedEvidence[0].directness === 'direct', 'shared evidence normalization lowercases valid directness enum');
assert(normalizedEvidence[0].freshness === 'fresh', 'shared evidence normalization lowercases valid freshness enum');
assert(normalizedEvidence[0].sensitivity === 'safe', 'shared evidence normalization lowercases valid sensitivity enum');
assert(normalizedEvidence[0].reuseValue === 'high', 'shared evidence normalization lowercases valid reuse enum');
assert(normalizedEvidence.find(e => e.id === 'ev_bound_0').source === 'unknown', 'shared evidence normalization clamps invalid source enum');
assert(normalizedEvidence.at(-1).sourceQuality === 'unknown', 'shared evidence normalization clamps invalid quality enum');
assert(normalizedEvidence.at(-1).directness === 'unknown', 'shared evidence normalization clamps invalid directness enum');
assert(normalizedEvidence.at(-1).freshness === 'unknown', 'shared evidence normalization clamps invalid freshness enum');
assert(normalizedEvidence.at(-1).sensitivity === 'unknown', 'shared evidence normalization clamps invalid sensitivity enum');
assert(normalizedEvidence.at(-1).reuseValue === 'unknown', 'shared evidence normalization clamps invalid reuse enum');
assert.deepEqual(normalizedEvidence[0].reasons, ['direct_source_match'], 'shared evidence normalization allowlists reason codes');
const normalizedEvidenceById = evidenceByIdFirstWins(normalizedEvidence);
assert(normalizedEvidenceById.get('ev_dup').source === 'jira', 'shared evidence duplicate resolution uses first valid record');
assert(normalizedEvidenceById.get('ev_bound_8') === undefined, 'shared evidence bound is applied before evidence lookup');

const overLimitSteps = Array.from({ length: 1005 }, (_, index) => ({
  id: `claim_${index}`,
  title: index === 0 ? 'Check OAuth mapping in Settings' : `Step ${index}`,
  detail: index === 999 ? 'Past kept step' : '',
  tag: index === 0 ? 'backend' : 'action',
  evidenceIds: ['ev_first', 'Bad Customer 123', 'ev_dup', 'ev_dup'],
}));
const normalizedSteps = normalizeQualitySteps([
  null,
  'not a step',
  [],
  { id: 'claim_valid', title: 'Enable API access', detail: 'Use Marketplace settings', tag: 'ACTION', evidenceIds: ['ev_first', 'Bad Customer 123'] },
  ...overLimitSteps,
]);
assert(normalizedSteps.length === 1000, 'shared step normalization skips malformed entries and applies the step bound');
assert.deepEqual(normalizedSteps[0].evidenceIds, ['ev_first'], 'shared step normalization sanitizes evidence IDs');
assert(normalizedSteps[0].tag === 'action', 'shared step normalization lowercases valid claim type tags');
assert(normalizedSteps[1].tag === 'backend', 'shared step normalization preserves controlled backend tag');
assert(normalizedSteps.at(-1).title === 'Step 998', 'shared step normalization applies bound before candidate construction');
assert.deepEqual(sanitizeCountMap({ action: 2, backend: 1, bad: 9, verify: -1 }, CLAIM_TYPES), {
  action: 2,
  backend: 1,
}, 'shared count map sanitization keeps only controlled non-negative counts');

assert(CLAIM_TYPES.has('action') && CLAIM_TYPES.has('backend') && CLAIM_TYPES.has('verify') && CLAIM_TYPES.has('step') && CLAIM_TYPES.has('escalate'), 'nomination policy exports controlled claim types');
assert(POLICY_ELIGIBLE_REASONS.has('durable_claim_type'), 'nomination policy exports controlled eligible reasons');
assert(POLICY_BLOCKERS.has('generic_placeholder'), 'nomination policy exports controlled blockers');
assert.deepEqual(emptyEvidenceSummary(), {
  resolvedCount: 0,
  directCount: 0,
  safeDirectCount: 0,
  specialistOnlyCount: 0,
  exclusivelySpecialistOnly: false,
  highOrMediumQualityCount: 0,
  highOrMediumReuseCount: 0,
  qualifyingEvidenceCount: 0,
  freshQualifyingEvidenceCount: 0,
  unknownFreshnessQualifyingEvidenceCount: 0,
  staleOtherwiseQualifyingEvidenceCount: 0,
}, 'nomination policy empty evidence summary has stable zero shape');

const candidateContract = {
  answerId: 'ans_candidates',
  integrationType: 'Zapier',
  quality: { approximateMapping: true },
  sections: {
    escalation: { shouldEscalate: true },
    steps: [
      null,
      { id: 'claim_action', title: 'Enable API access', detail: 'Enable Zapier API access in Settings.', tag: 'action', evidenceIds: ['ev_first', 'bad id', 'ev_dup', 'ev_dup'] },
      { id: 'claim_backend', title: 'Check OAuth mapping in Settings', detail: '', tag: 'backend', evidenceIds: ['ev_first'] },
      { id: 'claim_verify', title: 'Review the webhook subscription status', detail: '', tag: 'verify', evidenceIds: [] },
      { id: 'claim_escalate', title: 'Escalate this tenant to engineering', detail: '', tag: 'escalate', tenantSpecific: true, evidenceIds: ['ev_first'] },
      { id: 'claim_unknown', title: 'Investigate further', detail: '', tag: 'misc', evidenceIds: ['ev_first'] },
      { id: 'claim_retry', title: 'Try again', detail: '', tag: 'action', evidenceIds: [] },
      { id: 'claim_customer', title: 'Ask the customer to reconnect', detail: '', tag: 'verify', evidenceIds: [] },
      { id: 'claim_account', title: 'Reset account 456 mapping', detail: '', tag: 'backend', evidenceIds: [] },
    ],
  },
};
const originalCandidateContract = JSON.stringify(candidateContract);
const candidates = buildClaimCandidates(candidateContract, { now: new Date('2026-07-15T12:00:00.000Z') });
const boundedCandidates = buildClaimCandidates({
  answerId: 'ans_bounded_candidates',
  sections: { steps: [null, 'not a step', [], ...overLimitSteps] },
}, { now: new Date('2026-07-15T12:00:00.000Z') });
assert(candidates.length === 8, 'candidate builder creates one candidate per valid normalized bounded step');
assert(boundedCandidates.length === 1000, 'candidate builder count matches valid bounded step population');
assert(candidates.every(c => c.version === 1), 'candidate builder uses version 1 candidates');
assert(candidates.every(c => c.candidateId.startsWith('qc_20260715T120000000Z_')), 'candidate builder creates quality candidate ids');
assert(candidates[0].answerId === 'ans_candidates', 'candidate builder copies answer id');
assert(candidates[0].sourceStepId === 'claim_action', 'candidate builder keeps valid source step id');
assert(candidates[0].claimOrdinal === 1, 'candidate builder assigns normalized claim ordinal');
assert(candidates[0].claimType === 'action', 'candidate builder maps action claim type');
assert(candidates[1].claimType === 'backend', 'candidate builder maps backend claim type');
assert(candidates[2].claimType === 'verify', 'candidate builder maps verify claim type');
assert(candidates[3].claimType === 'escalate', 'candidate builder maps escalate claim type');
assert(candidates[4].claimType === 'step', 'candidate builder falls back to step claim type');
assert.deepEqual(candidates[0].evidenceIds, ['ev_first', 'ev_dup'], 'candidate builder dedupes and sanitizes evidence ids');
assert(candidates.every(c => c.approximateMapping === true), 'candidate builder marks approximate mapping from contract quality');
assert(candidates.every(c => c.answerRequiresEscalation === true), 'candidate builder marks answer escalation context');
assert(candidates[3].tenantSpecific === true, 'candidate builder marks explicit tenant-specific step flag');
assert(candidates[7].tenantSpecific === true, 'candidate builder marks numbered account references as tenant-specific');
assert(candidates[6].tenantSpecific === false, 'candidate builder does not mark generic customer reconnect instruction tenant-specific');
assert(candidates[4].genericPlaceholder === true, 'candidate builder marks investigate further as generic placeholder');
assert(candidates[5].genericPlaceholder === true, 'candidate builder marks try again as generic placeholder');
assert(candidates[1].genericPlaceholder === false, 'candidate builder keeps concrete OAuth mapping action non-generic');
assert(candidates[2].genericPlaceholder === false, 'candidate builder keeps concrete webhook review action non-generic');
assert.deepEqual(candidates[0].eligibility, { preDuplicateEligible: false, reasons: [], blockers: [] }, 'candidate builder leaves eligibility unevaluated for Task 1');
assert.deepEqual(candidates[0].evidenceSummary, emptyEvidenceSummary(), 'candidate builder attaches empty evidence summary for Task 1');
assert(JSON.stringify(candidateContract) === originalCandidateContract, 'candidate builder does not mutate the original contract');

// ── quality nomination policy evaluation and aggregation ────────────────────
console.log('\n🔹 quality nomination policy evaluation and aggregation');

function policyEvidence(overrides = {}) {
  const suffix = String(overrides.id ?? 'ev_policy').replace(/^ev_/, '');
  return {
    id: overrides.id ?? 'ev_policy',
    source: overrides.source ?? 'kb',
    hostname: overrides.hostname ?? 'help.servicetitan.com',
    urlHash: overrides.urlHash ?? `sha256:${suffix.padEnd(64, 'a').slice(0, 64)}`,
    sourceQuality: overrides.sourceQuality ?? 'high',
    directness: overrides.directness ?? 'direct',
    freshness: overrides.freshness ?? 'fresh',
    sensitivity: overrides.sensitivity ?? 'safe',
    reuseValue: overrides.reuseValue ?? 'high',
    reasons: overrides.reasons ?? ['direct_source_match'],
  };
}

function policyStep(overrides = {}) {
  return {
    id: overrides.id ?? 'claim_policy',
    title: overrides.title ?? 'Enable API access',
    detail: overrides.detail ?? 'Use Settings to re-enable the integration.',
    tag: overrides.tag ?? 'action',
    evidenceIds: [...(overrides.evidenceIds ?? ['ev_policy'])],
    tenantSpecific: overrides.tenantSpecific === true,
  };
}

function policyContract(overrides = {}) {
  const steps = overrides.steps ?? [policyStep()];
  const evidence = overrides.evidence ?? [policyEvidence()];
  return {
    answerId: overrides.answerId ?? 'ans_policy',
    confidence: overrides.confidence ?? 'high',
    integrationType: overrides.integrationType ?? 'Zapier',
    evidence: evidence.map(item => ({ ...item, reasons: [...(item.reasons ?? [])] })),
    quality: { approximateMapping: overrides.approximateMapping !== false },
    sections: {
      escalation: { shouldEscalate: overrides.shouldEscalate === true },
      steps: steps.map(step => ({
        ...step,
        evidenceIds: [...(step.evidenceIds ?? [])],
      })),
    },
  };
}

const eligiblePolicyResult = evaluateContractNominationPolicy(policyContract(), {
  now: new Date('2026-07-16T09:00:00.000Z'),
});
assert(eligiblePolicyResult.status === 'evaluated', 'policy evaluation returns evaluated status');
assert(eligiblePolicyResult.candidates.length === 1, 'policy evaluation builds one candidate for one valid step');
assert(eligiblePolicyResult.candidates[0].eligibility.preDuplicateEligible === true, 'one cohesive supported claim is pre-duplicate eligible');
assert.deepEqual(eligiblePolicyResult.candidates[0].eligibility.blockers, [], 'eligible cohesive claim has no blockers');
assert.deepEqual(eligiblePolicyResult.candidates[0].eligibility.reasons, [
  'specific_integration',
  'durable_claim_type',
  'concrete_claim',
  'non_tenant_specific',
  'cohesive_qualifying_evidence',
], 'eligible cohesive claim gets the controlled eligible reasons only');
assert.deepEqual(eligiblePolicyResult.candidates[0].evidenceSummary, {
  resolvedCount: 1,
  directCount: 1,
  safeDirectCount: 1,
  specialistOnlyCount: 0,
  exclusivelySpecialistOnly: false,
  highOrMediumQualityCount: 1,
  highOrMediumReuseCount: 1,
  qualifyingEvidenceCount: 1,
  freshQualifyingEvidenceCount: 1,
  unknownFreshnessQualifyingEvidenceCount: 0,
  staleOtherwiseQualifyingEvidenceCount: 0,
}, 'eligible cohesive claim gets the expected evidence summary shape and counts');
assert.deepEqual(eligiblePolicyResult.summary, summarizeNominationPolicy(eligiblePolicyResult), 'policy result summary matches direct summarization');

const mediumConfidenceResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_medium',
  confidence: 'medium',
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(mediumConfidenceResult.candidates[0].eligibility.preDuplicateEligible === true, 'medium-confidence supported claim may be eligible');

const lowConfidenceResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_low',
  confidence: 'low',
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(lowConfidenceResult.candidates[0].eligibility.preDuplicateEligible === false, 'low-confidence claim is blocked');
assert.deepEqual(lowConfidenceResult.candidates[0].eligibility.blockers, ['low_confidence_answer'], 'low-confidence supported claim gets only the low-confidence blocker');

const unrelatedEvidenceResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_unrelated',
  evidence: [
    policyEvidence({ id: 'ev_quality_only', sourceQuality: 'high', reuseValue: 'low' }),
    policyEvidence({ id: 'ev_reuse_only', sourceQuality: 'low', reuseValue: 'high' }),
  ],
  steps: [policyStep({ evidenceIds: ['ev_quality_only', 'ev_reuse_only'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(unrelatedEvidenceResult.candidates[0].eligibility.preDuplicateEligible === false, 'unrelated sources cannot combine into eligibility');
assert.deepEqual(unrelatedEvidenceResult.candidates[0].eligibility.blockers, ['no_cohesive_qualifying_evidence'], 'the unrelated-source case receives the cohesive-evidence blocker');
assert(unrelatedEvidenceResult.candidates[0].evidenceSummary.highOrMediumQualityCount === 1, 'quality-only support count stays per record');
assert(unrelatedEvidenceResult.candidates[0].evidenceSummary.highOrMediumReuseCount === 1, 'reuse-only support count stays per record');
assert(unrelatedEvidenceResult.candidates[0].evidenceSummary.qualifyingEvidenceCount === 0, 'no single evidence record qualifies cohesively');

const staleOnlyResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_stale',
  evidence: [policyEvidence({ id: 'ev_stale_only', freshness: 'stale' })],
  steps: [policyStep({ evidenceIds: ['ev_stale_only'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(staleOnlyResult.candidates[0].eligibility.blockers, ['stale_evidence'], 'stale-only otherwise qualifying evidence gets stale_evidence');
assert(staleOnlyResult.candidates[0].evidenceSummary.staleOtherwiseQualifyingEvidenceCount === 1, 'stale-only qualifying evidence is counted separately');

const unsupportedEvidenceResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_unsupported',
  evidence: [policyEvidence({ id: 'ev_kept' })],
  steps: [policyStep({ evidenceIds: ['ev_missing', 'bad id', 'ev_missing'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(unsupportedEvidenceResult.candidates[0].eligibility.blockers, ['unsupported_claim'], 'unsupported evidence gets only the correct precedence blocker');
assert(unsupportedEvidenceResult.candidates[0].evidenceSummary.resolvedCount === 0, 'dangling and invalid evidence ids do not resolve');

const noDirectResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_related',
  evidence: [policyEvidence({ id: 'ev_related_only', directness: 'related' })],
  steps: [policyStep({ evidenceIds: ['ev_related_only'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(noDirectResult.candidates[0].eligibility.blockers, ['no_direct_evidence'], 'related/background-only evidence gets no_direct_evidence');

const specialistOnlyResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_specialist',
  evidence: [policyEvidence({ id: 'ev_specialist_only', sensitivity: 'specialist_only' })],
  steps: [policyStep({ evidenceIds: ['ev_specialist_only'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(specialistOnlyResult.candidates[0].eligibility.blockers, ['no_safe_direct_evidence', 'specialist_only_evidence'], 'direct specialist-only evidence gets the safe/specialist blockers without quality or reuse noise');

const weakQualityResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_weak_quality',
  evidence: [policyEvidence({ id: 'ev_weak_quality', sourceQuality: 'low', reuseValue: 'high' })],
  steps: [policyStep({ evidenceIds: ['ev_weak_quality'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(weakQualityResult.candidates[0].eligibility.blockers, ['weak_source_quality'], 'weak-quality-only direct-safe evidence gets the quality blocker');

const lowReuseResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_low_reuse',
  evidence: [policyEvidence({ id: 'ev_low_reuse', sourceQuality: 'high', reuseValue: 'low' })],
  steps: [policyStep({ evidenceIds: ['ev_low_reuse'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(lowReuseResult.candidates[0].eligibility.blockers, ['low_reuse_value'], 'low-reuse-only direct-safe evidence gets the reuse blocker');

const mixedSafeAndSpecialistResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_mixed_support',
  evidence: [
    policyEvidence({ id: 'ev_safe_kept' }),
    policyEvidence({ id: 'ev_specialist_extra', sensitivity: 'specialist_only' }),
  ],
  steps: [policyStep({ evidenceIds: ['ev_safe_kept', 'ev_specialist_extra'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(mixedSafeAndSpecialistResult.candidates[0].eligibility.preDuplicateEligible === true, 'mixed safe cohesive evidence plus specialist evidence may remain eligible');
assert(mixedSafeAndSpecialistResult.candidates[0].evidenceSummary.specialistOnlyCount === 1, 'specialist evidence is still counted in mixed support summaries');

const tenantSpecificResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_tenant_specific',
  steps: [policyStep({ title: 'Reset account 456 mapping', detail: '', evidenceIds: ['ev_policy'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(tenantSpecificResult.candidates[0].eligibility.blockers.includes('tenant_specific_claim'), 'tenant-specific claim is blocked');

const escalationClaimResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_escalation_claim',
  steps: [policyStep({ tag: 'escalate', title: 'Escalate to engineering', evidenceIds: ['ev_policy'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(escalationClaimResult.candidates[0].eligibility.blockers.includes('escalation_claim'), 'escalation claim is blocked');

const answerEscalationResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_answer_escalation',
  shouldEscalate: true,
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(answerEscalationResult.candidates[0].eligibility.blockers.includes('answer_requires_escalation'), 'answer requiring escalation is blocked');

const fallbackStepResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_fallback_step',
  steps: [policyStep({ tag: 'misc', title: 'Check the OAuth mapping in Settings', evidenceIds: ['ev_policy'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(fallbackStepResult.candidates[0].claimType === 'step', 'unknown tags fall back to step claims for policy evaluation');
assert.deepEqual(fallbackStepResult.candidates[0].eligibility.blockers, ['non_durable_claim_type'], 'fallback step claim gets the non-durable blocker only when otherwise supported');

const genericInstructionResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_generic',
  steps: [policyStep({ title: 'Try again', detail: '', evidenceIds: ['ev_policy'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(genericInstructionResult.candidates[0].eligibility.blockers.includes('generic_placeholder'), 'generic instruction is blocked as a placeholder');

const concreteInstructionResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_concrete',
  steps: [policyStep({ title: 'Check the OAuth mapping in Settings', detail: '', evidenceIds: ['ev_policy'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(!concreteInstructionResult.candidates[0].eligibility.blockers.includes('generic_placeholder'), 'concrete instruction is not treated as a placeholder');

const missingIntegrationResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_general_integration',
  integrationType: 'General',
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(missingIntegrationResult.candidates[0].eligibility.blockers.includes('missing_specific_integration'), 'general integration is blocked as missing specific integration');

const emptyClaimResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_empty_claim',
  steps: [policyStep({ title: '', detail: '', evidenceIds: ['ev_policy'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(emptyClaimResult.candidates[0].eligibility.blockers.includes('empty_claim'), 'empty claim is blocked');
assert(!emptyClaimResult.candidates[0].eligibility.blockers.includes('generic_placeholder'), 'empty claim uses empty_claim instead of generic_placeholder');

const evidenceBoundResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_evidence_bound',
  evidence: Array.from({ length: 12 }, (_, index) => policyEvidence({ id: `ev_bound_case_${index}` })),
  steps: [
    policyStep({ id: 'claim_bound_kept', evidenceIds: ['ev_bound_case_9'] }),
    policyStep({ id: 'claim_bound_dropped', evidenceIds: ['ev_bound_case_10'] }),
  ],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert(evidenceBoundResult.candidates[0].eligibility.preDuplicateEligible === true, 'evidence at the ten-record bound still counts');
assert.deepEqual(evidenceBoundResult.candidates[1].eligibility.blockers, ['unsupported_claim'], 'evidence beyond the ten-record bound does not count');

const duplicateCandidateEvidence = evaluateNominationEligibility({
  version: 1,
  candidateId: 'qc_duplicate_ids',
  answerId: 'ans_policy_dup_ids',
  sourceStepId: 'claim_dup_ids',
  claimOrdinal: 1,
  claimType: 'action',
  text: 'Enable API access',
  integrationType: 'Zapier',
  evidenceIds: ['ev_dup_ids', 'ev_dup_ids', 'ev_dup_ids'],
  approximateMapping: true,
  nominationEligible: false,
  tenantSpecific: false,
  genericPlaceholder: false,
  answerRequiresEscalation: false,
  eligibility: { preDuplicateEligible: true, reasons: ['bogus'], blockers: ['bogus'] },
  evidenceSummary: { resolvedCount: 99 },
}, policyContract({
  answerId: 'ans_policy_dup_ids',
  evidence: [policyEvidence({ id: 'ev_dup_ids' })],
  steps: [],
}));
assert(duplicateCandidateEvidence.evidenceSummary.resolvedCount === 1, 'duplicate candidate evidence ids do not inflate counts');
assert(duplicateCandidateEvidence.eligibility.preDuplicateEligible === true, 'caller-provided eligibility values are ignored and recomputed');
assert(duplicateCandidateEvidence.nominationEligible === undefined, 'caller-provided top-level nominationEligible does not survive evaluated candidates');
assert.deepEqual(duplicateCandidateEvidence.eligibility.reasons, [
  'specific_integration',
  'durable_claim_type',
  'concrete_claim',
  'non_tenant_specific',
  'cohesive_qualifying_evidence',
], 'caller-provided reasons are ignored');
assert.deepEqual(duplicateCandidateEvidence.eligibility.blockers, [], 'caller-provided blockers are ignored');

const duplicateEvidenceRecordsResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_dup_records',
  evidence: [
    policyEvidence({ id: 'ev_dup_record', sourceQuality: 'low', reuseValue: 'high' }),
    policyEvidence({ id: 'ev_dup_record', sourceQuality: 'high', reuseValue: 'high' }),
  ],
  steps: [policyStep({ evidenceIds: ['ev_dup_record'] })],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(duplicateEvidenceRecordsResult.candidates[0].eligibility.blockers, ['weak_source_quality'], 'duplicate evidence records use first-valid-record-wins during policy evaluation');

const mutationContract = policyContract({
  answerId: 'ans_policy_mutation',
  evidence: [policyEvidence({ id: 'ev_mutation' })],
  steps: [policyStep({ id: 'claim_mutation', evidenceIds: ['ev_mutation'] })],
});
const mutationCandidate = {
  version: 1,
  candidateId: 'qc_mutation',
  answerId: 'ans_policy_mutation',
  sourceStepId: 'claim_mutation',
  claimOrdinal: 1,
  claimType: 'action',
  text: 'Enable API access',
  integrationType: 'Zapier',
  evidenceIds: ['ev_mutation'],
  approximateMapping: true,
  tenantSpecific: false,
  genericPlaceholder: false,
  answerRequiresEscalation: false,
  eligibility: { preDuplicateEligible: true, reasons: ['bogus'], blockers: ['bogus'] },
  evidenceSummary: { resolvedCount: 77 },
};
const mutationContractBefore = JSON.stringify(mutationContract);
const mutationCandidateBefore = JSON.stringify(mutationCandidate);
const mutationCandidateResult = evaluateNominationEligibility(mutationCandidate, mutationContract);
const mutationPolicyResult = evaluateContractNominationPolicy(mutationContract, {
  now: new Date('2026-07-16T09:00:00.000Z'),
});
assert(JSON.stringify(mutationContract) === mutationContractBefore, 'contract is not mutated during policy evaluation');
assert(JSON.stringify(mutationCandidate) === mutationCandidateBefore, 'candidate is not mutated during policy evaluation');
assert(mutationCandidateResult !== mutationCandidate, 'policy evaluation returns a candidate copy instead of mutating the input candidate');
assert(mutationPolicyResult.candidates[0] !== mutationCandidate, 'contract evaluation returns evaluated candidate copies');

const aggregatePolicyContract = policyContract({
  answerId: 'ans_policy_aggregate',
  evidence: [
    policyEvidence({ id: 'ev_agg_eligible' }),
    policyEvidence({ id: 'ev_agg_stale', freshness: 'stale' }),
    policyEvidence({ id: 'ev_agg_related', directness: 'related' }),
    policyEvidence({ id: 'ev_agg_specialist', sensitivity: 'specialist_only' }),
    policyEvidence({ id: 'ev_agg_quality_only', sourceQuality: 'high', reuseValue: 'low' }),
    policyEvidence({ id: 'ev_agg_reuse_only', sourceQuality: 'low', reuseValue: 'high' }),
  ],
  steps: [
    policyStep({ id: 'claim_agg_eligible', evidenceIds: ['ev_agg_eligible'] }),
    policyStep({ id: 'claim_agg_stale', title: 'Verify reconnect', detail: '', tag: 'verify', evidenceIds: ['ev_agg_stale'] }),
    policyStep({ id: 'claim_agg_related', title: 'Review the webhook subscription status', detail: '', tag: 'verify', evidenceIds: ['ev_agg_related'] }),
    policyStep({ id: 'claim_agg_specialist', title: 'Inspect specialist-only trace', detail: '', tag: 'backend', evidenceIds: ['ev_agg_specialist'] }),
    policyStep({ id: 'claim_agg_unrelated', title: 'Check the OAuth mapping in Settings', detail: '', tag: 'backend', evidenceIds: ['ev_agg_quality_only', 'ev_agg_reuse_only'] }),
  ],
});
const aggregatePolicyResult = evaluateContractNominationPolicy(aggregatePolicyContract, {
  now: new Date('2026-07-16T09:00:00.000Z'),
});
const aggregateSummary = aggregatePolicyResult.summary;
assert(aggregateSummary.candidateCount === 5, 'summary candidate count matches the candidate population');
assert(aggregateSummary.preDuplicateEligibleCount === 1, 'summary counts eligible candidates');
assert(aggregateSummary.blockedCount === 4, 'summary counts blocked candidates');
assert(aggregateSummary.preDuplicateEligibleCount + aggregateSummary.blockedCount === aggregateSummary.candidateCount, 'summary keeps eligible/blocked equality invariant');
assert(Object.values(aggregateSummary.byClaimType).reduce((sum, count) => sum + count, 0) === aggregateSummary.candidateCount, 'summary by-claim-type counts add up to candidate count');
assert(Object.values(aggregateSummary.supportCounts).every(count => Number.isInteger(count) && count >= 0 && count <= aggregateSummary.candidateCount), 'summary support counts stay bounded non-negative integers');
assert.deepEqual(aggregateSummary.blockerCounts, {
  stale_evidence: 1,
  no_direct_evidence: 1,
  no_safe_direct_evidence: 1,
  specialist_only_evidence: 1,
  no_cohesive_qualifying_evidence: 1,
}, 'blocker counts come only from blocked candidates');
assert.deepEqual(aggregateSummary.eligibleReasonCounts, {
  specific_integration: 1,
  durable_claim_type: 1,
  concrete_claim: 1,
  non_tenant_specific: 1,
  cohesive_qualifying_evidence: 1,
}, 'eligible reasons come only from eligible candidates');
assert.deepEqual(aggregateSummary.supportCounts, {
  resolvedCount: 5,
  directCount: 4,
  safeDirectCount: 3,
  specialistOnlyCount: 1,
  exclusivelySpecialistOnly: 1,
  highOrMediumQualityCount: 3,
  highOrMediumReuseCount: 3,
  qualifyingEvidenceCount: 2,
  freshQualifyingEvidenceCount: 1,
  staleOtherwiseQualifyingEvidenceCount: 1,
}, 'summary support counts count candidates satisfying each support condition');
assert(aggregatePolicyResult.candidates.every(candidate => candidate.eligibility.preDuplicateEligible || candidate.eligibility.blockers.length >= 1), 'no blocked candidate is blockerless');
assert(aggregatePolicyResult.candidates.filter(candidate => candidate.eligibility.preDuplicateEligible).length === aggregateSummary.preDuplicateEligibleCount, 'summary eligible count matches evaluated candidates');

const zeroCandidateResult = evaluateContractNominationPolicy(policyContract({
  answerId: 'ans_policy_zero',
  evidence: [],
  steps: [],
}), { now: new Date('2026-07-16T09:00:00.000Z') });
assert.deepEqual(zeroCandidateResult.summary, {
  version: 1,
  status: 'evaluated',
  evaluated: true,
  duplicateCheck: 'deferred',
  candidateCount: 0,
  preDuplicateEligibleCount: 0,
  blockedCount: 0,
  blockerCounts: {},
  eligibleReasonCounts: {},
  byClaimType: {},
  supportCounts: {},
}, 'zero-candidate contract produces a canonical evaluated summary');

// ── quality shadow storage/audit ─────────────────────────────────────────────
console.log('\n🔹 quality shadow storage/audit');

const qualityTempDir = await mkdtemp(join(tmpdir(), 'intbot-quality-'));
const shadowFile = join(qualityTempDir, 'quality-shadow.jsonl');
const auditFile = join(qualityTempDir, 'quality-audit.jsonl');
_setQualityShadowFileForTest(shadowFile);
_setQualityAuditFileForTest(auditFile);

for (let i = 0; i < 5; i += 1) {
  await appendQualityShadowRecord({
    createdAt: new Date(Date.UTC(2026, 6, 9, 0, 0, i)).toISOString(),
    answerId: `ans_${i}`,
    queryPreview: `customer email user${i}@example.com token xoxb-secret-${i}`,
    evidence: [{ title: `Source ${i}`, snippetPreview: 'raw source body '.repeat(50) }],
  }, {
    retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
    now: new Date('2026-07-09T00:01:00.000Z'),
  });
}

const shadowLines = (await readFile(shadowFile, 'utf-8')).trim().split('\n');
assert(shadowLines.length === 3, 'quality shadow store enforces maxRecords retention');
const shadowJson = shadowLines.join('\n');
assert(!shadowJson.includes('user4@example.com'), 'quality shadow store redacts emails');
assert(!shadowJson.includes('xoxb-secret'), 'quality shadow store redacts Slack-like tokens');
assert(!shadowJson.includes('raw source body raw source body raw source body'), 'quality shadow store avoids large raw snippets');

const sensitiveQualityText = {
  query: 'Jane Customer jane.customer@example.com xoxb-1234567890-secret 555-123-4567 tenant 123 account 456 location 789 raw query text',
  sourceUrl: 'https://servicetitan.atlassian.net/wiki/spaces/INT/pages/123456/Jane-Customer-tenant-123',
  sourceSnippet: 'Jane Customer source snippet with phone 555-123-4567 and tenant 123',
  stepTitle: 'Call Jane Customer',
  stepDetail: 'Tell Jane Customer about account 456 and location 789',
  actorName: 'Jane Reviewer',
  hostileHostname: 'jane-customer.tenant-123.example.com',
  hostileReasonCodes: ['tenant-123', 'account-456', 'location-789', '555-123-4567', 'JaneCustomer'],
};
const sensitiveShadowFile = join(qualityTempDir, 'quality-shadow-sensitive.jsonl');
_setQualityShadowFileForTest(sensitiveShadowFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-09T00:01:30.000Z',
  answerId: 'ans_sensitive',
  queryHash: sensitiveQualityText.query,
  queryPreview: sensitiveQualityText.query,
  issueTitle: 'Jane Customer tenant 123 diagnosis',
  integrationType: 'Jane Customer',
  confidence: sensitiveQualityText.query,
  evidence: [{
    id: 'ev_sensitive',
    source: 'Jane Customer',
    hostname: sensitiveQualityText.hostileHostname,
    url: sensitiveQualityText.sourceUrl,
    urlHash: sensitiveQualityText.sourceUrl,
    title: 'Jane Customer tenant 123 setup',
    snippetPreview: sensitiveQualityText.sourceSnippet,
    sourceQuality: sensitiveQualityText.query,
    directness: sensitiveQualityText.query,
    freshness: sensitiveQualityText.query,
    sensitivity: sensitiveQualityText.query,
    reuseValue: sensitiveQualityText.query,
    reasons: ['direct_source_match', sensitiveQualityText.query, ...sensitiveQualityText.hostileReasonCodes],
  }],
  sections: [{
    title: sensitiveQualityText.stepTitle,
    detail: sensitiveQualityText.stepDetail,
  }],
  quality: {
    directAnswer: true,
    reusableKnowledge: true,
    nominationEligible: true,
    approximateMapping: true,
    reasons: ['has_reusable_claim', ...sensitiveQualityText.hostileReasonCodes],
  },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-09T00:01:30.000Z'),
});
const sensitiveShadowText = await readFile(sensitiveShadowFile, 'utf-8');
const sensitiveShadowRecord = JSON.parse(sensitiveShadowText.trim());
assert(sensitiveShadowRecord.queryPreview === undefined, 'quality shadow store omits raw query previews');
assert(sensitiveShadowRecord.issueTitle === undefined, 'quality shadow store omits raw diagnosis or issue titles');
assert(sensitiveShadowRecord.integrationType === undefined, 'quality shadow store omits raw integration type labels');
assert(String(sensitiveShadowRecord.integrationTypeHash ?? '').startsWith('sha256:'), 'quality shadow store hashes integration type');
assert(sensitiveShadowRecord.evidence[0].title === undefined, 'quality shadow store omits raw source titles');
assert(sensitiveShadowRecord.evidence[0].snippetPreview === undefined, 'quality shadow store omits raw source snippet previews');
assert(sensitiveShadowRecord.evidence[0].source === 'unknown', 'quality shadow store clamps unknown source type');
assert(sensitiveShadowRecord.evidence[0].hostname === '', 'quality shadow store drops invalid hostnames');
assert(sensitiveShadowRecord.evidence[0].sourceQuality === 'unknown', 'quality shadow store clamps source quality enum');
assert(sensitiveShadowRecord.evidence[0].directness === 'unknown', 'quality shadow store clamps directness enum');
assert(sensitiveShadowRecord.evidence[0].freshness === 'unknown', 'quality shadow store clamps freshness enum');
assert(sensitiveShadowRecord.evidence[0].sensitivity === 'unknown', 'quality shadow store clamps sensitivity enum');
assert(sensitiveShadowRecord.evidence[0].reuseValue === 'unknown', 'quality shadow store clamps reuse value enum');
assert(sensitiveShadowRecord.confidence === 'unknown', 'quality shadow store clamps confidence enum');
assert.deepEqual(sensitiveShadowRecord.evidence[0].reasons, ['direct_source_match'], 'quality shadow store allowlists evidence reason codes');
assert.deepEqual(sensitiveShadowRecord.quality.reasons, ['has_reusable_claim'], 'quality shadow store allowlists quality reason codes');
assert(!sensitiveShadowText.includes('Preview'), 'quality shadow store omits preview-named persisted fields');
assert(!sensitiveShadowText.includes('title'), 'quality shadow store omits title-named persisted fields');
assert(!sensitiveShadowText.includes('detail'), 'quality shadow store omits detail-named persisted fields');
assert(!sensitiveShadowText.includes('jane.customer@example.com'), 'quality shadow store omits sample email');
assert(!sensitiveShadowText.includes('xoxb-1234567890-secret'), 'quality shadow store omits sample Slack-like token');
assert(!sensitiveShadowText.includes('555-123-4567'), 'quality shadow store omits sample phone number');
assert(!sensitiveShadowText.includes('tenant 123'), 'quality shadow store omits sample tenant id text');
assert(!sensitiveShadowText.includes('account 456'), 'quality shadow store omits sample account id text');
assert(!sensitiveShadowText.includes('location 789'), 'quality shadow store omits sample location id text');
assert(!sensitiveShadowText.includes('Jane Customer'), 'quality shadow store omits sample customer/person name from free text');
assert(!sensitiveShadowText.includes('JaneCustomer'), 'quality shadow store omits code-shaped sample customer/person name');
assert(!sensitiveShadowText.includes('raw query text'), 'quality shadow store omits raw query text');
assert(!sensitiveShadowText.includes(sensitiveQualityText.sourceUrl), 'quality shadow store omits raw source URLs');
assert(!sensitiveShadowText.includes(sensitiveQualityText.sourceSnippet), 'quality shadow store omits raw source snippet text');
assert(!sensitiveShadowText.includes(sensitiveQualityText.hostileHostname), 'quality shadow store omits hostile hostname text');
for (const hostileReasonCode of sensitiveQualityText.hostileReasonCodes) {
  assert(!sensitiveShadowText.includes(hostileReasonCode), `quality shadow store omits hostile reason code ${hostileReasonCode}`);
}

const stepCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage.jsonl');
_setQualityShadowFileForTest(stepCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:00.000Z',
  answerId: 'ans_step_coverage',
  confidence: 'high',
  evidence: [
    { id: 'ev_direct', source: 'confluence', directness: 'direct', sourceQuality: 'high' },
    { id: 'ev_related', source: 'slack', directness: 'related', sourceQuality: 'medium' },
    { id: 'ev_background', source: 'kb', directness: 'background', sourceQuality: 'low' },
  ],
  sections: {
    steps: [
      { id: 'claim_1', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: ['ev_direct'] },
      { id: 'claim_2', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: ['ev_related', 'ev_related'] },
      { id: 'claim_3', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: ['ev_missing'] },
      { id: 'claim_4', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: [] },
    ],
  },
  quality: {
    directAnswer: true,
    reusableKnowledge: true,
    nominationEligible: true,
    approximateMapping: true,
    reasons: ['shadow_mode'],
    stepCoverage: {
      stepCount: 999,
      mappedStepCount: 999,
      directMappedStepCount: 999,
      unsupportedStepCount: 999,
    },
  },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:00.000Z'),
});
const stepCoverageText = await readFile(stepCoverageFile, 'utf-8');
const stepCoverageRecord = JSON.parse(stepCoverageText.trim());
assert.deepEqual(stepCoverageRecord.quality.stepCoverage, {
  stepCount: 4,
  mappedStepCount: 2,
  directMappedStepCount: 1,
  unsupportedStepCount: 2,
}, 'quality shadow store derives step coverage from valid evidence mappings');
assert(stepCoverageRecord.quality.nominationPolicy === undefined, 'Task 1 does not persist nomination policy summary to shadow JSONL');
assert(stepCoverageRecord.quality.stepCoverage.mappedStepCount + stepCoverageRecord.quality.stepCoverage.unsupportedStepCount === stepCoverageRecord.quality.stepCoverage.stepCount, 'step coverage invariant mapped + unsupported equals total');
assert(stepCoverageRecord.quality.stepCoverage.directMappedStepCount <= stepCoverageRecord.quality.stepCoverage.mappedStepCount, 'step coverage invariant direct mapped is bounded by mapped');
assert(!stepCoverageText.includes('Do not persist title'), 'step coverage persistence omits step titles');
assert(!stepCoverageText.includes('Do not persist detail'), 'step coverage persistence omits step details');
assert(!stepCoverageText.includes('ev_missing'), 'step coverage persistence does not persist dangling evidence ids from steps');

const zeroStepCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-zero.jsonl');
_setQualityShadowFileForTest(zeroStepCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:01.000Z',
  answerId: 'ans_zero_steps',
  evidence: [{ id: 'ev_direct', source: 'kb', directness: 'direct' }],
  sections: { steps: [] },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:01.000Z'),
});
const zeroStepCoverageRecord = JSON.parse((await readFile(zeroStepCoverageFile, 'utf-8')).trim());
assert.deepEqual(zeroStepCoverageRecord.quality.stepCoverage, {
  stepCount: 0,
  mappedStepCount: 0,
  directMappedStepCount: 0,
  unsupportedStepCount: 0,
}, 'zero-step answers persist zero step coverage counts');

const allMappedStepCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-all-mapped.jsonl');
_setQualityShadowFileForTest(allMappedStepCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:02.000Z',
  answerId: 'ans_all_mapped_steps',
  evidence: [
    { id: 'ev_direct', source: 'confluence', directness: 'direct' },
    { id: 'ev_background', source: 'kb', directness: 'background' },
  ],
  sections: {
    steps: [
      { id: 'claim_1', evidenceIds: ['ev_direct'] },
      { id: 'claim_2', evidenceIds: ['ev_background'] },
    ],
  },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:02.000Z'),
});
const allMappedStepCoverageRecord = JSON.parse((await readFile(allMappedStepCoverageFile, 'utf-8')).trim());
assert.deepEqual(allMappedStepCoverageRecord.quality.stepCoverage, {
  stepCount: 2,
  mappedStepCount: 2,
  directMappedStepCount: 1,
  unsupportedStepCount: 0,
}, 'all mapped steps count as mapped while only direct evidence counts as direct mapped');

const droppedEvidenceCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-dropped-evidence.jsonl');
_setQualityShadowFileForTest(droppedEvidenceCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:03.000Z',
  answerId: 'ans_dropped_evidence',
  evidence: [
    { id: 'Alice Customer Account 123', source: 'kb', directness: 'direct' },
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `ev_${index + 1}`,
      source: 'kb',
      directness: index === 0 ? 'related' : 'direct',
    })),
  ],
  sections: {
    steps: [
      { id: 'claim_invalid_id', evidenceIds: ['Alice Customer Account 123'] },
      { id: 'claim_past_limit', evidenceIds: ['ev_11'] },
      { id: 'claim_retained', evidenceIds: ['ev_1'] },
    ],
  },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:03.000Z'),
});
const droppedEvidenceCoverageText = await readFile(droppedEvidenceCoverageFile, 'utf-8');
const droppedEvidenceCoverageRecord = JSON.parse(droppedEvidenceCoverageText.trim());
assert.deepEqual(droppedEvidenceCoverageRecord.quality.stepCoverage, {
  stepCount: 3,
  mappedStepCount: 1,
  directMappedStepCount: 0,
  unsupportedStepCount: 2,
}, 'steps referencing evidence dropped by ID validation or evidence persistence limits count as unsupported');
assert(!droppedEvidenceCoverageText.includes('Alice Customer Account 123'), 'step coverage persistence omits invalid free-text evidence ids');

const duplicateEvidenceCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-duplicate-evidence.jsonl');
_setQualityShadowFileForTest(duplicateEvidenceCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:04.000Z',
  answerId: 'ans_duplicate_evidence',
  evidence: [
    { id: 'ev_dup', source: 'kb', directness: 'related' },
    { id: 'ev_dup', source: 'kb', directness: 'direct' },
  ],
  sections: { steps: [{ id: 'claim_dup', evidenceIds: ['ev_dup'] }] },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:04.000Z'),
});
const duplicateEvidenceCoverageRecord = JSON.parse((await readFile(duplicateEvidenceCoverageFile, 'utf-8')).trim());
assert.deepEqual(duplicateEvidenceCoverageRecord.quality.stepCoverage, {
  stepCount: 1,
  mappedStepCount: 1,
  directMappedStepCount: 0,
  unsupportedStepCount: 0,
}, 'duplicate evidence ids use the first valid persisted record and do not elevate direct coverage');

const malformedStepCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-malformed-steps.jsonl');
_setQualityShadowFileForTest(malformedStepCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:05.000Z',
  answerId: 'ans_malformed_steps',
  evidence: [{ id: 'ev_direct', source: 'kb', directness: 'direct' }],
  sections: {
    steps: [
      null,
      'not a step',
      [],
      { id: 'claim_valid', evidenceIds: ['ev_direct'] },
    ],
  },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:05.000Z'),
});
const malformedStepCoverageRecord = JSON.parse((await readFile(malformedStepCoverageFile, 'utf-8')).trim());
assert.deepEqual(malformedStepCoverageRecord.quality.stepCoverage, {
  stepCount: 1,
  mappedStepCount: 1,
  directMappedStepCount: 1,
  unsupportedStepCount: 0,
}, 'malformed step entries do not inflate stepCount');

const duplicateStepIdCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-duplicate-step-id.jsonl');
_setQualityShadowFileForTest(duplicateStepIdCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:06.000Z',
  answerId: 'ans_duplicate_step_id',
  evidence: [{ id: 'ev_direct', source: 'kb', directness: 'direct' }],
  sections: {
    steps: [
      { id: 'claim_dup', evidenceIds: ['ev_direct', 'ev_direct'] },
      { id: 'claim_dup', evidenceIds: ['ev_missing', 'ev_missing'] },
    ],
  },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:06.000Z'),
});
const duplicateStepIdCoverageRecord = JSON.parse((await readFile(duplicateStepIdCoverageFile, 'utf-8')).trim());
assert.deepEqual(duplicateStepIdCoverageRecord.quality.stepCoverage, {
  stepCount: 2,
  mappedStepCount: 1,
  directMappedStepCount: 1,
  unsupportedStepCount: 1,
}, 'duplicate step ids and duplicate evidence ids inside one step do not inflate mappings beyond one result per normalized step');

const invalidShadowParent = join(qualityTempDir, 'not-a-directory');
await writeFile(invalidShadowParent, 'plain file');
_setQualityShadowFileForTest(join(invalidShadowParent, 'quality-shadow.jsonl'));
let shadowAppendRejected = false;
try {
  await appendQualityShadowRecord({
    createdAt: '2026-07-09T00:02:00.000Z',
    answerId: 'ans_failed',
    queryPreview: 'this write should fail',
  }, {
    retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
    now: new Date('2026-07-09T00:02:00.000Z'),
  });
} catch {
  shadowAppendRejected = true;
}
assert(shadowAppendRejected, 'quality shadow store surfaces failed append');

const recoveredShadowFile = join(qualityTempDir, 'quality-shadow-recovered.jsonl');
_setQualityShadowFileForTest(recoveredShadowFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-09T00:03:00.000Z',
  answerId: 'ans_recovered',
  queryPreview: 'later write succeeds after failure',
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-09T00:03:00.000Z'),
});
const recoveredShadowText = await readFile(recoveredShadowFile, 'utf-8');
assert(recoveredShadowText.includes('ans_recovered'), 'quality shadow store recovers after failed append');

await appendQualityAuditEvent({
  type: 'contract_created',
  actor: { type: 'bot', userId: 'U123', name: 'Bot User' },
  entity: { type: 'answer_contract', id: 'ans_1' },
  metadata: {
    query: 'Full customer query should become hash/preview only',
    integrationType: 'Zapier',
    reason: 'direct_source_match',
  },
}, { now: new Date('2026-07-09T00:00:00.000Z') });

await appendQualityAuditEvent({
  type: 'contract_created',
  actor: { type: 'reviewer', userId: 'U456', name: sensitiveQualityText.actorName },
  entity: { type: 'answer_contract', id: 'ans_sensitive' },
  metadata: {
    queryHash: sensitiveQualityText.query,
    query: sensitiveQualityText.query,
    integrationType: 'Jane Customer',
    reason: 'Jane Customer should not persist as a free-text reason',
    reasons: ['has_reusable_claim', ...sensitiveQualityText.hostileReasonCodes],
  },
}, { now: new Date('2026-07-09T00:00:01.000Z') });

const auditText = await readFile(auditFile, 'utf-8');
const auditLines = auditText.trim().split('\n').map(line => JSON.parse(line));
assert(auditText.includes('contract_created'), 'quality audit stores event type');
assert(auditText.includes('queryHash'), 'quality audit stores query hash');
assert(!auditText.includes('Full customer query should become hash/preview only'), 'quality audit does not store raw query');
assert(!auditText.includes('Bot User'), 'quality audit does not store actor names');
assert(!auditText.includes('"name"'), 'quality audit omits actor name field');
assert(auditLines.every(line => line.metadata.queryPreview === undefined), 'quality audit omits raw query previews');
assert(auditLines.every(line => line.metadata.reason === undefined), 'quality audit omits free-text reason fields');
assert(auditLines.every(line => line.metadata.integrationType === undefined), 'quality audit omits raw integration type labels');
assert(auditLines.every(line => String(line.metadata.integrationTypeHash ?? '').startsWith('sha256:')), 'quality audit hashes integration type');
assert(auditLines.every(line => (line.metadata.reasons ?? []).every(reason => !sensitiveQualityText.hostileReasonCodes.includes(reason))), 'quality audit allowlists reason codes');
assert(!auditText.includes('jane.customer@example.com'), 'quality audit omits sample email');
assert(!auditText.includes('xoxb-1234567890-secret'), 'quality audit omits sample Slack-like token');
assert(!auditText.includes('555-123-4567'), 'quality audit omits sample phone number');
assert(!auditText.includes('tenant 123'), 'quality audit omits sample tenant id text');
assert(!auditText.includes('account 456'), 'quality audit omits sample account id text');
assert(!auditText.includes('location 789'), 'quality audit omits sample location id text');
assert(!auditText.includes('Jane Customer'), 'quality audit omits sample customer/person name from free text');
assert(!auditText.includes('JaneCustomer'), 'quality audit omits code-shaped sample customer/person name');
assert(!auditText.includes(sensitiveQualityText.actorName), 'quality audit omits actor display name');
assert(!auditText.includes('raw query text'), 'quality audit omits raw query text');
for (const hostileReasonCode of sensitiveQualityText.hostileReasonCodes) {
  assert(!auditText.includes(hostileReasonCode), `quality audit omits hostile reason code ${hostileReasonCode}`);
}

await rm(qualityTempDir, { recursive: true, force: true });

// ── quality shadow recorder ──────────────────────────────────────────────────
console.log('\n🔹 quality shadow recorder');

const recorderTempDir = await mkdtemp(join(tmpdir(), 'intbot-quality-recorder-'));
_setQualityShadowFileForTest(join(recorderTempDir, 'shadow.jsonl'));
_setQualityAuditFileForTest(join(recorderTempDir, 'audit.jsonl'));

const oldQualityLayerEnabled = process.env.QUALITY_LAYER_ENABLED;
const oldQualityShadowMode = process.env.QUALITY_LAYER_SHADOW_MODE;
const oldAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const oldNewPipeline = process.env.NEW_PIPELINE;

process.env.QUALITY_LAYER_ENABLED = 'false';
process.env.QUALITY_LAYER_SHADOW_MODE = 'true';
const disabledRecord = await recordQualityShadow({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  logger: console,
});
assert(disabledRecord.status === 'disabled', 'recordQualityShadow skips when quality layer disabled');

process.env.QUALITY_LAYER_ENABLED = 'true';
process.env.QUALITY_LAYER_SHADOW_MODE = 'false';
const notShadowModeRecord = await recordQualityShadow({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  logger: console,
});
assert(notShadowModeRecord.status === 'not_shadow_mode', 'recordQualityShadow skips when QUALITY_LAYER_SHADOW_MODE=false');

process.env.QUALITY_LAYER_ENABLED = 'true';
process.env.QUALITY_LAYER_SHADOW_MODE = 'true';
const recorded = await recordQualityShadow({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  logger: console,
  now: new Date('2026-07-09T00:00:00.000Z'),
});
assert(recorded.status === 'recorded', 'recordQualityShadow records in shadow mode');
assert(recorded.contract?.quality?.approximateMapping === true, 'recordQualityShadow returns approximate contract');

const invalidRecorderParent = join(recorderTempDir, 'not-a-directory');
await writeFile(invalidRecorderParent, 'plain file');
_setQualityShadowFileForTest(join(invalidRecorderParent, 'shadow.jsonl'));
const warnMessages = [];
const failedOpen = await recordQualityShadow({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  logger: { warn: (message) => warnMessages.push(message) },
  now: new Date('2026-07-09T00:00:01.000Z'),
});
assert(failedOpen.status === 'failed_open', 'recordQualityShadow fails open when storage write fails');
assert(warnMessages.some((message) => message.includes('[quality] shadow record failed:')), 'recordQualityShadow logs bounded warning on failure');

const mentionShadowDir = await mkdtemp(join(tmpdir(), 'intbot-quality-mention-'));
const mentionShadowParent = join(mentionShadowDir, 'not-a-directory');
await writeFile(mentionShadowParent, 'plain file');
_setQualityShadowFileForTest(join(mentionShadowParent, 'shadow.jsonl'));
_setQualityAuditFileForTest(join(mentionShadowDir, 'audit.jsonl'));
process.env.NEW_PIPELINE = 'true';
process.env.ANTHROPIC_API_KEY = 'test';

const origFetchMention = globalThis.fetch;
let mentionStepCounter = 0;
const mentionResponses = [
  anthropicMock('{"cleaned_question":"zapier api access disabled","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"api access disabled"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"slack","priority":"high","query":"zapier api access disabled"}],"rationale":"r"}}'),
  anthropicMock('{"sufficient":true,"rationale":"good","refined_plan":null}'),
  anthropicMock('{"issue_title":"Zapier API Access","integration_type":"Zapier","is_accounting_topic":false,"confidence":"high","customer_message":"Hi.","escalate_decision":{"should_escalate":false,"reason":""},"channel_recommendation":{"channel":"","reason":""},"agent_steps":[{"num":1,"title":"Enable API access","detail":"Enable Zapier API access for the tenant.","tag":"backend"}],"findings_summary":{"diagnosis":"Zapier API access is disabled.","actions":["Enable access"]},"slack_refs":[{"url":"https://servicetitan.slack.com/archives/C1/p1","channel":"#ask-integrations","title":"Zapier API access fix"}],"atlassian_refs":[],"kb_refs":[],"sources_used":["slack"]}'),
];
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url.toString();
  if (u.includes('anthropic.com')) return mentionResponses[mentionStepCounter++];
  return new Response(JSON.stringify({ results: [], items: [], issues: [], messages: { matches: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const mentionChatUpdates = [];
const mentionChatPosts = [];
await handleQuery({
  rawText: '<@UBOT> Zapier API access disabled',
  channelId: 'C123',
  threadTs: '1700000001.000',
  userId: 'U123',
  client: {
    users: { info: async () => ({ user: { profile: { title: 'Customer Support Advocate' } } }) },
    chat: {
      postMessage: async (payload) => {
        mentionChatPosts.push(payload);
        return { ts: payload.thread_ts ?? '1700000001.111' };
      },
      update: async (payload) => {
        mentionChatUpdates.push(payload);
        return payload;
      },
    },
  },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert(mentionChatUpdates.some((payload) => payload.text === 'Troubleshooting: Zapier API Access (Zapier)'), 'mention new-pipeline path still updates Slack response when shadow recording fails');
assert(mentionChatPosts.some((payload) => payload.text === 'Checking…'), 'mention new-pipeline path still posts the existing thinking message');

globalThis.fetch = origFetchMention;
if (oldAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = oldAnthropicApiKey;
if (oldNewPipeline === undefined) delete process.env.NEW_PIPELINE;
else process.env.NEW_PIPELINE = oldNewPipeline;
if (oldQualityLayerEnabled === undefined) delete process.env.QUALITY_LAYER_ENABLED;
else process.env.QUALITY_LAYER_ENABLED = oldQualityLayerEnabled;
if (oldQualityShadowMode === undefined) delete process.env.QUALITY_LAYER_SHADOW_MODE;
else process.env.QUALITY_LAYER_SHADOW_MODE = oldQualityShadowMode;

await rm(recorderTempDir, { recursive: true, force: true });
await rm(mentionShadowDir, { recursive: true, force: true });

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
