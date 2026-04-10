# Channel Recommendation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `channel_recommendation` field to CSA responses so the bot tells agents whether to post in `#ks-integration` (quick/sanity check) or `#ask-integrations` (complex issue), and adds `#ks-integration` as a Slack MCP search source.

**Architecture:** `SYSTEM_PROMPT_CSA` in `prompts.js` gains a new `channel_recommendation` field in its JSON schema plus classification rules. `blocks.js` renders the recommendation as a dedicated block after `escalate_decision`. No other files change.

**Tech Stack:** Same as project — Node.js ESM, existing `src/claude/prompts.js`, `src/slack/blocks.js`, `test.js`.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `test.js` | TDD: add failing tests for channel_recommendation block rendering |
| Modify | `src/claude/prompts.js` | Add `#ks-integration` to CSA search channels + `channel_recommendation` to JSON schema |
| Modify | `src/slack/blocks.js` | Render channel_recommendation block after escalate_decision |

---

## Task 1: Add failing tests to test.js (TDD red)

**Files:**
- Modify: `test.js`

- [ ] **Step 1: Find the block rendering test section**

Open `test.js`. Find the section that starts with:
```js
// intro_message rendering
```
This is inside `// ── 3. Block Kit Builders`. Add the new tests immediately after the existing specialist button tests (after the `assert(noBtn === undefined, ...)` line).

- [ ] **Step 2: Add the three channel_recommendation tests**

```js
// channel_recommendation rendering
const withKsChannel = buildResponseBlocks({
  ...sampleJson,
  channel_recommendation: { channel: 'ks-integration', reason: 'Quick sanity check — no company-wide visibility needed.' },
});
const ksBlock = withKsChannel.find(b => b.text?.text?.includes('ks-integration'));
assert(ksBlock !== undefined, 'channel_recommendation renders ks-integration block');
assert(ksBlock.text.text.includes('Quick sanity check'), 'ks-integration block includes reason');

const withAskChannel = buildResponseBlocks({
  ...sampleJson,
  channel_recommendation: { channel: 'ask-integrations', reason: 'Complex issue worth the whole team seeing.' },
});
const askBlock = withAskChannel.find(b => b.text?.text?.includes('ask-integrations'));
assert(askBlock !== undefined, 'channel_recommendation renders ask-integrations block');

const noChannelRec = buildResponseBlocks({ ...sampleJson });
const noChannelBlock = noChannelRec.find(b => b.text?.text?.includes('Post this in'));
assert(noChannelBlock === undefined, 'No channel recommendation block when field absent');
```

- [ ] **Step 3: Run tests — confirm exactly 3 new failures**

```bash
npm test
```

Expected: 3 new failures — `channel_recommendation renders ks-integration block`, `channel_recommendation renders ask-integrations block`, `No channel recommendation block when field absent`. All other tests pass.

- [ ] **Step 4: Commit the failing tests**

```bash
git add test.js
git commit -m "test: add channel_recommendation block rendering tests (red — implementation pending)"
```

---

## Task 2: Update SYSTEM_PROMPT_CSA in src/claude/prompts.js

**Files:**
- Modify: `src/claude/prompts.js`

- [ ] **Step 1: Add `#ks-integration` to the STEP 1 search description**

Find in `SYSTEM_PROMPT_CSA` (line ~90):
```
STEP 1 — Search before answering. Use your atlassian and slack search tools to find relevant Confluence pages, Jira tickets, and past Slack thread resolutions. A [TEAM KNOWLEDGE] block may also be present — treat it as authoritative.
```

Replace with:
```
STEP 1 — Search before answering. Use your atlassian and slack search tools to find relevant Confluence pages, Jira tickets, and past Slack thread resolutions. Search these Slack channels: #ask-integrations, #ask-leads-integration, #ks-integration, #200ok-specialists, and #integrations-ts-specialists. A [TEAM KNOWLEDGE] block may also be present — treat it as authoritative.
```

- [ ] **Step 2: Add `channel_recommendation` to the JSON schema**

Find in `SYSTEM_PROMPT_CSA` the JSON schema block. After the `escalate_decision` object and before `agent_steps`, add the new field:

Current (lines ~101–106):
```
  "escalate_decision": {
    "should_escalate": true | false,
    "reason": "clear explanation of why escalation is or isn't needed",
    "escalation_path": "e.g. Live Assist → Integrations Specialist (omit if should_escalate is false)"
  },
  "agent_steps": [
```

Replace with:
```
  "escalate_decision": {
    "should_escalate": true | false,
    "reason": "clear explanation of why escalation is or isn't needed",
    "escalation_path": "e.g. Live Assist → Integrations Specialist (omit if should_escalate is false)"
  },
  "channel_recommendation": {
    "channel": "ks-integration | ask-integrations",
    "reason": "one sentence explaining why this channel fits"
  },
  "agent_steps": [
```

- [ ] **Step 3: Add classification rules after the JSON schema block**

Find the line immediately after the closing `}` of the main JSON schema (before `For ACCOUNTING topics:`):

```
  "sources_used": ["slack", "confluence", "jira", "kb"]
}

For ACCOUNTING topics:
```

Replace with:
```
  "sources_used": ["slack", "confluence", "jira", "kb"]
}

Channel recommendation rules:
- Use "ks-integration" when: quick how-to, single setting to verify, sanity check, well-known issue with a clear established fix, CSA can likely resolve without broader team input
- Use "ask-integrations" when: unknown or unusual issue with no clear resolution, potential bug, involves multiple systems, something the whole integrations team should see, no relevant results found in searches

For ACCOUNTING topics:
```

- [ ] **Step 4: Run tests — confirm no new failures**

```bash
npm test
```

Expected: Same 3 failures from Task 1. No new failures — prompts.js changes don't affect test.js assertions.

- [ ] **Step 5: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: add channel_recommendation to SYSTEM_PROMPT_CSA — ks-integration vs ask-integrations routing"
```

---

## Task 3: Render channel_recommendation block in src/slack/blocks.js

**Files:**
- Modify: `src/slack/blocks.js`

- [ ] **Step 1: Add the channel_recommendation block after escalate_decision**

In `buildResponseBlocks`, find the escalate_decision block (lines ~55–66):

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

Immediately after that block (before the `// ── Section 1 — Agent Troubleshooting` comment), insert:

```js
  // ── Channel recommendation (CSA only) ────────────────────────────────────
  if (data.channel_recommendation) {
    const cr = data.channel_recommendation;
    const icon = cr.channel === 'ks-integration' ? '💬' : '📢';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *Post this in #${cr.channel}*\n_${cr.reason}_`,
      },
    });
    blocks.push({ type: 'divider' });
  }
```

- [ ] **Step 2: Run tests — confirm ALL tests pass**

```bash
npm test
```

Expected: All 98 + 3 new = 101 tests pass. The 3 previously failing channel_recommendation tests now pass.

- [ ] **Step 3: Commit**

```bash
git add src/slack/blocks.js
git commit -m "feat: render channel_recommendation block in CSA responses"
```

---

## Task 4: Push and verify

- [ ] **Step 1: Push to remote**

```bash
git push
```

- [ ] **Step 2: Restart the bot and send a test query as a CSA**

```bash
npm run dev
```

DM the bot: `How do I check if Zapier API access is enabled?`

Expected: Response includes a `💬 Post this in #ks-integration` block (quick sanity check).

Then try: `Customer has a Reserve with Google integration that suddenly stopped matching — they have 8 locations and nothing is syncing`

Expected: Response includes a `📢 Post this in #ask-integrations` block (complex, multi-location issue).
