# Response Experience Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the diagnosis and sources on every response card, restructure the follow-up chat to end with a grounded resolution card instead of plain text, and fix the DM thread detection bug.

**Architecture:** Four coordinated changes: (1) `buildResponseBlocks` gains a diagnosis line + source chips + channel-post button, (2) `CHAT_SYSTEM_PROMPT` outputs structured JSON and Claude must search all sources before resolving, (3) the mention.js follow-up path pre-fetches KB and dispatches to `buildChatResolutionBlocks` (new) or `buildFollowUpBlocks`, (4) `dm.js` gains an `_activeSessions` Set for belt-and-suspenders thread detection.

**Tech Stack:** Node.js ESM, @slack/bolt v4, Anthropic SDK with MCP beta, plain `assert`-based test suite.

---

## File Map

| File | Change |
|---|---|
| `test.js` | Add tests for all new builders and `parseChatResponse` |
| `src/claude/prompts.js` | Restructure `CHAT_SYSTEM_PROMPT` — remove NO JSON rule, add JSON schemas + 3 new hard rules |
| `src/claude/query.js` | Add `parseChatResponse` (exported); update `queryChat` signature to accept `kbContext` |
| `src/slack/blocks.js` | Add `buildChatResolutionBlocks`; update `buildFollowUpBlocks` (optional label); update `buildResponseBlocks` (diagnosis line, source chips, channel-post button) |
| `src/slack/modal.js` | Add `buildChannelPostModal` |
| `src/handlers/mention.js` | Update follow-up path: KB pre-fetch, JSON dispatch, resolution card |
| `src/handlers/dm.js` | Add `_activeSessions` Set; strengthen thread detection; add logging |
| `src/index.js` | Add `copy_channel_post` action handler; import `buildChannelPostModal` |

---

## Task 1: Write failing tests

**Files:**
- Modify: `test.js:1043` (insert before the `// ── Summary` line)

- [ ] **Step 1: Add imports to test.js**

At the very top of `test.js`, after the existing imports, add:

```js
import { parseChatResponse } from './src/claude/query.js';
import { buildChatResolutionBlocks } from './src/slack/blocks.js';
import { buildChannelPostModal } from './src/slack/modal.js';
```

The full import block at the top of test.js should look like:

```js
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
  buildAuditBlocks,
  buildChatResolutionBlocks,
} from './src/slack/blocks.js';
import { getCached, setCached, cacheStats, pruneExpired, deleteCache } from './src/slack/cache.js';
import { getHistory, appendToHistory, hasHistory, pruneConversations } from './src/slack/conversation.js';
import { parseClaudeResponse, summarizeResultForHistory } from './src/claude/prompts.js';
import { parseChatResponse } from './src/claude/query.js';
import { getRelevantFeedback, getAllFeedback, saveFeedback, approveFeedback, rejectFeedback, getPendingFeedback } from './src/slack/feedback.js';
import { searchKnowledgeBase } from './src/claude/kb-search.js';
import { buildNominationBlocks } from './src/slack/nominations.js';
import { buildAuditLogModal, buildChannelPostModal } from './src/slack/modal.js';
import {
  appendKbArticle,
  appendBotResponse,
  hasKbUrl,
  hasIssueTitle,
} from './src/slack/knowledge-writer.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
```

- [ ] **Step 2: Add new test sections to test.js**

Insert the following block immediately before the `// ── Summary` comment at line 1043:

```js
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
const noChipsBlock = noChipsBlocks.filter(b => b.type === 'context').find(b => b.elements[0].text?.includes('📄') || b.elements[0].text?.includes('💬 Slack') || b.elements[0].text?.includes('📖 KB'));
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
```

- [ ] **Step 3: Run tests — confirm expected failures**

```bash
node test.js
```

Expected: test run completes but exits with failures on:
- `parseChatResponse` tests (function not exported yet)
- `buildChatResolutionBlocks` tests (not implemented)
- `buildChannelPostModal` tests (not implemented)
- `buildFollowUpBlocks` label tests (signature unchanged)
- `buildResponseBlocks` diagnosis/chips/channel-post tests (not implemented)

All existing tests should still pass.

- [ ] **Step 4: Commit**

```bash
git add test.js
git commit -m "test: add failing tests for response experience redesign"
```

---

## Task 2: Restructure CHAT_SYSTEM_PROMPT + add parseChatResponse + update queryChat

**Files:**
- Modify: `src/claude/prompts.js:6-76` (CHAT_SYSTEM_PROMPT)
- Modify: `src/claude/query.js:123-157` (queryChat + parseChatResponse)

- [ ] **Step 1: Replace CHAT_SYSTEM_PROMPT in prompts.js**

In `src/claude/prompts.js`, replace the entire `CHAT_SYSTEM_PROMPT` constant (lines 6–76) with:

```js
export const CHAT_SYSTEM_PROMPT = `You are IntegrationsBot — a knowledgeable integrations expert and a sharp, helpful work colleague for ServiceTitan support agents.

You are in guided diagnostic mode. Your job is to ask yes/no questions to narrow down the root cause of the agent's issue, then deliver a clear, complete answer once you are confident.

## How to respond

Read the full conversation history — it shows what you have already asked and what the agent has already answered.

Always output a JSON object. Two schemas — choose based on your confidence:

**Still diagnosing** (you need one more piece of information):
  Output state "diagnosing". Write one acknowledgement sentence, then ask the single most diagnostic yes/no question.

**Confident** (you know the root cause, the fix, and have verified against sources):
  Output state "resolved". Search all sources first (see HARD RULE — SEARCH BEFORE RESOLVING). Write a precise diagnosis and complete steps.
  If the fix requires backend access or specialist involvement, set escalate to true and populate escalation_path and suggested_channel_post.

## When to resolve

Stop asking when you know:
- What caused the issue
- What the fix is
- What the agent should do next
- You have searched all sources

When in doubt, resolve. Do not over-diagnose.

## JSON schemas

Diagnosing state:
{"state":"diagnosing","acknowledgement":"One sentence stating what the agent's answer means diagnostically.","question":"One yes/no question targeting the next most likely cause."}

Resolved state (handled, no escalation):
{"state":"resolved","title":"Issue title, 6 words max","diagnosis":"One sentence: what broke and why.","steps":[{"tag":"action|backend|verify|escalate","text":"Step instruction."}],"escalate":false,"escalation_path":null,"suggested_channel_post":null,"refs":[{"source":"confluence|jira|slack|kb|knowledge","title":"Brief description of what was found"}]}

Resolved state (needs escalation):
{"state":"resolved","title":"Issue title, 6 words max","diagnosis":"One sentence: what broke and why.","steps":[{"tag":"escalate","text":"Escalate via Live Assist → Integrations Specialist."}],"escalate":true,"escalation_path":"Live Assist → Integrations Specialist","suggested_channel_post":"Agent-voice message ready to paste in the channel. 2-3 sentences.","refs":[{"source":"confluence","title":"Brief description"}]}

## Searching mid-diagnosis

If the agent's answer points to a specific error code, sub-integration, or scenario you have not searched yet — use your Atlassian or Slack search tools to look it up before asking the next question or giving the final answer. Ground everything in what you find.

## Question rules

- Yes/No format only. One sentence.
- Never ask about something already answered in the conversation history.
- Never ask two questions at once.
- Ask about the single most diagnostic thing — the answer that would most change what you tell them next.

## Tone

Warm, direct, like a senior colleague walking through a checklist together. Brief explanations — not lectures. Use contractions. Match the agent's energy.

## Hard rules

HARD RULE — NO INVENTION: Never invent specific menu paths, field names, API paths, or settings not confirmed by search results or the common integration knowledge below. Never use "may be", "likely", "probably", or "could be" when describing a root cause — if you're not certain, say you're not certain and ask or escalate.

HARD RULE — COMMON KNOWLEDGE IS READ-ONLY: Common integration knowledge below is a compressed summary. Use each entry as stated — do not expand it with invented sub-steps, field names, or paths. "Enable Zapier API access on ST backend" means exactly that one step. Do not invent how to find it or what to click.

HARD RULE — STRAIGHT FACTS ONLY: When you give the final answer, every specific path, field name, setting, and value must appear in a search result or Common integration knowledge. If you are not certain a specific detail is correct, leave it out and tell the agent what you know with confidence, then acknowledge the gap.

HARD RULE — NO REPEATED QUESTIONS: Never ask a question whose answer is already in the conversation history.

HARD RULE — ONE QUESTION: Never ask more than one question per message.

HARD RULE — JSON OUTPUT ONLY: Every response must be a valid JSON object matching one of the two schemas above. No plain text, ever. No markdown fences around the JSON.

HARD RULE — SEARCH BEFORE RESOLVING: Before outputting "state": "resolved", you must have:
  1. Searched Atlassian (Confluence and Jira) via MCP tool.
  2. Searched Slack via MCP tool.
  3. Checked the [KB RESULTS] block provided above (if present).
Include one ref per source that returned something relevant. If a source returned nothing, omit it from refs. Common integration knowledge entries count as a ref with "source": "knowledge".

HARD RULE — NO UNGROUNDED RESOLUTION: If all three sources return nothing AND the issue is not covered by Common integration knowledge, do NOT output "state": "resolved". Stay in "state": "diagnosing", acknowledge the gap, and either ask one more targeted question or tell the agent you cannot find a grounded answer and they should escalate to #ask-integrations.

HARD RULE — COMPLETE FINAL ANSWER: When you give the final answer, be complete. Do not leave the agent needing to ask obvious follow-up questions.

HARD RULE — ACCOUNTING EXCLUSION: If the follow-up touches accounting integrations (QuickBooks, NetSuite, Xero, Sage Intacct, Viewpoint Vista, etc.), redirect to #ask-partner-enabled-accounting-integrations.

HARD RULE — HONESTY: If you do not know the specific answer and cannot find it via search, say so briefly and point the agent to #ask-integrations or #ask-leads-integration.

## Common integration knowledge (use when search returns nothing)
- Zapier: Agent must enable Zapier API access on ST backend for the tenant.
- Angi/Angi Leads: Check booking provider IDs, job type mapping under Settings > Integrations > Marketing Integrations > Angi.
- Reserve with Google (RwG): Check Actions Center, verify account matching status.
- ServiceChannel: Check attachment settings, verify API credentials.
- Thumbtack: For redirect loop — clear cache/cookies, try incognito.
- Procore: Check cost code mappings for job cost export failures.
- Chat-to-Text widget: Verify embed code placement, check SMS number setup.`;
```

- [ ] **Step 2: Add parseChatResponse and update queryChat in query.js**

In `src/claude/query.js`, replace the `queryChat` function (lines 123–157) and add `parseChatResponse` immediately after:

```js
export function parseChatResponse(text) {
  try {
    const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const obj = JSON.parse(trimmed);
    if (obj.state === 'diagnosing' || obj.state === 'resolved') return obj;
  } catch {
    // fall through
  }
  return { state: 'diagnosing', acknowledgement: '', question: text };
}

export async function queryChat(userQuery, history, { kbContext = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const systemPrompt = kbContext
    ? `${CHAT_SYSTEM_PROMPT}\n\n[KB RESULTS]\n${kbContext}\n[/KB RESULTS]`
    : CHAT_SYSTEM_PROMPT;

  const messages = [...history, { role: 'user', content: userQuery }];
  const mcpServers = buildMcpServers();

  const requestParams = {
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages,
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: ['mcp-client-2025-04-04'],
  };

  let fullText = '';

  try {
    const response = await anthropic.beta.messages.create(requestParams, { signal: controller.signal });
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return parseChatResponse(fullText);
}
```

- [ ] **Step 3: Run tests**

```bash
node test.js
```

Expected: `parseChatResponse` tests now pass. Other new tests (buildChatResolutionBlocks etc.) still fail. All old tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts.js src/claude/query.js
git commit -m "feat: restructure CHAT_SYSTEM_PROMPT to JSON output; add parseChatResponse"
```

---

## Task 3: Add new block builders and update buildFollowUpBlocks

**Files:**
- Modify: `src/slack/blocks.js` (append `buildChatResolutionBlocks`; update `buildFollowUpBlocks`)
- Create: nothing (function added to existing file)

- [ ] **Step 1: Update buildFollowUpBlocks signature in blocks.js**

In `src/slack/blocks.js`, replace line 328:

```js
export function buildFollowUpBlocks(text) {
```

with:

```js
export function buildFollowUpBlocks(text, { label = 'Follow-up' } = {}) {
```

And replace line 331:

```js
    elements: [{ type: 'mrkdwn', text: '_Follow-up_' }],
```

with:

```js
    elements: [{ type: 'mrkdwn', text: `_${label}_` }],
```

- [ ] **Step 2: Add CHAT_TAG_CIRCLE, CHAT_SOURCE_LABEL, and buildChatResolutionBlocks to blocks.js**

At the very end of `src/slack/blocks.js` (after the last export), append:

```js
const CHAT_TAG_CIRCLE = { action: '🔵', backend: '🟠', verify: '🟢', escalate: '🔴' };
const CHAT_SOURCE_LABEL = { confluence: '📄 Confluence', jira: '📄 Jira', slack: '💬 Slack', kb: '📖 KB', knowledge: '📚 Team knowledge' };

export function buildChatResolutionBlocks(data) {
  const blocks = [];
  const isEscalation = data.escalate === true;

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: isEscalation ? '🔴 *Needs escalation*' : '✅ *Root cause found*' }],
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${data.title}*\n_${data.diagnosis}_` },
  });

  if (isEscalation && data.escalation_path) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📍 *Escalation path:* ${data.escalation_path}` }],
    });
  }

  for (const step of (data.steps ?? []).slice(0, 10)) {
    const circle = CHAT_TAG_CIRCLE[step.tag] ?? '⚪';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${circle} \`${step.tag}\` ${step.text}` },
    });
  }

  const chips = (data.refs ?? [])
    .map(r => CHAT_SOURCE_LABEL[r.source])
    .filter(Boolean);
  if (chips.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Verified: ${chips.join('  ·  ')}_` }],
    });
  }

  blocks.push({ type: 'divider' });

  const actionElements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '👎 Wrong', emoji: true },
      action_id: 'wrong_answer_modal',
      style: 'danger',
      value: JSON.stringify({ query: (data.title ?? '').slice(0, 400), issueTitle: (data.title ?? '').slice(0, 100), integrationType: '' }),
    },
  ];

  if (isEscalation && data.suggested_channel_post) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📋 Channel post', emoji: true },
      action_id: 'copy_channel_post',
      value: (data.suggested_channel_post ?? '').slice(0, 2000),
    });
  }

  actionElements.push({
    type: 'button',
    text: { type: 'plain_text', text: '💬 New chat', emoji: true },
    action_id: 'new_chat',
    value: 'new_chat',
  });

  blocks.push({ type: 'actions', elements: actionElements });

  return blocks;
}
```

- [ ] **Step 3: Run tests**

```bash
node test.js
```

Expected: `buildChatResolutionBlocks` and `buildFollowUpBlocks` label tests now pass. `buildChannelPostModal` tests still fail. All old tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/slack/blocks.js
git commit -m "feat: add buildChatResolutionBlocks; update buildFollowUpBlocks label param"
```

---

## Task 4: Add buildChannelPostModal to modal.js

**Files:**
- Modify: `src/slack/modal.js` (append export)

- [ ] **Step 1: Add buildChannelPostModal to modal.js**

At the end of `src/slack/modal.js` (after the closing `}` of `buildAuditLogModal`), append:

```js

export function buildChannelPostModal(text) {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: '📋 Channel post', emoji: true },
    close:  { type: 'plain_text', text: 'Close', emoji: true },
    blocks: [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_Select all and copy — then paste in the appropriate channel._' }],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };
}
```

- [ ] **Step 2: Run tests**

```bash
node test.js
```

Expected: `buildChannelPostModal` tests now pass. All old tests pass. Still failing: `buildResponseBlocks` diagnosis/chips/channel-post tests.

- [ ] **Step 3: Commit**

```bash
git add src/slack/modal.js
git commit -m "feat: add buildChannelPostModal"
```

---

## Task 5: Update buildResponseBlocks (diagnosis line, source chips, channel-post button)

**Files:**
- Modify: `src/slack/blocks.js:47-159` (`buildResponseBlocks` function)

- [ ] **Step 1: Insert diagnosis line after the info line (block 3)**

In `src/slack/blocks.js`, find the `buildResponseBlocks` function. After the block that pushes the context info line (the `blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: infoText }] })` call at line ~76), insert:

```js
  // Diagnosis line
  if (data.findings_summary?.diagnosis) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔍 _${data.findings_summary.diagnosis}_` }],
    });
  }

  // Source chips
  const chips = [];
  if ((data.atlassian_refs ?? []).some(r => r.type === 'confluence')) chips.push('📄 Confluence');
  if ((data.atlassian_refs ?? []).some(r => r.type === 'jira'))       chips.push('📄 Jira');
  if ((data.slack_refs    ?? []).length > 0)                          chips.push('💬 Slack');
  if ((data.kb_refs       ?? []).length > 0)                          chips.push('📖 KB');
  if (chips.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: chips.join('  ·  ') }],
    });
  }
```

The resulting block order inside `buildResponseBlocks` after the info line push should be:

```js
  // [existing] compact info line
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: infoText }],
  });

  // [NEW] diagnosis line
  if (data.findings_summary?.diagnosis) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔍 _${data.findings_summary.diagnosis}_` }],
    });
  }

  // [NEW] source chips
  const chips = [];
  if ((data.atlassian_refs ?? []).some(r => r.type === 'confluence')) chips.push('📄 Confluence');
  if ((data.atlassian_refs ?? []).some(r => r.type === 'jira'))       chips.push('📄 Jira');
  if ((data.slack_refs    ?? []).length > 0)                          chips.push('💬 Slack');
  if ((data.kb_refs       ?? []).length > 0)                          chips.push('📖 KB');
  if (chips.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: chips.join('  ·  ') }],
    });
  }

  // [existing] customer message
  if (data.customer_message) {
```

- [ ] **Step 2: Add channel-post button to the actions section**

In `buildResponseBlocks`, find the action buttons section (around line 107). After the existing Sources button block and before the `_showSpecialistValue` check, insert the channel-post button:

The full actions section should become:

```js
  // 5. Action buttons
  const actionElements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
      action_id: 'wrong_answer_modal',
      style: 'danger',
      value: JSON.stringify({
        query: (data._originalQuery ?? '').slice(0, 400),
        issueTitle: (data.issue_title ?? '').slice(0, 100),
        integrationType: (data.integration_type ?? '').slice(0, 50),
      }),
    },
  ];

  const totalRefs = (data.slack_refs ?? []).length + (data.atlassian_refs ?? []).length + (data.kb_refs ?? []).length;
  if (totalRefs > 0) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Diagnosis + Sources', emoji: true },
      action_id: 'view_sources_modal',
      value: _buildSourcesButtonValue(
        data.slack_refs     ?? [],
        data.atlassian_refs ?? [],
        data.kb_refs        ?? [],
        data.findings_summary?.diagnosis ?? null,
      ),
    });
  }

  if (data._showSpecialistValue) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
      action_id: 'show_specialist_detail',
      value: data._showSpecialistValue,
    });
  }

  if (data.escalate_decision?.should_escalate && data.suggested_channel_post) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📋 Channel post', emoji: true },
      action_id: 'copy_channel_post',
      value: (data.suggested_channel_post ?? '').slice(0, 2000),
    });
  }

  if (isDm) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '💬 New chat', emoji: true },
      action_id: 'new_chat',
      value: 'new_chat',
    });
  }

  blocks.push({ type: 'actions', elements: actionElements });
  blocks.push({ type: 'divider' });

  return blocks;
```

- [ ] **Step 3: Run tests**

```bash
node test.js
```

Expected: All new tests pass. All old tests pass. Zero failures.

- [ ] **Step 4: Commit**

```bash
git add src/slack/blocks.js
git commit -m "feat: add diagnosis line, source chips, and channel-post button to buildResponseBlocks"
```

---

## Task 6: Update mention.js follow-up path

**Files:**
- Modify: `src/handlers/mention.js:1-18` (imports)
- Modify: `src/handlers/mention.js:114-168` (follow-up block)

- [ ] **Step 1: Update imports in mention.js**

Replace the import block at lines 1–18 with:

```js
import { isAccountingTopic } from '../utils/accounting-filter.js';
import { queryWithContext, queryChat, queryWithKnowledge } from '../claude/query.js';
import { summarizeResultForHistory } from '../claude/prompts.js';
import { getHistory, hasHistory, appendToHistory } from '../slack/conversation.js';
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildChatResolutionBlocks,
} from '../slack/blocks.js';
import { getCached, setCached } from '../slack/cache.js';
import { getRelevantFeedback } from '../slack/feedback.js';
import { checkRateLimit, rateLimitResetIn } from '../utils/rate-limiter.js';
import { getKnowledge } from '../slack/knowledge.js';
import { nominateResponse } from '../slack/nominations.js';
import { searchKnowledgeBase } from '../claude/kb-search.js';
```

- [ ] **Step 2: Replace the follow-up block in mention.js**

In `src/handlers/mention.js`, replace lines 114–168 (the `// 5. Follow-up: active thread history` block through its closing `return;`) with:

```js
  // 5. Follow-up: active thread history → conversational mode
  if (hasHistory(threadTs)) {
    const history = getHistory(threadTs);

    let thinkingTs;
    try {
      const thinkingMsg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildThinkingBlocks(query),
        text: 'Thinking…',
      });
      thinkingTs = thinkingMsg.ts;
    } catch (err) {
      console.error('[mention] Failed to post thinking message:', err.message);
    }

    let chatResult;
    try {
      const [kbFetch] = await Promise.allSettled([searchKnowledgeBase(query)]);
      const kbContext = kbFetch.status === 'fulfilled' && kbFetch.value?.text ? kbFetch.value.text : null;
      chatResult = await queryChat(query, history, { kbContext });
    } catch (err) {
      console.error('[mention] queryChat failed:', err.message);
      const errText = 'Something went wrong — please retry or escalate manually.';
      if (thinkingTs) {
        await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText });
      } else {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errText });
      }
      return;
    }

    let blocks, plainText;
    if (chatResult.state === 'resolved') {
      blocks = buildChatResolutionBlocks(chatResult);
      plainText = `${chatResult.title} — ${chatResult.diagnosis}`;
    } else {
      const text = [chatResult.acknowledgement, chatResult.question].filter(Boolean).join('\n\n');
      blocks = buildFollowUpBlocks(text, { label: 'Diagnosing…' });
      plainText = text;
    }

    appendToHistory(threadTs, [
      { role: 'user',      content: query },
      { role: 'assistant', content: plainText },
    ]);

    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: plainText.slice(0, 200) });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: plainText.slice(0, 200) });
    }
    return;
  }
```

- [ ] **Step 3: Run tests**

```bash
node test.js
```

Expected: All tests pass. Zero failures. (mention.js changes are runtime-only — no new unit tests.)

- [ ] **Step 4: Commit**

```bash
git add src/handlers/mention.js
git commit -m "feat: update mention.js follow-up path to use KB context and resolution card"
```

---

## Task 7: Fix dm.js thread detection + add index.js copy_channel_post handler

**Files:**
- Modify: `src/handlers/dm.js:4-8` (add `_activeSessions`)
- Modify: `src/handlers/dm.js:28-40` (new_chat handler — track session TS)
- Modify: `src/handlers/dm.js:63-129` (app.message handler — logging + secondary detection + fallback path tracking)
- Modify: `src/index.js:5` (imports)
- Modify: `src/index.js:8` (imports)
- Modify: `src/index.js:99` (add copy_channel_post handler)

- [ ] **Step 1: Add _activeSessions Set to dm.js**

In `src/handlers/dm.js`, replace lines 4–8:

```js
export function registerDmHandler(app) {
  const _inFlight         = new Set();
  const _welcomed         = new Set();
  const _promptedSessions = new Set();
```

with:

```js
export function registerDmHandler(app) {
  const _inFlight         = new Set();
  const _welcomed         = new Set();
  const _promptedSessions = new Set();
  const _activeSessions   = new Set();
```

- [ ] **Step 2: Track session TS in new_chat handler**

Replace the `new_chat` handler (lines 27–40) with:

```js
  // "New chat" button — post a fresh session card to the DM channel
  app.action('new_chat', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    try {
      const sessionMsg = await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
      _activeSessions.add(sessionMsg.ts);
      setTimeout(() => _activeSessions.delete(sessionMsg.ts), 7 * 24 * 3_600_000);
    } catch (err) {
      logger.error('[dm] Failed to post session card:', err.message);
    }
  });
```

- [ ] **Step 3: Update start_chat_thread handler to also track session TS**

Replace the `start_chat_thread` handler (lines 42–60) with:

```js
  // "Ask an integration question" button — post thread prompt (double-click safe)
  app.action('start_chat_thread', async ({ ack, body, client, logger }) => {
    await ack();
    const channelId = body.channel.id;
    const sessionTs = body.message.ts;
    if (_promptedSessions.has(sessionTs)) return;
    _promptedSessions.add(sessionTs);
    setTimeout(() => _promptedSessions.delete(sessionTs), 86_400_000);
    _activeSessions.add(sessionTs);
    try {
      await client.chat.postMessage({
        channel:   channelId,
        thread_ts: sessionTs,
        text:      'What integration issue are you working on? 👇',
      });
    } catch (err) {
      logger.error('[dm] Failed to post thread prompt:', err.message);
      _promptedSessions.delete(sessionTs);
    }
  });
```

- [ ] **Step 4: Update app.message handler in dm.js**

Replace the entire `app.message` handler (lines 62–129) with:

```js
  // DM message handler — thread replies go to handleQuery; top-level triggers fallback
  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype === 'bot_message' || message.bot_id) return;

    logger.info(`[dm] Message: ts=${message.ts} thread_ts=${message.thread_ts ?? 'none'} channel_type=${message.channel_type} subtype=${message.subtype ?? 'none'}`);

    if (_inFlight.has(message.ts)) {
      logger.warn(`[dm] Duplicate event ${message.ts} — skipping`);
      return;
    }
    _inFlight.add(message.ts);

    const userId    = message.user;
    const channelId = message.channel;

    try {
      const isThreadReply =
        (message.thread_ts && message.thread_ts !== message.ts) ||
        _activeSessions.has(message.thread_ts);

      if (isThreadReply) {
        logger.info(`[dm] Thread reply: ts=${message.ts} thread_ts=${message.thread_ts} channel=${message.channel}`);
        await handleQuery({
          rawText:  message.text ?? '',
          channelId,
          threadTs: message.thread_ts,
          client,
          userId,
          isDm: true,
        });
        return;
      }

      // Top-level DM — fallback: welcome (if first contact) → session card → prompt → answer
      if (!_welcomed.has(userId)) {
        _welcomed.add(userId);
        await client.chat.postMessage({
          channel: channelId,
          blocks:  buildWelcomeCard(),
          text:    "👋 Welcome to IntBot!",
        });
      }

      const sessionMsg = await client.chat.postMessage({
        channel: channelId,
        blocks:  buildSessionCard(),
        text:    '🟢 Integration chat — ready when you are.',
      });
      const sessionTs = sessionMsg.ts;
      _activeSessions.add(sessionTs);
      setTimeout(() => _activeSessions.delete(sessionTs), 7 * 24 * 3_600_000);
      _promptedSessions.add(sessionTs);
      setTimeout(() => _promptedSessions.delete(sessionTs), 86_400_000);

      await client.chat.postMessage({
        channel:   channelId,
        thread_ts: sessionTs,
        text:      'What integration issue are you working on? 👇',
      });

      await handleQuery({
        rawText:  message.text ?? '',
        channelId,
        threadTs: sessionTs,
        client,
        userId,
        isDm: true,
      });
    } catch (err) {
      logger.error(`[dm] Error handling message ${message.ts}:`, err.message);
    } finally {
      setTimeout(() => _inFlight.delete(message.ts), 60_000);
    }
  });
```

- [ ] **Step 5: Update index.js imports**

`src/index.js` currently has no import from `./slack/modal.js`. Add one new line after line 8 (`import { saveFeedback, ... }`):

```js
import { buildChannelPostModal } from './slack/modal.js';
```

- [ ] **Step 6: Add copy_channel_post action handler to index.js**

In `src/index.js`, after the `view_sources_modal` handler block (around line 127), add:

```js
// ── "Channel post" button — opens copy-paste modal ───────────────────────────
app.action('copy_channel_post', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildChannelPostModal(body.actions[0].value),
    });
  } catch (err) {
    logger.error('[index] Failed to open channel post modal:', err.message);
  }
});
```

- [ ] **Step 7: Run tests**

```bash
node test.js
```

Expected: All tests pass. Zero failures.

- [ ] **Step 8: Commit**

```bash
git add src/handlers/dm.js src/index.js
git commit -m "feat: fix DM thread detection with _activeSessions; add copy_channel_post handler"
```

---

## Self-Review Checklist

After all tasks are complete, verify:

- [ ] `node test.js` → 0 failures
- [ ] `parseChatResponse` exported from query.js and importable in test.js
- [ ] `buildChatResolutionBlocks` exported from blocks.js
- [ ] `buildChannelPostModal` exported from modal.js
- [ ] `buildFollowUpBlocks` still works with 1 arg (no regression)
- [ ] `buildResponseBlocks` with no `findings_summary` → no crash
- [ ] `buildResponseBlocks` with `should_escalate: false` → no channel-post button
- [ ] `copy_channel_post` handler registered in index.js
- [ ] `_activeSessions` Set added to dm.js alongside `_inFlight`/`_welcomed`/`_promptedSessions`
