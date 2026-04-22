# Response Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the bot's Slack response structure — BLUF layout, prominent routing signal, role-tailored customer talktrack, and colorful numbered steps — replacing the current scattered multi-section format.

**Architecture:** Rewrite `buildResponseBlocks()` in `src/slack/blocks.js`, simplify `buildThinkingBlocks()`, update both system prompts in `src/claude/prompts.js` to add `customer_message` + `suggested_channel_post` and remove `intro_message`, update `summarizeResultForHistory()` to match, and update all affected tests in `test.js`.

**Tech Stack:** Slack Block Kit (section/header/context/actions only — no CSS), Node.js ESM

---

## Files touched

| File | What changes |
|---|---|
| `src/slack/blocks.js` | Rewrite `buildResponseBlocks()`, simplify `buildThinkingBlocks()`, add `TAG_CIRCLE` map |
| `src/claude/prompts.js` | Add `customer_message` + `suggested_channel_post` to both prompts, remove `intro_message`, add voice guidance, update `summarizeResultForHistory()` |
| `src/handlers/mention.js` | Change thinking fallback text (one line) |
| `test.js` | Update `sampleJson`, remove obsolete tests, add new routing signal + talktrack tests |

---

## Task 1: Update `summarizeResultForHistory` — swap `intro_message` → `customer_message`

**Files:**
- Modify: `src/claude/prompts.js:287-334`
- Modify: `test.js:114-213`

- [ ] **Step 1: Write the failing test**

In `test.js`, locate the `summarizeResultForHistory` section (around line 115). Replace the `resultWithEscalate` object and the assertions that reference `intro_message`:

```js
// REPLACE the resultWithEscalate object (currently around line 117):
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
```

```js
// REPLACE line 134:
assert(histSummary.includes('Hi Sarah'), 'summary includes customer_message');
```

```js
// REPLACE the specialistResult object (around line 146):
const specialistResult = {
  customer_message: 'Hi Mike, the API token was invalidated during the migration — I\'m re-issuing it now.',
  agent_steps: [{ num: 1, title: 'Check backend config', detail: 'Access the ST admin portal.', tag: 'backend' }],
  confidence: 'medium',
  sources_used: ['jira'],
};
```

```js
// REPLACE line 154:
assert(specialistSummary.includes('Hi Mike'), 'specialist summary includes customer_message');
```

- [ ] **Step 2: Run test to verify it fails**

```
node test.js 2>&1 | grep -E "(summary includes|specialist summary)"
```
Expected: both assertions FAIL (because `summarizeResultForHistory` still uses `intro_message`)

- [ ] **Step 3: Update `summarizeResultForHistory` in `src/claude/prompts.js`**

Find `summarizeResultForHistory` (around line 287). Replace:
```js
  if (result.intro_message) {
    lines.push(result.intro_message);
  }
```
With:
```js
  if (result.customer_message) {
    lines.push(result.customer_message);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```
node test.js 2>&1 | grep -E "(❌|summary includes|specialist summary|FAILED|passed)"
```
Expected: both assertions PASS, total failures unchanged or fewer

- [ ] **Step 5: Commit**

```bash
git add src/claude/prompts.js test.js
git commit -m "refactor: swap intro_message → customer_message in summarizeResultForHistory"
```

---

## Task 2: Rewrite `buildResponseBlocks` — new structure

**Files:**
- Modify: `src/slack/blocks.js:1-193`
- Modify: `test.js:63-93` (add `customer_message` to `sampleJson`)
- Modify: `test.js:215-377` (update block structure tests)

- [ ] **Step 1: Add `customer_message` to `sampleJson` in test.js**

Find `sampleJson` definition (around line 63). Add `customer_message` and `confidence` fields so the talktrack and confidence header render. Add after `is_accounting_topic`:

```js
  confidence: 'high',
  customer_message: 'Hi [Name], I can see exactly what happened — your Zapier connection was reset during our recent migration on our end. I\'m re-enabling it right now, and you\'ll just need to reconnect Zapier after. Give me one moment.',
```

- [ ] **Step 2: Write failing tests for new block structure**

In `test.js`, locate the `Block Kit Builders` section (around line 215). **Replace** the following blocks of tests with new ones:

**a) Replace the step-block regex test (around line 231):**
```js
// REPLACE lines 231-236 with:
const stepBlocks = responseBlocks.filter(b => b.type === 'section' && /\*\d+\. /.test(b.text?.text ?? ''));
assert(stepBlocks.length === 4, `All 4 agent steps rendered (found ${stepBlocks.length})`);
assert(stepBlocks[0].text.text.includes('`action`'), 'Step 1 has action tag');
assert(stepBlocks[1].text.text.includes('`backend`'), 'Step 2 has backend tag');
assert(stepBlocks[0].text.text.startsWith('🔵'), 'Action step has blue circle');
assert(stepBlocks[1].text.text.startsWith('🟠'), 'Backend step has orange circle');
assert(stepBlocks[2].text.text.startsWith('🟢'), 'Verify step has green circle');
assert(stepBlocks[3].text.text.startsWith('🔴'), 'Escalate step has red circle');
```

**b) Add new block structure tests** immediately after line 237 (after the step tag assertions):
```js
// Diagnosis callout
const diagBlock = responseBlocks.find(b => b.text?.text?.includes('🔍 Root Cause'));
assert(diagBlock !== undefined, 'Diagnosis callout renders with 🔍 Root Cause label');
assert(diagBlock.text.text.includes('Zapier integration is failing'), 'Diagnosis callout contains diagnosis text');

// Customer talktrack
const talktractBlock = responseBlocks.find(b => b.text?.text?.includes('💬 Message the customer'));
assert(talktractBlock !== undefined, 'Customer talktrack renders with 💬 label');
assert(talktractBlock.text.text.includes('Zapier connection was reset'), 'Talktrack contains customer_message text');

// Steps header
const stepsHeader = responseBlocks.find(b => b.text?.text === '*🔧 What you do*');
assert(stepsHeader !== undefined, 'Steps section header renders as "🔧 What you do"');
```

**c) Remove the following obsolete tests** (lines ~265-319 and ~346-356). Delete these entire blocks:
- `// intro_message rendering` through `assert(withIntro[0].text.text === ...)` (2 lines)
- `// escalate_decision rendering (CSA)` through `assert(escalateBlock !== undefined, ...)` (12 lines)
- `// No escalate_decision block for specialist` through `assert(noEscalate === undefined, ...)` (3 lines)
- `// channel_recommendation rendering` through `assert(noChannelBlock === undefined, ...)` (12 lines)
- `// Bottom Line renders for all confidence levels` through `assert(bottomLineBlock?.text?.text?.includes('_If re-auth still fails')` (11 lines)

**d) Update the `csaBlocks` test** (around line 288) — remove the `intro_message` and `escalate_decision` from it since it's testing the specialist detail button, not escalation:
```js
// REPLACE the csaBlocks block (lines 288-299):
const csaBlocksWithSpecBtn = buildResponseBlocks({
  ...sampleJson,
  _showSpecialistValue: JSON.stringify({ threadTs: '123', channelId: 'C123', query: 'test' }),
});
const specialistBtn = csaBlocksWithSpecBtn.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'show_specialist_detail');
assert(specialistBtn !== undefined, 'Show Specialist Detail button present when _showSpecialistValue set');

const noSpecialistBtn = buildResponseBlocks({ ...sampleJson });
const noBtn = noSpecialistBtn.find(b => b.type === 'actions')?.elements?.find(e => e.action_id === 'show_specialist_detail');
assert(noBtn === undefined, 'Show Specialist Detail button absent when _showSpecialistValue not set');
```

- [ ] **Step 3: Run tests to verify they fail**

```
node test.js 2>&1 | grep "❌" | head -20
```
Expected: failures for 🔍 Root Cause, 💬 Message the customer, 🔧 What you do, step circle emojis, and passes for removed tests (which no longer exist)

- [ ] **Step 4: Add `TAG_CIRCLE` map to `src/slack/blocks.js`**

After the `TAG_DISPLAY` constant (around line 11), add:

```js
const TAG_CIRCLE = {
  action:   '🔵',
  backend:  '🟠',
  verify:   '🟢',
  escalate: '🔴',
};
```

- [ ] **Step 5: Rewrite `buildResponseBlocks` in `src/slack/blocks.js`**

Replace the entire `buildResponseBlocks` function (lines 52-193) with:

```js
export function buildResponseBlocks(data) {
  const blocks = [];
  const conf = CONFIDENCE_META[data.confidence] ?? CONFIDENCE_META.medium;

  // 1. Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${conf.icon} ${data.issue_title}`, emoji: true },
  });
  blocks.push({ type: 'divider' });

  // 2. Diagnosis callout
  const diag = data.findings_summary?.diagnosis;
  const diagAction = data.findings_summary?.actions?.[0];
  if (diag) {
    let diagText = `*🔍 Root Cause*\n*${diag}*`;
    if (diagAction) diagText += `\n${diagAction}`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: diagText } });
  }

  // 3. Routing signal (CSA only — present when escalate_decision is set)
  if (data.escalate_decision) {
    const ed = data.escalate_decision;
    const channel = data.channel_recommendation?.channel ?? 'ask-integrations';
    const channelReason = data.channel_recommendation?.reason ?? ed.reason ?? '';
    const suggestedPost = data.suggested_channel_post ?? '';

    let routingText;
    if (ed.should_escalate) {
      routingText = `📢 *Post in #${channel}*\n_${channelReason}_`;
      if (suggestedPost) routingText += `\n> ${suggestedPost}`;
    } else if (data.confidence === 'low' || data.confidence === 'medium') {
      routingText = `🔎 *Post to verify — not fully certain*\n_${conf.label} confidence · ${channelReason}_`;
      if (suggestedPost) routingText += `\n> ${suggestedPost}`;
    } else {
      routingText = `✅ *You've got this — handle it yourself*\n_High confidence · no escalation needed_`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: routingText } });
  }

  // 4. Customer talktrack
  if (data.customer_message) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*💬 Message the customer*\n_"${data.customer_message}"_` },
    });
  }

  // 5. Steps header + steps
  const steps = (data.agent_steps ?? []).slice(0, 20);
  if (steps.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔧 What you do*' },
    });
    for (const step of steps) {
      const circle = TAG_CIRCLE[step.tag] ?? '⚪';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${circle} *${step.num}. ${step.title}*  \`${step.tag}\`\n${step.detail}`,
        },
      });
    }
  }

  // 6. Context footer
  const sourcesText = (data.sources_used ?? []).join(', ') || 'none';
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${conf.icon} ${conf.label} confidence · Sources: ${sourcesText}` }],
  });

  // 7. Action buttons
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
      text: { type: 'plain_text', text: '📎 Sources', emoji: true },
      action_id: 'view_sources_modal',
      value: _buildSourcesButtonValue(
        data.slack_refs     ?? [],
        data.atlassian_refs ?? [],
        data.kb_refs        ?? [],
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

  blocks.push({ type: 'actions', elements: actionElements });
  blocks.push({ type: 'divider' });

  return blocks;
}
```

- [ ] **Step 6: Run tests and verify they pass**

```
node test.js 2>&1 | grep -E "(❌|passed|failed)"
```
Expected: all new assertions pass; no failures from removed tests (they don't exist)

- [ ] **Step 7: Remove dead code in `src/slack/blocks.js`**

`TAG_DISPLAY` and `tagLabel` are no longer called by anything. Delete both:

```js
// DELETE these two declarations (lines ~6-21 in original file):
const TAG_DISPLAY = {
  action: '🔵 `action`',
  backend: '🟠 `backend`',
  verify: '🟢 `verify`',
  escalate: '🔴 `escalate`',
};

function tagLabel(tag) {
  return TAG_DISPLAY[tag] ?? `\`${tag}\``;
}
```

- [ ] **Step 8: Run full test suite to confirm clean**

```
node test.js
```
Expected: all tests pass, no reference errors

- [ ] **Step 9: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: rewrite buildResponseBlocks — BLUF layout, diagnosis callout, talktrack, colored steps"
```

---

## Task 3: Add routing signal tests

**Files:**
- Modify: `test.js` (add after the new block structure tests from Task 2)

- [ ] **Step 1: Write routing signal tests**

Add the following tests in `test.js` immediately after the `// Steps header` assertion from Task 2:

```js
// ── Routing signal scenarios ─────────────────────────────────────────────────

// Handle yourself — no escalation, high confidence
const handleYourselfBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'high',
  escalate_decision: { should_escalate: false, reason: 'CSA can handle this' },
  channel_recommendation: { channel: 'ks-integration', reason: 'Quick sanity check' },
});
const handleBlock = handleYourselfBlocks.find(b => b.text?.text?.includes('✅'));
assert(handleBlock !== undefined, 'Routing signal: handle yourself renders ✅');
assert(handleBlock.text.text.includes("You've got this"), 'Routing signal: handle yourself text correct');

// Post in channel — should_escalate: true
const escalateRoutingBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'high',
  escalate_decision: { should_escalate: true, reason: 'Needs backend access' },
  channel_recommendation: { channel: 'ask-integrations', reason: 'Team visibility needed' },
  suggested_channel_post: 'Anyone seen Zapier failing after migration for this tenant?',
});
const postBlock = escalateRoutingBlocks.find(b => b.text?.text?.includes('📢'));
assert(postBlock !== undefined, 'Routing signal: post in channel renders 📢');
assert(postBlock.text.text.includes('ask-integrations'), 'Routing signal: post in channel includes channel name');
assert(postBlock.text.text.includes('Anyone seen Zapier failing'), 'Routing signal: post in channel includes suggested post');

// Post to verify — low confidence
const lowConfRoutingBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'low',
  escalate_decision: { should_escalate: false, reason: 'Worth verifying with team' },
  channel_recommendation: { channel: 'ks-integration', reason: 'Check with team' },
  suggested_channel_post: 'Uncertain about this one — anyone confirm?',
});
const lowVerifyBlock = lowConfRoutingBlocks.find(b => b.text?.text?.includes('🔎'));
assert(lowVerifyBlock !== undefined, 'Routing signal: post to verify renders 🔎 for low confidence');
assert(lowVerifyBlock.text.text.includes('Post to verify'), 'Routing signal: post to verify text correct');
assert(lowVerifyBlock.text.text.includes('Uncertain about this one'), 'Routing signal: post to verify includes suggested post');

// Post to verify — medium confidence
const medConfRoutingBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'medium',
  escalate_decision: { should_escalate: false, reason: 'Partial match only' },
  channel_recommendation: { channel: 'ks-integration', reason: 'Verify steps' },
});
const medVerifyBlock = medConfRoutingBlocks.find(b => b.text?.text?.includes('🔎'));
assert(medVerifyBlock !== undefined, 'Routing signal: post to verify renders 🔎 for medium confidence');

// No routing signal when escalate_decision absent (Specialist)
const noRoutingBlocks = buildResponseBlocks({ ...sampleJson });
const noRouting = noRoutingBlocks.find(b => ['✅', '📢', '🔎'].some(s => b.text?.text?.includes(s)));
assert(noRouting === undefined, 'Routing signal: absent when no escalate_decision (Specialist mode)');

// should_escalate wins over low confidence (escalation more urgent)
const escalatePlusLowBlocks = buildResponseBlocks({
  ...sampleJson,
  confidence: 'low',
  escalate_decision: { should_escalate: true, reason: 'Escalation needed' },
  channel_recommendation: { channel: 'ask-integrations', reason: 'Team needed' },
});
const escalatePlusLowBlock = escalatePlusLowBlocks.find(b => b.text?.text?.includes('📢'));
assert(escalatePlusLowBlock !== undefined, 'Routing signal: should_escalate wins over low confidence');
```

- [ ] **Step 2: Run tests to verify they pass**

```
node test.js 2>&1 | grep -E "(Routing signal|❌)" | head -20
```
Expected: all 6 routing signal assertions PASS (implementation already in from Task 2)

- [ ] **Step 3: Commit**

```bash
git add test.js
git commit -m "test: add routing signal scenario coverage"
```

---

## Task 4: Simplify `buildThinkingBlocks` + update mention.js fallback text

**Files:**
- Modify: `src/slack/blocks.js:219-233`
- Modify: `src/handlers/mention.js:219`

- [ ] **Step 1: Verify existing thinking tests still pass (no change needed)**

The existing tests check:
- `thinkingBlocks.length === 2` — still true ✅
- `thinkingBlocks[0].text.text.includes('Checking')` — still true ✅
- `longThinking[0].text.text.length < 3100` — true since new format is ~150 chars max ✅

Run:
```
node test.js 2>&1 | grep -E "(Thinking|❌)"
```
Expected: all thinking assertions PASS (no test changes needed)

- [ ] **Step 2: Rewrite `buildThinkingBlocks` in `src/slack/blocks.js`**

Replace the function body (around line 219-233):

```js
export function buildThinkingBlocks(query) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔍 Checking…*\n_"${query.slice(0, 120)}${query.length > 120 ? '…' : ''}"_`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_IntegrationsBot is working on it…_' }],
    },
  ];
}
```

- [ ] **Step 3: Update mention.js fallback text**

In `src/handlers/mention.js`, find line 219:
```js
        text: 'Checking Confluence, Jira, and past Slack threads…',
```
Replace with:
```js
        text: 'Checking…',
```

- [ ] **Step 4: Run tests to verify still pass**

```
node test.js 2>&1 | grep -E "(❌|passed|failed)"
```
Expected: zero new failures

- [ ] **Step 5: Commit**

```bash
git add src/slack/blocks.js src/handlers/mention.js
git commit -m "feat: simplify thinking block to 'Checking…' — less noise in thread"
```

---

## Task 5: Update `SYSTEM_PROMPT_CSA` — add `customer_message`, `suggested_channel_post`, remove `intro_message`

**Files:**
- Modify: `src/claude/prompts.js:165-273`

- [ ] **Step 1: Remove `intro_message` from CSA JSON schema**

In `SYSTEM_PROMPT_CSA`, find and remove this line from the JSON template:
```
  "intro_message": "Hey [agent name], [1-2 warm sentences summarising the situation and what you're going to tell them]",
```

- [ ] **Step 2: Add `customer_message` and `suggested_channel_post` to CSA JSON schema**

In the CSA JSON template, add these two fields after `"confidence"`:

```json
  "customer_message": "First-person message to paste into the customer ticket. Assertive, charismatic, empathetic. Start with 'Hi [Name]' or 'Hey [Name]'. 2–4 sentences. CSA: friendly language, no jargon. See customer_message rules below.",
  "suggested_channel_post": "Ready-to-post Slack message when routing to a channel. Agent voice, not bot voice. States what the issue is, what was checked, and what's needed. 2–3 sentences. Omit this field entirely when not posting to a channel.",
```

- [ ] **Step 3: Update the character description at the top of CSA prompt**

Find:
```
Your character: knowledgeable senior colleague. Warm, direct, occasionally light. Confident but never dismissive. Address the agent by their first name in intro_message.
```
Replace with:
```
Your character: knowledgeable senior colleague. Warm, direct, occasionally light. Confident but never dismissive.
```

- [ ] **Step 4: Add `customer_message` voice guidance to CSA prompt**

Add this block immediately before `${SHARED_RULES}` at the bottom of the CSA prompt:

```
customer_message rules:
- Lead with empathy: acknowledge the disruption before explaining what you know
- Be assertive: state what you know is happening — never say "it seems like", "it might be", or "could be"
- Be charismatic: natural language, contractions, a hint of warmth — not corporate-flat
- Be specific: name the integration, what broke, and what the fix is
- Keep it tight: 2–4 sentences, no filler
- CSA voice: accessible, non-technical, reassuring
- Never start with "I" — always start with "Hi [Name]" or "Hey [Name]"
- Include what the customer needs to do after (if anything)
```

- [ ] **Step 5: Update suggested_channel_post guidance in CSA prompt**

Add this after the `customer_message rules` block:

```
suggested_channel_post rules:
- Include when: escalate_decision.should_escalate is true, OR confidence is low/medium
- Omit when: should_escalate is false AND confidence is high
- Agent-first-person voice ("Hey team — I'm seeing...")
- Include: integration name, what symptom was observed, what was checked, what you need
- 2–3 sentences max
```

- [ ] **Step 6: Run tests to verify nothing broke**

```
node test.js 2>&1 | grep -E "(❌|passed|failed)"
```
Expected: zero failures (prompts are not unit-tested beyond parseClaudeResponse)

- [ ] **Step 7: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: add customer_message + suggested_channel_post to CSA prompt, remove intro_message"
```

---

## Task 6: Update `SYSTEM_PROMPT_SPECIALIST` — add `customer_message`, remove `intro_message`

**Files:**
- Modify: `src/claude/prompts.js:336-417`

- [ ] **Step 1: Remove `intro_message` from Specialist JSON schema**

In `SYSTEM_PROMPT_SPECIALIST`, find and remove:
```
  "intro_message": "Hey [agent name], [1-2 sentences: situation + what follows]",
```

- [ ] **Step 2: Add `customer_message` to Specialist JSON schema**

After `"confidence"` in the Specialist JSON template, add:

```json
  "customer_message": "First-person message to paste into the customer ticket. Assertive, charismatic, empathetic. Start with 'Hi [Name]' or 'Hey [Name]'. 2–4 sentences. Specialist: peer-to-peer tone, technically precise, still warm. See customer_message rules below.",
```

Note: `suggested_channel_post` is **not** added to the Specialist prompt — Specialists own resolution end-to-end and do not route to channels.

- [ ] **Step 3: Update the character description at the top of Specialist prompt**

Find:
```
Your character: knowledgeable peer. Warm, direct, technical. Address the agent by their first name in intro_message. You can be slightly more concise since specialists don't need hand-holding.
```
Replace with:
```
Your character: knowledgeable peer. Warm, direct, technical. You can be slightly more concise since specialists don't need hand-holding.
```

- [ ] **Step 4: Add `customer_message` voice guidance to Specialist prompt**

Add this block immediately before `${SHARED_RULES}` at the bottom of the Specialist prompt:

```
customer_message rules:
- Lead with empathy: acknowledge the disruption before explaining what you know
- Be assertive: state what you know is happening — never say "it seems like", "it might be", or "could be"
- Be charismatic: natural language, contractions, a hint of warmth — not corporate-flat
- Be specific: name the integration, what broke, and what the fix is
- Keep it tight: 2–4 sentences, no filler
- Specialist voice: peer-to-peer, technically precise, warm but not hand-holdy
- Never start with "I" — always start with "Hi [Name]" or "Hey [Name]"
- Technical terms are fine; the customer may have some familiarity
```

- [ ] **Step 5: Run full test suite**

```
node test.js
```
Expected output ends with `X passed, 0 failed` (or a count close to what was passing before — the total may decrease by the number of deleted tests)

- [ ] **Step 6: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: add customer_message to Specialist prompt, remove intro_message"
```
