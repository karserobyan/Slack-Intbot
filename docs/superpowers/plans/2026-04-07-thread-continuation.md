# Thread Continuation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix follow-up thread conversations so Claude has readable history context and follow-up replies render with Block Kit formatting instead of plain text.

**Architecture:** (1) A new `summarizeResultForHistory()` function converts the initial structured JSON response to human-readable text before storing it in conversation history, so Claude's follow-up queries see natural language instead of a JSON blob. (2) A new `buildFollowUpBlocks()` Block Kit builder wraps follow-up replies in a polished context-labeled format. (3) Both are wired into the follow-up path in `mention.js`.

**Tech Stack:** Node.js ESM, @slack/bolt v4, @anthropic-ai/sdk, custom `assert()` test runner (`node test.js`)

---

## File Map

| File | Change |
|---|---|
| `src/claude/prompts.js` | Add `summarizeResultForHistory()` export |
| `src/slack/blocks.js` | Add `buildFollowUpBlocks()` export |
| `src/handlers/mention.js` | Import both new functions; wire humanized history + follow-up blocks |
| `test.js` | Add test assertions for both new functions in existing sections |

---

### Task 1: `summarizeResultForHistory()` in `src/claude/prompts.js`

**Files:**
- Modify: `src/claude/prompts.js` (add export at end of file)
- Modify: `test.js` (add assertions to Section 2 — Claude Response Parsing, around line 98)

#### Step 1.1 — Add stub export to `src/claude/prompts.js`

Add this at the very end of `src/claude/prompts.js` (after line 259):

```js
/**
 * Converts a structured Claude result object into a human-readable text summary
 * suitable for storing as the assistant's turn in conversation history.
 * This replaces JSON.stringify(result) so Claude can naturally reference its prior response.
 *
 * @param {object} result - Parsed Claude response object
 * @returns {string} Human-readable summary
 */
export function summarizeResultForHistory(result) {
  // Stub — full implementation in next step
  return '';
}
```

- [ ] Add stub export to `src/claude/prompts.js`

#### Step 1.2 — Add import and failing tests to `test.js`

Update the import at the top of `test.js` (currently line 16):

```js
import { parseClaudeResponse, summarizeResultForHistory } from './src/claude/prompts.js';
```

Then add the following assertions immediately after the existing Section 2 tests (after line 98, before the `// ── 3. Block Kit Builders` comment):

```js
// summarizeResultForHistory
console.log('\n🔹 summarizeResultForHistory');

const resultWithEscalate = {
  intro_message: 'Hey Sarah, looks like a Zapier API access issue.',
  agent_steps: [
    { num: 1, title: 'Enable Zapier API', detail: 'Go to Admin > Integrations > Zapier and toggle API access on.', tag: 'backend' },
    { num: 2, title: 'Verify connection', detail: 'Ask customer to reconnect Zapier.', tag: 'verify' },
  ],
  escalate_decision: { should_escalate: false, reason: 'CSA can handle this directly' },
  customer_email: { subject: 'Re: Zapier Integration — ServiceTitan Support' },
  confidence: 'high',
  sources_used: ['slack', 'confluence'],
};

const histSummary = summarizeResultForHistory(resultWithEscalate);
assert(typeof histSummary === 'string', 'summarizeResultForHistory returns string');
assert(histSummary.includes('Hey Sarah'), 'summary includes intro_message');
assert(histSummary.includes('Enable Zapier API'), 'summary includes step title');
assert(histSummary.includes('backend'), 'summary includes step tag');
assert(histSummary.includes('No escalation needed'), 'summary includes no-escalation text');
assert(histSummary.includes('CSA can handle this directly'), 'summary includes escalation reason');
assert(histSummary.includes('Re: Zapier Integration'), 'summary includes email subject');
assert(histSummary.includes('high'), 'summary includes confidence');
assert(histSummary.includes('slack'), 'summary includes sources');
assert(!histSummary.includes('{'), 'summary contains no raw JSON');
assert(!histSummary.includes('"role"'), 'summary contains no JSON keys');

// Specialist mode — no escalate_decision field
const specialistResult = {
  intro_message: 'Hey Mike, here is the deep dive.',
  agent_steps: [{ num: 1, title: 'Check backend config', detail: 'Access the ST admin portal.', tag: 'backend' }],
  customer_email: { subject: 'Re: Procore Export — ServiceTitan Support' },
  confidence: 'medium',
  sources_used: ['jira'],
};
const specialistSummary = summarizeResultForHistory(specialistResult);
assert(!specialistSummary.includes('Escalation:'), 'no escalation line in specialist summary');
assert(specialistSummary.includes('Hey Mike'), 'specialist summary includes intro_message');

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
assert(stepLine.length < 400, 'long step detail is truncated');

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
```

- [ ] Add import and failing test assertions to `test.js`

#### Step 1.3 — Run tests and confirm failure

```bash
cd C:/Users/kserobyan/Slack-Intbot && node test.js
```

Expected: `summarizeResultForHistory` tests fail (stub returns `''`). All previously passing tests still pass.

- [ ] Run `node test.js` — confirm new assertions fail, old ones still pass

#### Step 1.4 — Implement `summarizeResultForHistory()`

Replace the stub in `src/claude/prompts.js` with the full implementation:

```js
export function summarizeResultForHistory(result) {
  if (result.is_accounting_topic) return '';

  const lines = [];

  if (result.intro_message) {
    lines.push(result.intro_message);
  }

  const steps = result.agent_steps ?? [];
  if (steps.length > 0) {
    lines.push('\nSteps I gave:');
    for (const step of steps) {
      const detail = (step.detail ?? '').slice(0, 300);
      lines.push(`${step.num}. ${step.title} (${step.tag}): ${detail}`);
    }
  }

  if (result.escalate_decision) {
    const ed = result.escalate_decision;
    if (ed.should_escalate) {
      const path = ed.escalation_path ? ` via ${ed.escalation_path}` : '';
      lines.push(`\nEscalation: Should escalate — ${ed.reason}${path}`);
    } else {
      lines.push(`\nEscalation: No escalation needed — ${ed.reason}`);
    }
  }

  if (result.customer_email) {
    lines.push(`\nCustomer email drafted: "${result.customer_email.subject}"`);
  }

  const confidence = result.confidence ?? 'unknown';
  const sources = (result.sources_used ?? []).join(', ') || 'none';
  lines.push(`\nConfidence: ${confidence} | Sources: ${sources}`);

  return lines.join('\n');
}
```

- [ ] Replace stub with full implementation in `src/claude/prompts.js`

#### Step 1.5 — Run tests and confirm pass

```bash
node test.js
```

Expected: all `summarizeResultForHistory` assertions pass, zero regressions.

- [ ] Run `node test.js` — confirm all assertions pass

#### Step 1.6 — Commit

```bash
git add src/claude/prompts.js test.js
git commit -m "feat: add summarizeResultForHistory — humanize assistant history storage"
```

- [ ] Commit

---

### Task 2: `buildFollowUpBlocks()` in `src/slack/blocks.js`

**Files:**
- Modify: `src/slack/blocks.js` (add export before the last `buildEmailModal` function)
- Modify: `test.js` (add assertions to Section 3 — Block Kit Builders, around line 141)

#### Step 2.1 — Add stub export to `src/slack/blocks.js`

Add this before `buildEmailModal` (before line 388 in `blocks.js`):

```js
/**
 * Builds Block Kit blocks for a follow-up conversational reply.
 * Middle-ground format: context label + markdown-enabled body.
 * Lighter than the initial structured response but clearly formatted.
 *
 * @param {string} text - Claude's plain text follow-up reply
 * @returns {Array} Slack blocks array
 */
export function buildFollowUpBlocks(text) {
  // Stub — full implementation in next step
  return [];
}
```

- [ ] Add stub export to `src/slack/blocks.js`

#### Step 2.2 — Add import and failing tests to `test.js`

Update the blocks import at the top of `test.js` (currently line 7–13):

```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildEmailModal,
  buildFollowUpBlocks,
} from './src/slack/blocks.js';
```

Add the following assertions in Section 3 — Block Kit Builders, immediately after the email modal tests (after line 141, before `// intro_message rendering`):

```js
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
```

- [ ] Add import and failing test assertions to `test.js`

#### Step 2.3 — Run tests and confirm failure

```bash
node test.js
```

Expected: `buildFollowUpBlocks` assertions fail (stub returns `[]`). All other tests still pass.

- [ ] Run `node test.js` — confirm new assertions fail, old ones still pass

#### Step 2.4 — Implement `buildFollowUpBlocks()`

Replace the stub in `src/slack/blocks.js`:

```js
export function buildFollowUpBlocks(text) {
  return [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Follow-up_' }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ];
}
```

- [ ] Replace stub with full implementation in `src/slack/blocks.js`

#### Step 2.5 — Run tests and confirm pass

```bash
node test.js
```

Expected: all `buildFollowUpBlocks` assertions pass, zero regressions.

- [ ] Run `node test.js` — confirm all assertions pass

#### Step 2.6 — Commit

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add buildFollowUpBlocks — Block Kit formatting for follow-up replies"
```

- [ ] Commit

---

### Task 3: Wire up in `src/handlers/mention.js`

**Files:**
- Modify: `src/handlers/mention.js`

No automated tests for this task — it involves Slack API calls. Verification is manual (see Step 3.5).

#### Step 3.1 — Update imports in `mention.js`

Current import at line 1:
```js
import { isAccountingTopic } from '../utils/accounting-filter.js';
```

Current import at line 8:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
} from '../slack/blocks.js';
```

There is no existing import from `prompts.js` in `mention.js` — add a new one.

Update the blocks import (line 8–13) to add `buildFollowUpBlocks`:

```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
} from '../slack/blocks.js';
```

Add a new import for `summarizeResultForHistory` after the query import (after line 3):

```js
import { summarizeResultForHistory } from '../claude/prompts.js';
```

- [ ] Update imports in `mention.js`

#### Step 3.2 — Upgrade follow-up thinking indicator (around line 90–99)

Current code (the follow-up thinking placeholder):

```js
let thinkingTs;
try {
  const thinkingMsg = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: 'Thinking…',
  });
  thinkingTs = thinkingMsg.ts;
} catch (err) {
  console.error('[mention] Failed to post thinking message:', err.message);
}
```

Replace with:

```js
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
```

- [ ] Replace plain-text thinking indicator with `buildThinkingBlocks(query)` in the follow-up path

#### Step 3.3 — Upgrade follow-up reply rendering (around line 122–127)

Current code (updating the thinking placeholder with the reply):

```js
if (thinkingTs) {
  await client.chat.update({ channel: channelId, ts: thinkingTs, text: replyText });
} else {
  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: replyText });
}
```

Replace with:

```js
if (thinkingTs) {
  await client.chat.update({
    channel: channelId,
    ts: thinkingTs,
    blocks: buildFollowUpBlocks(replyText),
    text: replyText.slice(0, 200),
  });
} else {
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: buildFollowUpBlocks(replyText),
    text: replyText.slice(0, 200),
  });
}
```

- [ ] Replace plain-text reply update with `buildFollowUpBlocks(replyText)`

#### Step 3.4 — Humanize history storage (two locations)

**Location A — Cache hit path (around line 150–155):**

Current code:
```js
appendToHistory(threadTs, [
  { role: 'user', content: query },
  { role: 'assistant', content: JSON.stringify(cached) },
]);
```

Replace with:
```js
appendToHistory(threadTs, [
  { role: 'user', content: query },
  { role: 'assistant', content: summarizeResultForHistory(cached) },
]);
```

**Location B — Normal Claude response path (around line 279–282):**

Current code:
```js
appendToHistory(threadTs, [
  { role: 'user', content: query },
  { role: 'assistant', content: JSON.stringify(result) },
]);
```

Replace with:
```js
appendToHistory(threadTs, [
  { role: 'user', content: query },
  { role: 'assistant', content: summarizeResultForHistory(result) },
]);
```

- [ ] Replace `JSON.stringify(cached)` with `summarizeResultForHistory(cached)` in cache hit path
- [ ] Replace `JSON.stringify(result)` with `summarizeResultForHistory(result)` in normal response path

#### Step 3.5 — Verify with `node test.js`

```bash
node test.js
```

Expected: all tests still pass (no regressions from wiring changes).

- [ ] Run `node test.js` — confirm zero regressions

#### Step 3.6 — Manual smoke test

Start the bot locally and test in Slack:

1. Ask the bot a question — confirm initial response renders normally (unchanged).
2. Follow up in the same thread — confirm:
   - Thinking indicator shows Block Kit card (not plain `Thinking…` text).
   - Reply renders with `_Follow-up_` context label and formatted body.
3. Ask a second follow-up that references something from the first answer — confirm Claude references specific steps or context from its prior response (not confused by JSON).

- [ ] Manual smoke test in Slack

#### Step 3.7 — Commit

```bash
git add src/handlers/mention.js
git commit -m "feat: wire humanized history + Block Kit follow-up into mention handler"
```

- [ ] Commit
