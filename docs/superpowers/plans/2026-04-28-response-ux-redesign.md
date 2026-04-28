# Response UX Redesign — Compact + Modals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three separate response blocks (routing signal, diagnosis callout, confidence context) with a single compact info line, and move diagnosis into the Sources modal alongside source links.

**Architecture:** All changes are in `src/slack/blocks.js` and `src/index.js`. Tests in `test.js` are updated before each implementation to maintain TDD discipline. No new files. The Sources button payload gains a `diagnosis` field; `buildSourcesModal` gains a `diagnosis` parameter; `buildResponseBlocks` loses three blocks and gains one.

**Tech Stack:** Node.js ESM, @slack/bolt v4 Block Kit

---

## File Map

| File | What changes |
|---|---|
| `src/slack/blocks.js` | `_buildSourcesButtonValue` (add `diagnosis`), `buildResponseBlocks` (compact info line, remove 3 blocks, update customer message), `buildSourcesModal` (add diagnosis section, update title) |
| `src/index.js` | `view_sources_modal` handler — destructure `diagnosis` from button value |
| `test.js` | Sources Button assertions, Block Kit Builder assertions, Sources Modal assertions |

---

## Codebase Context

Read these before starting:

- `src/slack/blocks.js:1–161` — `_buildSourcesButtonValue` (lines 26–43) and `buildResponseBlocks` (lines 45–161)
- `src/slack/blocks.js:406–462` — `buildSourcesModal`
- `src/index.js` — search for `view_sources_modal` to find the action handler (~line 156)
- `test.js` — the three relevant test sections: "Block Kit Builders" (~line 229), "Sources Modal" (~line 663), "Sources Button" (~line 707)

Key facts:
- `sampleJson` in `test.js` has `findings_summary.diagnosis` set and `sources_used: ['slack', 'confluence', 'jira', 'kb']` but **no** `escalate_decision` (Specialist mode)
- Current `buildResponseBlocks(sampleJson)` produces 12 blocks; after this work it produces 11
- `_buildSourcesButtonValue` currently takes 3 args; after this work it takes 4
- `buildSourcesModal` currently takes `{ slack_refs, atlassian_refs, kb_refs }`; after this work it takes `{ diagnosis, slack_refs, atlassian_refs, kb_refs }`

---

## Task 1 — Sources button: add `diagnosis` to payload, update button text

**Files:**
- Modify: `src/slack/blocks.js:26–43` (`_buildSourcesButtonValue`)
- Modify: `src/slack/blocks.js:135–146` (call site + button text)
- Modify: `test.js` (Sources Button section)

- [ ] **Step 1: Add three failing assertions to `test.js`**

In the "Sources Button" section, find the block that starts:
```js
const sourcesBtn = withRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(sourcesBtn !== undefined, 'Sources button appears when refs present');
assert(sourcesBtn?.value?.length <= 2000, 'Sources button value within 2000 chars');
```

Add immediately after those two existing assertions:
```js
assert(sourcesBtn?.text?.text === '🔍 Diagnosis + Sources', 'Sources button text updated');
const parsedSrcBtnValue = JSON.parse(sourcesBtn.value);
assert('diagnosis' in parsedSrcBtnValue, 'Sources button value contains diagnosis field');
assert(parsedSrcBtnValue.diagnosis !== null, 'Sources button value has non-null diagnosis when findings_summary present');
```

- [ ] **Step 2: Run tests — verify the three new assertions fail**

```bash
node test.js 2>&1 | grep -E "(Sources button text|diagnosis field|non-null diagnosis)"
```

Expected output:
```
  ❌ Sources button text updated
  ❌ Sources button value contains diagnosis field
  ❌ Sources button value has non-null diagnosis when findings_summary present
```

- [ ] **Step 3: Replace `_buildSourcesButtonValue` in `src/slack/blocks.js`**

Replace the entire function (lines 26–43):

```js
function _buildSourcesButtonValue(slack_refs, atlassian_refs, kb_refs, diagnosis = null) {
  const capRef = (ref) => ({
    url:   (ref.url   ?? '').slice(0, 150),
    title: (ref.title ?? '').slice(0, 60),
    ...(ref.channel ? { channel: ref.channel.slice(0, 40) } : {}),
    ...(ref.type    ? { type:    ref.type }                 : {}),
    ...(ref.snippet ? { snippet: ref.snippet.slice(0, 80) } : {}),
  });
  const diagStr = diagnosis ? String(diagnosis).slice(0, 300) : null;
  for (let n = 3; n >= 1; n--) {
    const v = JSON.stringify({
      diagnosis:      diagStr,
      slack_refs:     slack_refs.slice(0, n).map(capRef),
      atlassian_refs: atlassian_refs.slice(0, n).map(capRef),
      kb_refs:        kb_refs.slice(0, n).map(capRef),
    });
    if (v.length <= 1990) return v;
  }
  return JSON.stringify({ diagnosis: diagStr, slack_refs: [], atlassian_refs: [], kb_refs: [] });
}
```

- [ ] **Step 4: Update the Sources button in `buildResponseBlocks`**

Find the Sources button element in `buildResponseBlocks` (the block with `action_id: 'view_sources_modal'`):

```js
// before
{
  type: 'button',
  text: { type: 'plain_text', text: '📎 Sources', emoji: true },
  action_id: 'view_sources_modal',
  value: _buildSourcesButtonValue(
    data.slack_refs     ?? [],
    data.atlassian_refs ?? [],
    data.kb_refs        ?? [],
  ),
},
```

Replace with:
```js
// after
{
  type: 'button',
  text: { type: 'plain_text', text: '🔍 Diagnosis + Sources', emoji: true },
  action_id: 'view_sources_modal',
  value: _buildSourcesButtonValue(
    data.slack_refs     ?? [],
    data.atlassian_refs ?? [],
    data.kb_refs        ?? [],
    data.findings_summary?.diagnosis ?? null,
  ),
},
```

- [ ] **Step 5: Run tests — verify all pass**

```bash
node test.js 2>&1 | tail -4
```

Expected:
```
Results: 289 passed, 0 failed out of 289 tests
✅ All tests passed! Core functionality is working correctly.
```

- [ ] **Step 6: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add diagnosis to sources button payload; rename button to Diagnosis + Sources"
```

---

## Task 2 — `buildResponseBlocks`: compact info line, remove old blocks, update customer message

**Files:**
- Modify: `src/slack/blocks.js:45–161` (`buildResponseBlocks`)
- Modify: `test.js` (Block Kit Builders and routing signal sections)

- [ ] **Step 1: Update failing tests in `test.js` — diagnosis block assertions**

Find and **remove** these two assertions (in the "Diagnosis callout" comment block):
```js
// Diagnosis callout
const diagBlock = responseBlocks.find(b => b.text?.text?.includes('🔍 Root Cause'));
assert(diagBlock !== undefined, 'Diagnosis callout renders with 🔍 Root Cause label');
assert(diagBlock.text.text.includes('Zapier integration is failing'), 'Diagnosis callout contains diagnosis text');
```

Replace with:
```js
// Diagnosis no longer inline — moved to modal
const noDiagBlock = responseBlocks.every(b => !b.text?.text?.includes('🔍 Root Cause'));
assert(noDiagBlock, 'Diagnosis block is not inline in response (moved to modal)');
```

- [ ] **Step 2: Update failing tests — customer message assertions**

Find:
```js
// Customer talktrack
const talktackBlock = responseBlocks.find(b => b.text?.text?.includes('💬 Message the customer'));
assert(talktackBlock !== undefined, 'Customer talktrack renders with 💬 label');
assert(talktackBlock.text.text.includes('Zapier connection was reset'), 'Talktrack contains customer_message text');
```

Replace with:
```js
// Customer message — label removed, just the message
const talktackBlock = responseBlocks.find(b => b.text?.text?.includes('Zapier connection was reset'));
assert(talktackBlock !== undefined, 'Customer message block present');
assert(!talktackBlock.text.text.includes('Message the customer'), 'Customer message has no label text');
assert(talktackBlock.text.text.startsWith('💬'), 'Customer message starts with 💬 emoji');
```

- [ ] **Step 3: Update failing tests — compact info line assertions**

Find:
```js
assert(responseBlocks.some(b => b.type === 'context'), 'Contains confidence context block');
```

Add immediately after it (keeping the existing assertion — it still passes since there is a context block):
```js
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
```

- [ ] **Step 4: Update failing tests — routing signal section (section → context block)**

Find the entire "Routing signal scenarios" block (~lines 270–331) and replace it with the updated version that checks `context` blocks instead of `section` blocks:

```js
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
  ['✅', '📢', '🔎'].some(s =>
    b.text?.text?.includes(s) || b.elements?.[0]?.text?.includes(s)
  )
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
```

- [ ] **Step 5: Run tests — verify new assertions fail, old ones pass**

```bash
node test.js 2>&1 | grep "❌"
```

Expected: several failures about info line and routing signal assertions. No unexpected failures beyond these.

- [ ] **Step 6: Rewrite `buildResponseBlocks` in `src/slack/blocks.js`**

Replace the entire function body (lines 45–161) with:

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

  // 2. Compact info line
  const sourcesText = (data.sources_used ?? []).join(', ') || 'none';
  let infoText;
  if (data.escalate_decision) {
    const ed = data.escalate_decision;
    const channel = data.channel_recommendation?.channel ?? 'ask-integrations';
    const reason = (data.channel_recommendation?.reason ?? ed.reason ?? '').slice(0, 120);
    if (ed.should_escalate) {
      infoText = `📢 Post in #${channel} · ${conf.icon} ${conf.label} · ${reason}`;
    } else if (data.confidence === 'low' || data.confidence === 'medium') {
      infoText = `🔎 Post to verify · ${conf.icon} ${conf.label} · ${reason}`;
    } else {
      infoText = `✅ Handle yourself · ${conf.icon} High · ${reason}`;
    }
  } else {
    infoText = `${conf.icon} ${conf.label} confidence · Sources: ${sourcesText}`;
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: infoText }],
  });

  // 3. Customer message
  if (data.customer_message) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `💬 _"${data.customer_message}"_` },
    });
  }

  // 4. Steps header + steps
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

  blocks.push({ type: 'actions', elements: actionElements });
  blocks.push({ type: 'divider' });

  return blocks;
}
```

- [ ] **Step 7: Run tests — verify all pass**

```bash
node test.js 2>&1 | tail -4
```

Expected:
```
Results: NNN passed, 0 failed out of NNN tests
✅ All tests passed! Core functionality is working correctly.
```

(Exact count will increase from Task 1 baseline due to new routing/info line assertions.)

- [ ] **Step 8: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: replace routing signal, diagnosis, confidence blocks with compact info line"
```

---

## Task 3 — `buildSourcesModal`: add diagnosis section, update title

**Files:**
- Modify: `src/slack/blocks.js:406–462` (`buildSourcesModal`)
- Modify: `test.js` (Sources Modal section, ~lines 663–705)

- [ ] **Step 1: Update failing tests in `test.js` — Sources Modal section**

Find the start of the Sources Modal test section and update it as follows.

**Change 1** — the `fullRefsModal` call: add `diagnosis` to the argument:
```js
// before
const fullRefsModal = buildSourcesModal({
  slack_refs: [...],
  atlassian_refs: [...],
  kb_refs: [...],
});

// after
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
```

**Change 2** — add assertion for modal type (title changes):
```js
// before
assert(fullRefsModal.type === 'modal', 'buildSourcesModal returns modal type');
assert(typeof fullRefsModal.title === 'object', 'modal has title');

// after
assert(fullRefsModal.type === 'modal', 'buildSourcesModal returns modal type');
assert(typeof fullRefsModal.title === 'object', 'modal has title');
assert(fullRefsModal.title.text === '🔍 Diagnosis & Sources', 'modal title updated');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('🔍 Root Cause')), 'modal has diagnosis Root Cause section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('API access was never enabled')), 'modal diagnosis text present');
```

**Change 3** — update the `noArgsModal` fallback test (still works, but add a guard):
```js
// before
const noArgsModal = buildSourcesModal({});
assert(noArgsModal.type === 'modal', 'buildSourcesModal handles missing arrays without crash');

// after — no change needed, this still passes since diagnosis defaults to null
```

- [ ] **Step 2: Run tests — verify new assertions fail**

```bash
node test.js 2>&1 | grep -E "(modal title updated|Root Cause section|diagnosis text)"
```

Expected:
```
  ❌ modal title updated
  ❌ modal has diagnosis Root Cause section
  ❌ modal diagnosis text present
```

- [ ] **Step 3: Update `buildSourcesModal` in `src/slack/blocks.js`**

Replace the entire function (lines 406–462):

```js
export function buildSourcesModal({ diagnosis = null, slack_refs = [], atlassian_refs = [], kb_refs = [] } = {}) {
  const blocks = [];

  if (diagnosis) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔍 Root Cause*\n${diagnosis}` },
    });
    blocks.push({ type: 'divider' });
  }

  if (slack_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*💬 Slack (${slack_refs.length})*` },
    });
    for (const ref of slack_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• <${ref.url}|${ref.title}>\n  _${ref.channel}_` },
      });
    }
  }

  if (atlassian_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📄 Atlassian (${atlassian_refs.length})*` },
    });
    for (const ref of atlassian_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• <${ref.url}|${ref.title}>` },
      });
    }
  }

  if (kb_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📚 Knowledge Base (${kb_refs.length})*` },
    });
    for (const ref of kb_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• <${ref.url}|${ref.title}>\n  _${ref.snippet}_` },
      });
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No specific sources were found for this answer.' },
    });
  }

  return {
    type: 'modal',
    callback_id: 'sources_view',
    title: { type: 'plain_text', text: '🔍 Diagnosis & Sources', emoji: true },
    close: { type: 'plain_text', text: 'Close', emoji: true },
    blocks,
  };
}
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
node test.js 2>&1 | tail -4
```

Expected: `NNN passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: extend buildSourcesModal with diagnosis section; rename to Diagnosis & Sources"
```

---

## Task 4 — `index.js`: extract `diagnosis` from button value

**Files:**
- Modify: `src/index.js` (`view_sources_modal` action handler, ~line 156)

No test changes needed — this handler wires together two functions already tested individually.

- [ ] **Step 1: Update the `view_sources_modal` handler**

Find:
```js
app.action('view_sources_modal', async ({ ack, body, client, action }) => {
  await ack();
  let refsData = { slack_refs: [], atlassian_refs: [], kb_refs: [] };
  try { refsData = JSON.parse(action.value); } catch { /* show empty modal on bad JSON */ }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildSourcesModal(refsData),
  });
});
```

Replace with:
```js
app.action('view_sources_modal', async ({ ack, body, client, action }) => {
  await ack();
  let refsData = { diagnosis: null, slack_refs: [], atlassian_refs: [], kb_refs: [] };
  try { refsData = JSON.parse(action.value); } catch { /* show empty modal on bad JSON */ }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildSourcesModal(refsData),
  });
});
```

The only change is the default value for `refsData` gains `diagnosis: null`. `buildSourcesModal(refsData)` already passes the full object including `diagnosis` via destructuring — no further change needed.

- [ ] **Step 2: Run the full test suite one final time**

```bash
node test.js 2>&1
```

Expected: all tests pass, zero failures.

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "fix: pass diagnosis field through view_sources_modal handler to buildSourcesModal"
```

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review Checklist (pre-handoff)

- [x] `_buildSourcesButtonValue` — 4th `diagnosis` param, `diagStr` truncated to 300 chars, field present in all return paths
- [x] `buildResponseBlocks` — compact info line covers all 4 cases (CSA handle/escalate/verify, Specialist); old 3 blocks removed; customer message label removed
- [x] `buildSourcesModal` — `diagnosis` param added with `null` default; diagnosis section prepended when present; title updated; fallback ("No specific sources") still shown when `blocks.length === 0` after diagnosis + sources are both absent
- [x] `view_sources_modal` handler — default `refsData` includes `diagnosis: null` so bad JSON parse doesn't break modal
- [x] Test coverage — every spec requirement has a corresponding assertion
- [x] No placeholders in plan
