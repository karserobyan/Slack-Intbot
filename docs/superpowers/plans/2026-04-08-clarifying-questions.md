# Clarifying Questions + Response Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `clarifying_question` JSON field so Claude asks what the agent has already tried before answering vague queries, and strip visual noise from the initial response format.

**Architecture:** (1) Clean up `buildResponseBlocks` — confidence icon moves into the header, sources section and footer are removed. (2) Add `clarifying_question` to both JSON schemas and `SHARED_RULES`, update `summarizeResultForHistory` to include the question in history. (3) Wire the clarifying question branch in `mention.js` — when set, post the question and return early; normal flow continues when null.

**Tech Stack:** Node.js ESM, @slack/bolt v4, @anthropic-ai/sdk, custom `assert()` test runner (`node test.js`)

---

## File Map

| File | Change |
|---|---|
| `src/slack/blocks.js` | Move confidence icon to header; remove metadata line, sources section, footer |
| `src/claude/prompts.js` | Add `clarifying_question` to both JSON schemas and SHARED_RULES; update `summarizeResultForHistory` |
| `src/handlers/mention.js` | Branch on `result.clarifying_question` after `queryWithContext` |
| `test.js` | Update confidence badge tests; add `summarizeResultForHistory` clarifying_question tests |

---

### Task 1: Response format cleanup — `src/slack/blocks.js`

**Files:**
- Modify: `src/slack/blocks.js`
- Modify: `test.js`

#### Step 1.1 — Update failing tests first (TDD)

In `test.js`, find and replace the three confidence badge assertions and the context footer assertion. These are currently around lines 199–230 and line 109.

**Replace** the footer assertion:
```js
// OLD — remove this line:
assert(responseBlocks[responseBlocks.length - 1].type === 'context', 'Last block is context footer');

// NEW — replace with:
assert(!responseBlocks.some(b => b.type === 'context'), 'No context footer in response');
```

**Replace** the three confidence badge assertions:
```js
// OLD — remove these three blocks:
const highBadge = highConfBlocks.find(b => b.text?.text?.includes('High confidence'));
assert(highBadge !== undefined, 'High confidence badge rendered');

const medBadge = medConfBlocks.find(b => b.text?.text?.includes('Medium confidence'));
assert(medBadge !== undefined, 'Medium confidence badge rendered');

const lowBadge = lowConfBlocks.find(b => b.text?.text?.includes('Low confidence'));
assert(lowBadge !== undefined, 'Low confidence badge rendered');

// NEW — replace with:
const highHeader = highConfBlocks.find(b => b.type === 'header');
assert(highHeader?.text?.text?.startsWith('🟢'), 'High confidence shows 🟢 in header');

const medHeader = medConfBlocks.find(b => b.type === 'header');
assert(medHeader?.text?.text?.startsWith('🟡'), 'Medium confidence shows 🟡 in header');

const lowHeader = lowConfBlocks.find(b => b.type === 'header');
assert(lowHeader?.text?.text?.startsWith('🔴'), 'Low confidence shows 🔴 in header');
```

- [ ] Update confidence badge and footer assertions in `test.js`

#### Step 1.2 — Run tests to confirm they now fail

```bash
cd C:/Users/kserobyan/Slack-Intbot && node test.js 2>&1 | grep -E "(context footer|confidence|Results:)"
```

Expected: the 4 updated assertions fail (context footer still present, confidence icons not in header yet). All other assertions still pass.

- [ ] Run `node test.js` — confirm updated assertions fail

#### Step 1.3 — Update `buildResponseBlocks` header section

In `src/slack/blocks.js`, replace lines 35–58 (the header push + CONFIDENCE_DISPLAY + metadata section push):

```js
  // ── Header ──────────────────────────────────────────────────────────────
  const CONFIDENCE_DISPLAY = {
    high:   { icon: '🟢' },
    medium: { icon: '🟡' },
    low:    { icon: '🔴' },
  };
  const conf = CONFIDENCE_DISPLAY[data.confidence] ?? CONFIDENCE_DISPLAY.medium;

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${conf.icon} ${data.issue_title}`,
      emoji: true,
    },
  });
```

The exact string to replace is:
```js
  // ── Header ──────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `🔌 ${data.issue_title}`,
      emoji: true,
    },
  });

  const CONFIDENCE_DISPLAY = {
    high:   { icon: '🟢', label: 'High confidence' },
    medium: { icon: '🟡', label: 'Medium confidence' },
    low:    { icon: '🔴', label: 'Low confidence — email draft suppressed' },
  };
  const conf = CONFIDENCE_DISPLAY[data.confidence] ?? CONFIDENCE_DISPLAY.medium;

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Integration:* \`${data.integration_type}\`    *Sources:* ${(data.sources_used ?? []).map((s) => `\`${s}\``).join('  ')}    ${conf.icon} ${conf.label}`,
    },
  });
```

- [ ] Replace header + metadata section in `src/slack/blocks.js`

#### Step 1.4 — Remove sources section and footer from `buildResponseBlocks`

In `src/slack/blocks.js`, remove everything from the `// ── Sources ──` comment through the closing context footer push (lines 221–259). The `return blocks;` line stays.

The exact block to remove:
```js
  // ── Sources ──────────────────────────────────────────────────────────────
  const sourceLines = [];

  const slackRefs = (data.slack_refs ?? []).slice(0, 5);
  for (const ref of slackRefs) {
    const resolved = ref.was_resolved ? '✅' : '⏳';
    sourceLines.push(
      `${resolved} *#${ref.channel}*${ref.author ? ` (${ref.author})` : ''} — ${ref.issue_summary}`,
    );
  }

  const atlassianRefs = (data.atlassian_refs ?? []).slice(0, 5);
  for (const ref of atlassianRefs) {
    const icon = ref.type === 'jira' ? '🎟️' : '📄';
    const titleLink = ref.url ? `<${ref.url}|${ref.title}>` : ref.title;
    const statusPart = ref.status ? ` [${ref.status}]` : '';
    sourceLines.push(`${icon} ${titleLink}${statusPart} — ${ref.summary}`);
  }

  if (sourceLines.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📎 Sources Referenced*\n${sourceLines.join('\n')}`,
      },
    });
  }

  // Footer context block
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_IntegrationsBot • Sources searched: ${(data.sources_used ?? []).join(', ')} • Powered by Claude_`,
      },
    ],
  });
```

- [ ] Remove sources section and footer from `src/slack/blocks.js`

#### Step 1.5 — Run tests and confirm all pass

```bash
node test.js 2>&1 | tail -5
```

Expected: `Results: 135 passed, 0 failed out of 135 tests`

- [ ] Run `node test.js` — confirm all 135 assertions pass

#### Step 1.6 — Commit

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: clean up response format — confidence icon in header, remove sources and footer"
```

- [ ] Commit

---

### Task 2: `clarifying_question` field — `src/claude/prompts.js`

**Files:**
- Modify: `src/claude/prompts.js`
- Modify: `test.js`

#### Step 2.1 — Add failing tests for `summarizeResultForHistory` with `clarifying_question`

In `test.js`, find the existing `summarizeResultForHistory` test block (the one that starts with `const resultWithEscalate = {`). Add the following assertions immediately after the `noEmailSummary` assertion:

```js
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
```

- [ ] Add `clarifying_question` test assertions to `test.js`

#### Step 2.2 — Run tests to confirm they fail

```bash
node test.js 2>&1 | grep -E "(clarifying|Results:)"
```

Expected: the 3 new assertions fail. All others pass.

- [ ] Run `node test.js` — confirm new assertions fail

#### Step 2.3 — Update `summarizeResultForHistory` in `src/claude/prompts.js`

Find the `summarizeResultForHistory` function. Add one block after the confidence/sources line (after `lines.push(\`\nConfidence: ${confidence} | Sources: ${sources}\`)`):

```js
  if (result.clarifying_question) {
    lines.push(`\nI asked the agent: "${result.clarifying_question}"`);
  }
```

The full updated function looks like:
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

  if (result.clarifying_question) {
    lines.push(`\nI asked the agent: "${result.clarifying_question}"`);
  }

  return lines.join('\n');
}
```

- [ ] Add `clarifying_question` branch to `summarizeResultForHistory`

#### Step 2.4 — Add `clarifying_question` to `SYSTEM_PROMPT_CSA` JSON schema

In `src/claude/prompts.js`, find the CSA JSON schema. The current last two lines before the closing `}` are:

```
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"]
}
```

Replace with:
```
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"],
  "clarifying_question": "One focused question to ask the agent before answering, or null if the query already has enough context"
}
```

- [ ] Add `clarifying_question` field to CSA JSON schema

#### Step 2.5 — Add `clarifying_question` to `SYSTEM_PROMPT_SPECIALIST` JSON schema

In `src/claude/prompts.js`, find the Specialist JSON schema. Current last lines before `}`:

```
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"]
}
```

Replace with:
```
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"],
  "clarifying_question": "One focused question to ask the agent before answering, or null if the query already has enough context"
}
```

- [ ] Add `clarifying_question` field to Specialist JSON schema

#### Step 2.6 — Add clarifying question rule to `SHARED_RULES`

In `src/claude/prompts.js`, find `SHARED_RULES`. Add the following block immediately before the final line `Reply ONLY with valid JSON. No markdown fences. No explanation text outside the JSON.`:

```
CLARIFYING QUESTION — Before generating your full response, evaluate whether the query has enough context for a targeted answer.

Set "clarifying_question" to a single focused question when ALL of the following are true:
- No specific error code or error message was mentioned
- No steps already tried are mentioned
- Symptoms are vague ("not working", "stopped syncing", "not connecting") with no further detail
- The query is not a how-to or setup question (e.g. "how do I set up Zapier")

Set "clarifying_question" to null when ANY of the following is true:
- A specific error code or error message was mentioned
- The agent described what they have already tried
- The query has enough detail to know exactly what to check first
- The agent is asking how to do something rather than troubleshooting a failure

One question only. One sentence. Ask what would most change your troubleshooting path.
Good examples: "Has Zapier API access already been enabled on the backend, or is that still to check?" or "What error is the customer seeing — on the ServiceTitan side or in Zapier itself?"
```

This text is inserted immediately before the final line `Reply ONLY with valid JSON. No markdown fences. No explanation text outside the JSON.` — which stays as the last line of SHARED_RULES.

- [ ] Add clarifying question rule to `SHARED_RULES`

#### Step 2.7 — Run tests and confirm all pass

```bash
node test.js 2>&1 | tail -5
```

Expected: `Results: 138 passed, 0 failed out of 138 tests`

- [ ] Run `node test.js` — confirm all assertions pass

#### Step 2.8 — Commit

```bash
git add src/claude/prompts.js test.js
git commit -m "feat: add clarifying_question to prompts and summarizeResultForHistory"
```

- [ ] Commit

---

### Task 3: Wire clarifying question — `src/handlers/mention.js`

**Files:**
- Modify: `src/handlers/mention.js`

No automated tests — involves Slack API. Verification is manual (Step 3.3).

#### Step 3.1 — Add clarifying question branch after accounting check

In `src/handlers/mention.js`, find the comment `// 8. Update the thinking placeholder with the real response` (currently around line 257). Insert the following block immediately before it:

```js
  // 8a. If Claude needs clarification before answering fully — post question and wait
  if (result.clarifying_question) {
    const questionText = result.clarifying_question;
    if (thinkingTs) {
      await client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        blocks: buildFollowUpBlocks(questionText),
        text: questionText.slice(0, 200),
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildFollowUpBlocks(questionText),
        text: questionText.slice(0, 200),
      });
    }
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(result) },
    ]);
    return;
  }
```

- [ ] Add clarifying question branch to `mention.js`

#### Step 3.2 — Run tests to confirm no regressions

```bash
node test.js 2>&1 | tail -5
```

Expected: all tests still pass.

- [ ] Run `node test.js` — confirm zero regressions

#### Step 3.3 — Manual smoke test in Slack

Start the bot: `node src/index.js`

**Test A — vague query triggers clarifying question:**
1. Mention the bot with: `@IntegrationsBot Zapier is not working`
2. Expected: bot replies with a focused question (e.g. "Has Zapier API access been enabled on the backend?"), NOT the full structured answer.

**Test B — specific query skips clarifying question:**
1. Mention with: `@IntegrationsBot Customer getting error 401 when Zapier tries to authenticate — they say API access was set up last month but it stopped working after a password reset`
2. Expected: bot replies with the full structured Block Kit answer directly.

**Test C — agent answers the clarifying question:**
1. Reply in the same thread from Test A: `No, API access has not been enabled yet`
2. Expected: bot replies with a targeted answer — either conversational or structured depending on complexity.

**Test D — response is visually cleaner:**
1. Confirm the initial Block Kit response (from Test B) has:
   - Confidence icon (🟢/🟡/🔴) in the header title
   - No "Integration: `Zapier` Sources: `slack`" metadata line
   - No "📎 Sources Referenced" section
   - No footer context line

- [ ] Manual smoke test in Slack

#### Step 3.4 — Commit

```bash
git add src/handlers/mention.js
git commit -m "feat: wire clarifying question branch — ask before answering vague queries"
```

- [ ] Commit
