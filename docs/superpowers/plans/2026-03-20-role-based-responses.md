# Role-Based Responses + Personality Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect CSA vs Specialist role from Slack profile title and respond with role-appropriate content, agent name greeting, and personality.

**Architecture:** `handleQuery` in `mention.js` calls `users.info` in parallel with the thinking placeholder post to detect role at zero latency cost. `queryWithContext` gains a `{ role, agentName }` options param and selects between two system prompts. `blocks.js` gains `intro_message`, escalate decision, and "Show Specialist Detail" button rendering. `index.js` registers the button handler and a startup scope check.

**Tech Stack:** Slack `users.info` API (`users:read` scope), existing `@anthropic-ai/sdk`, existing Bolt framework.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/handlers/mention.js` | Role detection via `users.info`, pass role+name to `queryWithContext` |
| Modify | `src/claude/query.js` | Accept `{ role, agentName }` options, select prompt by role |
| Modify | `src/claude/prompts.js` | Add `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST` |
| Modify | `src/slack/blocks.js` | `intro_message` block, escalate decision block, "Show Specialist Detail" button |
| Modify | `src/index.js` | Register `show_specialist_detail` handler, startup scope check |
| Modify | `test.js` | Tests for new block rendering and role-based JSON fields |

---

## Task 1: Add role detection tests to `test.js`

**Files:**
- Modify: `test.js`

- [ ] **Step 1: Add role classification tests**

Add a new section before the summary block in `test.js`:

```js
// ── Role Detection ─────────────────────────────────────────────────────────
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
```

- [ ] **Step 2: Add block rendering tests for `intro_message` and escalate decision**

Add to the Block Kit Builders section:

```js
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
```

- [ ] **Step 3: Run tests — confirm new tests FAIL**

```bash
npm test
```

Expected: FAIL — `intro_message` not yet rendered, escalate block not yet implemented, `_showSpecialistValue` button not yet added.

- [ ] **Step 4: Commit the failing tests**

```bash
git add test.js
git commit -m "test: add role detection and block rendering tests (red — implementation pending)"
```

---

## Task 2: Add `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST` to `prompts.js`

**Files:**
- Modify: `src/claude/prompts.js`

- [ ] **Step 1: Export a `buildSystemPrompt(role, agentName)` function**

Add after `SYSTEM_PROMPT` and `CHAT_SYSTEM_PROMPT`:

```js
/**
 * Shared intro paragraph for both role prompts.
 */
const SHARED_RULES = `
HARD RULE — DO NOT INVENT REFERENCES: Never fabricate Slack threads, Confluence pages, or Jira tickets. Only populate slack_refs and atlassian_refs with sources you actually found via search tools. If searches returned nothing useful, return empty arrays.

HARD RULE — ADMIT UNCERTAINTY: If searches return no relevant results and the issue is not in Common integration knowledge, do not invent steps. Include a single escalate step saying you could not find specific information.

HARD RULE — ACCOUNTING EXCLUSION:
If the question involves QuickBooks, Sage Intacct, NetSuite, Xero, Viewpoint Vista, accounts payable, accounts receivable, GL accounts, accounting integrations, chart of accounts, or journal entries — set "is_accounting_topic": true and provide only a redirect message.

HARD RULE — HONESTY: If you are not confident about specific steps, say so. Never invent menu paths or field names you are not sure about.

Tag guide for agent_steps:
- "action" — agent checks or configures something in the UI
- "backend" — requires admin/API action on the ServiceTitan backend
- "verify" — confirm the fix worked
- "escalate" — when to escalate and to whom

Common integration knowledge (use only when search returns nothing relevant):
- Zapier: Agent must enable Zapier API access on ST backend for the tenant.
- Angi/Angi Leads: Check booking provider IDs, job type mapping under Settings > Integrations > Marketing Integrations > Angi.
- Reserve with Google (RwG): Check Actions Center, verify account matching status.
- ServiceChannel: Check attachment settings, verify API credentials.
- Thumbtack: For redirect loop — clear cache/cookies, try incognito.
- Procore: Check cost code mappings for job cost export failures.
- Chat-to-Text widget: Verify embed code placement, check SMS number setup.

Reply ONLY with valid JSON. No markdown fences. No explanation text outside the JSON.`;

/**
 * System prompt for CSA (Customer Support Advocate) mode.
 * Focus: escalation decision first, basic steps, warm tone.
 */
export const SYSTEM_PROMPT_CSA = `You are IntegrationsBot — an internal assistant for ServiceTitan integrations support agents, in CSA mode.

You are helping a Customer Support Advocate (CSA). CSAs are front-line support agents who handle initial customer contact. They have limited backend access and rely on you to tell them whether to escalate or handle the issue themselves.

Your character: knowledgeable senior colleague. Warm, direct, occasionally light. Confident but never dismissive. Address the agent by their first name in intro_message.

STEP 1 — Search before answering. Use your atlassian and slack search tools to find relevant Confluence pages, Jira tickets, and past Slack thread resolutions. A [TEAM KNOWLEDGE] block may also be present — treat it as authoritative.

STEP 2 — Generate structured JSON output.

The most important field for CSAs is escalate_decision — lead with it. Tell them upfront whether this needs escalation and why. If no escalation needed, give them steps they can action themselves.

{
  "issue_title": "short title max 8 words",
  "integration_type": "specific integration name",
  "intro_message": "Hey [agent name], [1-2 warm sentences summarising the situation and what you're going to tell them]",
  "is_accounting_topic": false,
  "escalate_decision": {
    "should_escalate": true | false,
    "reason": "clear explanation of why escalation is or isn't needed",
    "escalation_path": "e.g. Live Assist → Integrations Specialist (omit if should_escalate is false)"
  },
  "agent_steps": [
    {
      "num": 1,
      "title": "Step title in plain language",
      "detail": "Specific instruction. If escalating: steps to take before handing off (info to gather, things to verify). If not escalating: full resolution steps.",
      "tag": "action | backend | verify | escalate"
    }
  ],
  "customer_email": {
    "subject": "Re: [Issue description] — ServiceTitan Integrations Support",
    "body": "Warm, human email body. Use \\n for line breaks. Sign off as:\\n\\nBest regards,\\nServiceTitan Integrations Support Team",
    "kb_links": [{ "label": "Link label", "url": "https://help.servicetitan.com/..." }]
  },
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"]
}

For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "customer_email": null, "slack_refs": [], "atlassian_refs": [], "sources_used": [] }

${SHARED_RULES}`;

/**
 * System prompt for Specialist mode.
 * Focus: full technical depth, root cause, all paths, no escalation decision.
 */
export const SYSTEM_PROMPT_SPECIALIST = `You are IntegrationsBot — an internal assistant for ServiceTitan integrations support agents, in Specialist mode.

You are helping an Integrations Specialist. Specialists have deep technical knowledge and backend access. They own resolution end-to-end. Give them the full picture — root cause, all resolution paths, backend steps, edge cases.

Your character: knowledgeable peer. Warm, direct, technical. Address the agent by their first name in intro_message. You can be slightly more concise since specialists don't need hand-holding.

STEP 1 — Search before answering. Use your atlassian and slack search tools. A [TEAM KNOWLEDGE] block may be present — treat it as authoritative.

STEP 2 — Generate structured JSON output. No escalate_decision field — specialists own the resolution.

{
  "issue_title": "short title max 8 words",
  "integration_type": "specific integration name",
  "intro_message": "Hey [agent name], [1-2 sentences: situation + what follows]",
  "is_accounting_topic": false,
  "agent_steps": [
    {
      "num": 1,
      "title": "Step title",
      "detail": "Full technical detail. Include backend steps, exact API paths, root cause notes, and alternative resolution paths where relevant.",
      "tag": "action | backend | verify | escalate"
    }
  ],
  "customer_email": {
    "subject": "Re: [Issue description] — ServiceTitan Integrations Support",
    "body": "Warm, professional email. Use \\n for line breaks. Sign off as:\\n\\nBest regards,\\nServiceTitan Integrations Support Team",
    "kb_links": [{ "label": "Link label", "url": "https://help.servicetitan.com/..." }]
  },
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"]
}

For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "customer_email": null, "slack_refs": [], "atlassian_refs": [], "sources_used": [] }

${SHARED_RULES}`;
```

- [ ] **Step 2: Run tests — verify no regressions**

```bash
npm test
```

Expected: Same failures as before (blocks not yet updated). No new failures. Prompt exports are available but block rendering isn't wired yet.

- [ ] **Step 3: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: add SYSTEM_PROMPT_CSA and SYSTEM_PROMPT_SPECIALIST for role-based responses"
```

---

## Task 3: Update `queryWithContext` signature in `src/claude/query.js`

**Files:**
- Modify: `src/claude/query.js`

- [ ] **Step 1: Update import to include new prompts**

```js
import { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT_CSA, SYSTEM_PROMPT_SPECIALIST, parseClaudeResponse } from './prompts.js';
```

- [ ] **Step 2: Update `queryWithContext` signature and prompt selection**

Change the function signature and add prompt selection at the top of the function:

```js
export async function queryWithContext(userQuery, { role = 'csa', agentName = null } = {}) {
```

After `const mcpServers = buildMcpServers();`, add:

```js
  // Select system prompt based on role. agentName is appended so Claude uses it.
  const basePrompt = role === 'specialist' ? SYSTEM_PROMPT_SPECIALIST : SYSTEM_PROMPT_CSA;
  const systemPrompt = agentName
    ? `${basePrompt}\n\nThe agent's display name is: ${agentName}. Use this name in intro_message.`
    : basePrompt;
```

Change `system: SYSTEM_PROMPT` in `requestParams` to `system: systemPrompt`.

Remove `SYSTEM_PROMPT` from the import line — it is no longer used after this change. `SYSTEM_PROMPT` is only used in `queryWithContext` (for the `requestParams.system` field) and that is now replaced by `systemPrompt`. The updated import line should be:

```js
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT_CSA, SYSTEM_PROMPT_SPECIALIST, parseClaudeResponse } from './prompts.js';
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: Same failures as before (blocks not updated yet). `queryWithContext` now accepts `{ role, agentName }` but block tests still fail.

- [ ] **Step 4: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: update queryWithContext to accept role and agentName options"
```

---

## Task 4: Update `src/slack/blocks.js`

**Files:**
- Modify: `src/slack/blocks.js`

- [ ] **Step 1: Add `intro_message` as the first block in `buildResponseBlocks`**

In `src/slack/blocks.js`, find the beginning of `buildResponseBlocks` (line 24). After the `const blocks = [];` line and before the `// ── Header` comment, insert:

```js
  // ── Intro message (personality greeting) ────────────────────────────────
  if (data.intro_message) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: data.intro_message },
    });
  }
```

The result (lines 24–36 after the edit) should look like:

```js
export function buildResponseBlocks(data) {
  const blocks = [];

  // ── Intro message (personality greeting) ────────────────────────────────
  if (data.intro_message) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: data.intro_message },
    });
  }

  // ── Header ──────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `🔌 ${data.issue_title}`,
      emoji: true,
    },
  });
  // ... rest of the function unchanged from this point
```

The guard `if (data.intro_message)` ensures the existing test (`assert(responseBlocks[0].type === 'header', ...)`) continues to pass because `sampleJson` has no `intro_message` field.

- [ ] **Step 2: Add escalate decision block after the divider that follows the header**

After `blocks.push({ type: 'divider' });` (the first divider after the integration/sources line), add:

```js
  // ── Escalate decision (CSA only) ─────────────────────────────────────────
  if (data.escalate_decision) {
    const ed = data.escalate_decision;
    const icon = ed.should_escalate ? '🔴' : '🟢';
    const decision = ed.should_escalate ? '*Escalate this case*' : '*Handle this yourself*';
    let text = `${icon} ${decision}\n_${ed.reason}_`;
    if (ed.should_escalate && ed.escalation_path) {
      text += `\n*Escalation path:* ${ed.escalation_path}`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    blocks.push({ type: 'divider' });
  }
```

- [ ] **Step 3: Add "Show Specialist Detail" button to the actions block**

In the actions block (where Copy Email and Wrong Answer buttons are), add the specialist button when `data._showSpecialistValue` is present:

```js
    const actionElements = [
      {
        type: 'button',
        text: { type: 'plain_text', text: '📋 Copy Email Draft', emoji: true },
        action_id: 'copy_email_modal',
        style: 'primary',
        value: JSON.stringify({
          subject: (email.subject ?? '').slice(0, 150),
          body: email.body.slice(0, 1800),
        }),
      },
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

    if (data._showSpecialistValue) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: '🔍 Show Specialist Detail', emoji: true },
        action_id: 'show_specialist_detail',
        value: data._showSpecialistValue,
      });
    }

    blocks.push({ type: 'actions', elements: actionElements });
```

- [ ] **Step 4: Run tests — confirm role-based block tests pass**

```bash
npm test
```

Expected: Role detection and block rendering tests pass. Remaining failures only if any.

- [ ] **Step 5: Commit**

```bash
git add src/slack/blocks.js src/claude/prompts.js src/claude/query.js test.js
git commit -m "feat: add intro_message, escalate_decision blocks and Show Specialist Detail button"
```

---

## Task 5: Wire role detection into `src/handlers/mention.js`

**Files:**
- Modify: `src/handlers/mention.js`

- [ ] **Step 1: Add the role detection helper function**

Add before `handleQuery`:

```js
/**
 * Detects agent role from Slack profile title.
 * Returns 'csa' | 'specialist'. Defaults to 'csa' on any failure.
 *
 * @param {object} client - Slack WebClient
 * @param {string} userId - Slack user ID
 * @returns {Promise<{ role: string, agentName: string }>}
 */
async function detectAgentRole(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    const profile = res.user?.profile ?? {};
    const title = profile.title ?? '';
    const agentName = profile.display_name || profile.real_name || null;

    let role = 'csa';
    if (/Specialist/i.test(title) && /Integrat/i.test(title)) {
      role = 'specialist';
    }
    // Customer Support Advocate already defaults to 'csa'

    return { role, agentName };
  } catch (err) {
    console.warn('[mention] users.info failed — defaulting to CSA mode:', err.message);
    return { role: 'csa', agentName: null };
  }
}
```

- [ ] **Step 2: Replace the thinking placeholder block with a parallel call**

In `mention.js`, find and replace the entire "3. Post thinking placeholder" block (lines 129–141):

```js
  // 3. Post "thinking" placeholder
  let thinkingTs;
  try {
    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildThinkingBlocks(query),
      text: 'Searching knowledge sources…',
    });
    thinkingTs = thinkingMsg.ts;
  } catch (err) {
    console.error('[mention] Failed to post thinking message:', err.message);
  }
```

Replace it with (the entire block, including the closing line that declares `thinkingTs`):

```js
  // 3. Detect role + post thinking placeholder in parallel (zero latency cost)
  const [{ role, agentName }, thinkingResult] = await Promise.allSettled([
    detectAgentRole(client, userId),
    client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildThinkingBlocks(query),
      text: 'Checking Confluence, Jira, and past Slack threads…',
    }).catch((err) => {
      console.error('[mention] Failed to post thinking message:', err.message);
      return null;
    }),
  ]).then(([roleResult, thinkingSettled]) => [
    roleResult.status === 'fulfilled' ? roleResult.value : { role: 'csa', agentName: null },
    thinkingSettled.status === 'fulfilled' ? thinkingSettled.value : null,
  ]);

  const thinkingTs = thinkingResult?.ts;
```

The old `let thinkingTs;` declaration is completely removed — `thinkingTs` is now declared via `const thinkingTs = thinkingResult?.ts;` at the end of the new block. Do not keep both or you will get a duplicate declaration error.

- [ ] **Step 3: Pass role and agentName to `queryWithContext`**

Change:
```js
result = await queryWithContext(query + feedbackContext);
```

To:
```js
result = await queryWithContext(query + feedbackContext, { role, agentName });
```

- [ ] **Step 4: Set `_showSpecialistValue` on the result for CSA responses**

After `result._originalQuery = query;` and before `setCached`, add:

```js
  // For CSA responses, attach value for the "Show Specialist Detail" button
  if (role === 'csa') {
    result._showSpecialistValue = JSON.stringify({
      threadTs,
      channelId,
      query: query.slice(0, 800),
    });
  }
```

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/mention.js
git commit -m "feat: wire role detection into handleQuery — CSA vs Specialist mode"
```

---

## Task 6: Register `show_specialist_detail` handler and startup scope check in `src/index.js`

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Update imports in `src/index.js`**

`src/index.js` already has these imports (lines 5–7):
```js
import { buildEmailModal, buildFeedbackModal } from './slack/blocks.js';
import { pruneExpired, cacheStats } from './slack/cache.js';
import { pruneConversations } from './slack/conversation.js';
```

Do NOT add duplicate module imports. Instead, merge the new names into the existing import lines:

Change line 5 (`blocks.js` import) to:
```js
import { buildEmailModal, buildFeedbackModal, buildResponseBlocks } from './slack/blocks.js';
```

Change line 7 (`conversation.js` import) to:
```js
import { pruneConversations, appendToHistory } from './slack/conversation.js';
```

Add one new standalone import for `queryWithContext` (not yet imported):
```js
import { queryWithContext } from './claude/query.js';
```

- [ ] **Step 2: Register the `show_specialist_detail` action handler**

After the `wrong_answer_modal` action handler, add:

```js
// ── "Show Specialist Detail" button ──────────────────────────────────────
app.action('show_specialist_detail', async ({ ack, body, client, action }) => {
  await ack();

  let context = { threadTs: null, channelId: null, query: '' };
  try {
    context = JSON.parse(action.value);
  } catch {
    // malformed value — abort
    return;
  }

  const { threadTs, channelId, query } = context;
  if (!threadTs || !channelId || !query) return;

  const userId = body.user.id;

  // Get agent name for personalised response
  let agentName = null;
  try {
    const res = await client.users.info({ user: userId });
    agentName = res.user?.profile?.display_name || res.user?.profile?.real_name || null;
  } catch {
    // non-critical
  }

  // Post a thinking placeholder in the thread
  let thinkingTs;
  try {
    const msg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: 'Pulling up the full specialist view…',
    });
    thinkingTs = msg.ts;
  } catch {
    // continue without placeholder
  }

  let result;
  try {
    result = await queryWithContext(query, { role: 'specialist', agentName });
  } catch (err) {
    app.logger.error('[show_specialist_detail] queryWithContext failed:', err.message);
    const errText = 'Something went wrong fetching specialist detail — please retry.';
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText });
    }
    return;
  }

  result._originalQuery = query;
  const responseBlocks = buildResponseBlocks(result);
  const fallbackText = `Specialist view: ${result.issue_title}`;

  if (thinkingTs) {
    await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: responseBlocks, text: fallbackText });
  } else {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: responseBlocks, text: fallbackText });
  }

  // Append to conversation history
  appendToHistory(threadTs, [
    { role: 'user', content: `[Specialist detail requested] ${query}` },
    { role: 'assistant', content: JSON.stringify(result) },
  ]);
});
```

- [ ] **Step 3: Add startup scope check**

In the startup IIFE (after the bot starts), add:

```js
  // Check users:read scope is available for role detection
  try {
    await app.client.users.info({ user: 'USLACKBOT' }); // USLACKBOT always exists
  } catch (err) {
    if (err.message?.includes('missing_scope')) {
      app.logger.error('[startup] WARNING: users:read scope missing — role detection will always default to CSA mode. Add users:read to bot token scopes and reinstall.');
    }
  }
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat: register show_specialist_detail handler and startup scope check"
```

---

## Task 7: Live test

- [ ] **Step 1: Start the bot**

```bash
npm run dev
```

- [ ] **Step 2: Test as CSA — DM or mention the bot**

Send: `Customer's Zapier integration isn't working — they say API access was never enabled.`

Expected:
- Response starts with intro_message greeting the agent by name
- Escalate/Don't Escalate decision block visible
- "Show Specialist Detail" button present at the bottom

- [ ] **Step 3: Click "Show Specialist Detail"**

Expected: Bot replies in the same thread with a fuller specialist response. No escalate_decision block. No "Show Specialist Detail" button.

- [ ] **Step 4: Test as Specialist**

Have a colleague with a Specialist title DM the bot with the same query.

Expected:
- intro_message present
- No escalate_decision block
- Deeper technical steps
- No "Show Specialist Detail" button
