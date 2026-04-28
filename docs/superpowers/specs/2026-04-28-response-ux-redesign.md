# Response UX Redesign — Compact + Modals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce response block count and visual noise by merging the routing signal, confidence badge, and diagnosis callout into a single compact info line, and moving the diagnosis into the Sources modal.

**Architecture:** Three separate blocks (routing signal, confidence context, diagnosis) collapse into one muted context line. The existing `buildSourcesModal` is extended to accept a `diagnosis` field and render it as the first section. The `_buildSourcesButtonValue` helper carries `diagnosis` in the button payload so the modal handler has it at click time.

**Affected files:**
- `src/slack/blocks.js` — `buildResponseBlocks`, `buildSourcesModal`, `_buildSourcesButtonValue`
- `src/index.js` — `view_sources_modal` action handler
- `test.js` — updated assertions throughout

---

## Current vs New Block Structure

### Current (`buildResponseBlocks`)
1. Header — `🟢 Issue Title`
2. Divider
3. Diagnosis section — `*🔍 Root Cause* …` _(removed)_
4. Routing signal section — `✅ You've got this…` / `📢 Post in…` / `🔎 Post to verify…` _(removed)_
5. Customer message section — `*💬 Message the customer*\n_"…"_`
6. Steps header section — `*🔧 What you do*`
7–N. Step sections (one per step)
N+1. Confidence context block — `🟢 High confidence · Sources: slack, confluence` _(removed)_
N+2. Actions block
N+3. Divider

### New (`buildResponseBlocks`)
1. Header — `🟢 Issue Title`
2. Divider
3. **Compact info line** (context block) — _(new, replaces items 3, 4, N+1 above)_
4. Customer message section — `_"…"_` _(label text removed, just the message)_
5. Steps header section — `*🔧 What you do*`
6–N. Step sections (one per step)
N+1. Actions block — Sources button text changes to `🔍 Diagnosis + Sources`
N+2. Divider

Net change: **−3 blocks** on a typical response.

---

## Compact Info Line — Format Rules

The info line is a `context` block placed immediately after the opening divider. It adapts based on role and routing decision.

**CSA — handle yourself (high confidence):**
```
✅ Handle yourself · 🟢 High · [escalate_decision.reason]
```

**CSA — escalate:**
```
📢 Post in #[channel] · [conf.icon] [conf.label] · [channel_recommendation.reason]
```

**CSA — post to verify (medium/low confidence):**
```
🔎 Post to verify · [conf.icon] [conf.label] · [channel_recommendation.reason or escalate_decision.reason]
```

**Specialist (no escalate_decision):**
```
[conf.icon] [conf.label] confidence · Sources: [sources_used joined by ', ']
```

The reason text is sourced from `channel_recommendation.reason ?? escalate_decision.reason ?? ''`. It is truncated to 120 chars if longer.

---

## Customer Message Block

Remove the `*💬 Message the customer*` label line. The block becomes just:
```
_"[customer_message]"_
```
The `💬` emoji stays as a prefix inside the italic text:
```
💬 _"[customer_message]"_
```

---

## `buildSourcesModal` — Extended Signature

```js
export function buildSourcesModal({
  diagnosis = null,
  slack_refs = [],
  atlassian_refs = [],
  kb_refs = [],
} = {})
```

When `diagnosis` is present, prepend a diagnosis section as the first block:
```js
{
  type: 'section',
  text: { type: 'mrkdwn', text: `*🔍 Root Cause*\n${diagnosis}` },
}
```
followed by a divider, then the existing source sections unchanged.

Modal title changes from `📎 Sources` to `🔍 Diagnosis & Sources`. `callback_id` stays `sources_view`.

---

## `_buildSourcesButtonValue` — Extended Payload

Add `diagnosis` as a field (truncated to 300 chars, `null` if absent):

```js
function _buildSourcesButtonValue(slack_refs, atlassian_refs, kb_refs, diagnosis = null) {
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

The call site in `buildResponseBlocks` passes `data.findings_summary?.diagnosis ?? null` as the fourth argument.

Button text changes from `📎 Sources` to `🔍 Diagnosis + Sources`.

---

## `src/index.js` — view_sources_modal handler

The handler already destructures the button value. Extend to extract `diagnosis`:

The handler receives `({ body, client, ack })` from Bolt. The relevant change is destructuring `diagnosis` out of the parsed button value and passing it to `buildSourcesModal`:

```js
// before
const { slack_refs, atlassian_refs, kb_refs } = JSON.parse(body.actions[0].value);

// after
const { diagnosis, slack_refs, atlassian_refs, kb_refs } = JSON.parse(body.actions[0].value);
```

Pass `diagnosis` into the `buildSourcesModal` call alongside the existing ref arrays.

---

## `test.js` — Assertion Updates

### `buildResponseBlocks` assertions to remove
- `Diagnosis callout renders with 🔍 Root Cause label`
- `Diagnosis callout contains diagnosis text`
- `Customer talktrack renders with 💬 label` (label wording changes)
- `Routing signal: handle yourself renders ✅` (block type changes — now context, not section)
- All routing signal `.text.text.includes` pattern assertions — routing signal moves to info line

### `buildResponseBlocks` assertions to add
```js
const infoLine = responseBlocks.find(b => b.type === 'context');
assert(infoLine !== undefined, 'Compact info line is a context block');
assert(infoLine.elements[0].text.includes('✅'), 'Info line: handle yourself signal present');
assert(infoLine.elements[0].text.includes('High'), 'Info line: confidence label present');
assert(infoLine.elements[0].text.includes('CSA can'), 'Info line: routing reason present');

// Ensure removed blocks are gone
const noDiagBlock = responseBlocks.every(b => !b.text?.text?.includes('🔍 Root Cause'));
assert(noDiagBlock, 'Diagnosis block no longer inline in response');

// Customer message — no label
const custBlock = responseBlocks.find(b => b.text?.text?.includes('Zapier connection was reset'));
assert(custBlock !== undefined, 'Customer message block present');
assert(!custBlock.text.text.includes('Message the customer'), 'Customer message block has no label text');
```

### `buildSourcesModal` test updates
- Pass `diagnosis: 'Zapier cannot authenticate…'` to all `buildSourcesModal` calls
- Add assertion: `modal has 🔍 Root Cause section`
- Modal title assertion changes from `📎 Sources` to `🔍 Diagnosis & Sources`
- Import in test.js stays `buildSourcesModal` (function not renamed)

### Sources button text assertion
```js
const sourcesBtn = withRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(sourcesBtn?.text?.text === '🔍 Diagnosis + Sources', 'Sources button text updated');
```

---

## Unchanged
- `buildAuditBlocks` — not touched
- `buildFeedbackModal` — not touched
- `buildFollowUpBlocks` — not touched
- `buildHelpBlocks` / `buildHelpDetailBlocks` — not touched
- `buildNominationBlocks` — not touched
- All Specialist mode behaviour — info line adapts, no other changes
- `wrong_answer_modal` button — not touched
- `show_specialist_detail` button — not touched
- Step blocks format — not touched

---

## Out of Scope (future)
- DM interaction flow redesign
- Resolution tracking / outcome feedback
- Onboarding flow
