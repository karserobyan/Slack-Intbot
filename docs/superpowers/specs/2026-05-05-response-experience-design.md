# Response Experience — Design Spec

## Goal

Elevate the quality and trustworthiness of every bot response: surface the diagnosis directly on the card, show what was actually found, restructure the follow-up chat into a grounded diagnostic loop that ends with a compact resolution card, and fix the DM thread detection bug that opens a new session instead of continuing the conversation.

## Architecture

Four coordinated changes:

1. **Initial card** — `buildResponseBlocks` gains a diagnosis line and source chips. `suggested_channel_post` is surfaced via a new "📋 Channel post" button on escalation responses. A new `buildChannelPostModal` gives agents a copy-paste ready message.
2. **Chat prompt** — `CHAT_SYSTEM_PROMPT` is restructured to output JSON in both states (diagnosing and resolved). The resolved state requires searching all three sources before committing to an answer.
3. **Chat rendering** — `queryChat()` gains a `kbContext` parameter; `mention.js` pre-fetches KB in parallel and dispatches to the right renderer (`buildFollowUpBlocks` for questions, `buildChatResolutionBlocks` for answers). A new `buildChatResolutionBlocks` handles the resolution card with two visual states (resolved / escalation).
4. **DM thread bug fix** — `dm.js` gains an `_activeSessions` Set tracking posted session card TSs, giving a belt-and-suspenders fallback when `thread_ts` detection is unreliable.

---

## Affected Files

| File | Change |
|---|---|
| `src/slack/blocks.js` | Update `buildResponseBlocks` (diagnosis line, chips, channel post button); update `buildFollowUpBlocks` (optional label); add `buildChatResolutionBlocks` |
| `src/slack/modal.js` | Add `buildChannelPostModal` |
| `src/claude/prompts.js` | Restructure `CHAT_SYSTEM_PROMPT` — JSON output, source grounding rules |
| `src/claude/query.js` | Update `queryChat(userQuery, history, { kbContext })` — inject KB into system prompt |
| `src/handlers/mention.js` | Pre-fetch KB for `queryChat` calls; parse JSON; dispatch to right renderer |
| `src/handlers/dm.js` | Add `_activeSessions` Set; track session TSs; secondary thread detection; add logging |
| `src/index.js` | Add `copy_channel_post` action handler |
| `test.js` | New tests for all new builders; updated assertions for `buildResponseBlocks` |

---

## Section 1 — Initial Card (`buildResponseBlocks`)

### 1a. Diagnosis line

After the compact info line (block 2), insert a new context block:

```js
if (data.findings_summary?.diagnosis) {
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🔍 _${data.findings_summary.diagnosis}_` }],
  });
}
```

Placed between the info line and the customer message. Only rendered when `findings_summary.diagnosis` is present.

### 1b. Source chips

After the diagnosis block, insert source chips for each non-empty ref array:

```js
const chips = [];
if ((data.atlassian_refs ?? []).some(r => r.type === 'confluence')) chips.push('📄 Confluence');
if ((data.atlassian_refs ?? []).some(r => r.type === 'jira'))       chips.push('📄 Jira');
if ((data.slack_refs    ?? []).length > 0)                           chips.push('💬 Slack');
if ((data.kb_refs       ?? []).length > 0)                           chips.push('📖 KB');

if (chips.length > 0) {
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: chips.join('  ·  ') }],
  });
}
```

Only rendered when at least one ref array is non-empty. Chips are display-only labels — full links remain in the Sources modal.

### 1c. "📋 Channel post" button (escalation only)

In the action buttons section, after the existing buttons and before the isDm button, add:

```js
if (data.escalate_decision?.should_escalate && data.suggested_channel_post) {
  actionElements.push({
    type: 'button',
    text: { type: 'plain_text', text: '📋 Channel post', emoji: true },
    action_id: 'copy_channel_post',
    value: (data.suggested_channel_post ?? '').slice(0, 2000),
  });
}
```

Only rendered when the bot recommends escalation AND `suggested_channel_post` is non-empty.

---

## Section 2 — Channel Post Modal (`buildChannelPostModal`)

New export in `src/slack/modal.js`:

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

No submit button — view-only modal, agent selects and copies the text.

### `copy_channel_post` action handler in `src/index.js`

```js
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

---

## Section 3 — Chat Prompt Restructure (`CHAT_SYSTEM_PROMPT`)

Replace the current format section and the "NO JSON" hard rule with structured JSON output. All other hard rules (NO INVENTION, COMMON KNOWLEDGE IS READ-ONLY, STRAIGHT FACTS ONLY, NO REPEATED QUESTIONS, ONE QUESTION, ACCOUNTING EXCLUSION, HONESTY) are preserved unchanged.

### JSON schemas

**Diagnosing state:**
```json
{
  "state": "diagnosing",
  "acknowledgement": "One sentence stating what the agent's answer means diagnostically.",
  "question": "One yes/no question targeting the next most likely cause."
}
```

**Resolved state (handled, no escalation):**
```json
{
  "state": "resolved",
  "title": "Issue title, 6 words max",
  "diagnosis": "One sentence: what broke and why.",
  "steps": [
    { "tag": "action|backend|verify|escalate", "text": "Step instruction." }
  ],
  "escalate": false,
  "escalation_path": null,
  "suggested_channel_post": null,
  "refs": [
    { "source": "confluence|jira|slack|kb|knowledge", "title": "Brief description of what was found" }
  ]
}
```

**Resolved state (needs escalation):**
```json
{
  "state": "resolved",
  "title": "Issue title, 6 words max",
  "diagnosis": "One sentence: what broke and why.",
  "steps": [
    { "tag": "action", "text": "Collect error details from the customer." },
    { "tag": "escalate", "text": "Escalate via Live Assist → Integrations Specialist." }
  ],
  "escalate": true,
  "escalation_path": "Live Assist → Integrations Specialist",
  "suggested_channel_post": "Agent-voice message ready to paste in the channel. 2-3 sentences. States what the issue is, what was checked, and what's needed.",
  "refs": [
    { "source": "confluence", "title": "Zapier Enterprise Tier — backend configuration required" }
  ]
}
```

### New hard rules to add

```
HARD RULE — JSON OUTPUT ONLY: Every response must be a valid JSON object matching one of the two schemas above. No plain text, ever. No markdown fences around the JSON.

HARD RULE — SEARCH BEFORE RESOLVING: Before outputting "state": "resolved", you must have:
  1. Searched Atlassian (Confluence and Jira) via MCP tool.
  2. Searched Slack via MCP tool.
  3. Checked the [KB RESULTS] block provided above (if present).
Include one ref per source that returned something relevant. If a source returned nothing, omit it from refs. Common integration knowledge entries count as a ref with "source": "knowledge".

HARD RULE — NO UNGROUNDED RESOLUTION: If all three sources return nothing AND the issue is not covered by Common integration knowledge, do NOT output "state": "resolved". Stay in "state": "diagnosing", acknowledge the gap, and either ask one more targeted question or tell the agent you cannot find a grounded answer and they should escalate to #ask-integrations.
```

### Remove this hard rule

```
HARD RULE — NO JSON: Reply in plain conversational text only. No JSON output, ever.
```

### Updated format section

Replace the current "## How to respond" section with:

```
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
```

---

## Section 4 — `buildFollowUpBlocks` Update

Add an optional `label` parameter so the caller can change the context line:

```js
export function buildFollowUpBlocks(text, { label = 'Follow-up' } = {}) {
  return [
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_${label}_` }] },
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];
}
```

All existing call sites pass no second argument — behaviour is unchanged.

---

## Section 5 — `buildChatResolutionBlocks`

New export in `src/slack/blocks.js`:

```js
const CHAT_TAG_CIRCLE = { action: '🔵', backend: '🟠', verify: '🟢', escalate: '🔴' };
const CHAT_SOURCE_LABEL = { confluence: '📄 Confluence', jira: '📄 Jira', slack: '💬 Slack', kb: '📖 KB', knowledge: '📚 Team knowledge' };

export function buildChatResolutionBlocks(data) {
  const blocks = [];
  const isEscalation = data.escalate === true;

  // Badge
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: isEscalation ? '🔴 *Needs escalation*' : '✅ *Root cause found*' }],
  });

  // Title + diagnosis
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${data.title}*\n_${data.diagnosis}_` },
  });

  // Escalation path (only when escalating)
  if (isEscalation && data.escalation_path) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📍 *Escalation path:* ${data.escalation_path}` }],
    });
  }

  // Steps
  for (const step of (data.steps ?? []).slice(0, 10)) {
    const circle = CHAT_TAG_CIRCLE[step.tag] ?? '⚪';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${circle} \`${step.tag}\` ${step.text}` },
    });
  }

  // Source chips
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

  // Action buttons
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

---

## Section 6 — `queryChat` KB Context Injection

### Updated signature (`src/claude/query.js`)

```js
export async function queryChat(userQuery, history, { kbContext = null } = {}) {
```

### Inject KB block into system prompt

```js
const systemPrompt = kbContext
  ? `${CHAT_SYSTEM_PROMPT}\n\n[KB RESULTS]\n${kbContext}\n[/KB RESULTS]`
  : CHAT_SYSTEM_PROMPT;
```

Replace `system: CHAT_SYSTEM_PROMPT` with `system: systemPrompt` in the `anthropic.beta.messages.create` call.

### Return parsed object instead of string

Change the return from `return fullText;` to:

```js
return parseChatResponse(fullText);
```

Where `parseChatResponse` is a new function that attempts JSON parse and falls back to a plain-text diagnosing shape:

```js
function parseChatResponse(text) {
  try {
    const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const obj = JSON.parse(trimmed);
    if (obj.state === 'diagnosing' || obj.state === 'resolved') return obj;
  } catch {
    // fall through
  }
  // Fallback: treat as a plain diagnosing message
  return { state: 'diagnosing', acknowledgement: '', question: text };
}
```

Export `parseChatResponse` for testing.

---

## Section 7 — `mention.js` Follow-up Path

### Updated follow-up block (lines 115–167)

```js
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
    logger.error('[mention] Failed to post thinking message:', err.message);
  }

  let chatResult;
  try {
    const [kbFetch] = await Promise.allSettled([searchKnowledgeBase(query)]);
    const kbContext = kbFetch.status === 'fulfilled' && kbFetch.value?.text ? kbFetch.value.text : null;
    chatResult = await queryChat(query, history, { kbContext });
  } catch (err) {
    logger.error('[mention] queryChat failed:', err.message);
    const errText = 'Something went wrong — please retry or escalate manually.';
    if (thinkingTs) await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText });
    else await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errText });
    return;
  }

  // Dispatch to correct renderer
  let blocks, plainText;
  if (chatResult.state === 'resolved') {
    blocks = buildChatResolutionBlocks(chatResult);
    plainText = `${chatResult.title} — ${chatResult.diagnosis}`;
  } else {
    const text = [chatResult.acknowledgement, chatResult.question].filter(Boolean).join('\n\n');
    blocks = buildFollowUpBlocks(text, { label: 'Diagnosing…' });
    plainText = text;
  }

  // Append exchange to history (store plain text for context)
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

### New imports needed in `mention.js`

```js
import { buildChatResolutionBlocks } from '../slack/blocks.js';
import { searchKnowledgeBase } from '../claude/kb-search.js';
```

(`searchKnowledgeBase` may already be imported — verify before adding.)

---

## Section 8 — DM Thread Bug Fix (`dm.js`)

### `_activeSessions` Set

Add alongside the existing Sets:

```js
const _activeSessions = new Set();
```

### Track session TSs wherever a session card is posted

**In `new_chat` handler:**
```js
const sessionMsg = await client.chat.postMessage({
  channel: channelId,
  blocks:  buildSessionCard(),
  text:    '🟢 Integration chat — ready when you are.',
});
_activeSessions.add(sessionMsg.ts);
setTimeout(() => _activeSessions.delete(sessionMsg.ts), 7 * 24 * 3_600_000);
```

**In `start_chat_thread` handler** — `sessionTs` = `body.message.ts`, which is the session card TS. Track it here too for belt-and-suspenders:
```js
_activeSessions.add(sessionTs);
```
(The 7-day TTL was already set when the session card was posted via `new_chat`. This is a no-op if it's already there.)

**In the fallback path** (top-level DM → auto-session):
```js
const sessionTs = sessionMsg.ts;
_activeSessions.add(sessionTs);
setTimeout(() => _activeSessions.delete(sessionTs), 7 * 24 * 3_600_000);
```

### Strengthen thread detection in `app.message`

Update the detection condition:

```js
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
```

### Add logging at the top of the message handler

After the bot/subtype filter:

```js
logger.info(`[dm] Message: ts=${message.ts} thread_ts=${message.thread_ts ?? 'none'} channel_type=${message.channel_type} subtype=${message.subtype ?? 'none'}`);
```

This gives visibility into what Slack is sending if the bug recurs.

---

## Section 9 — Test Coverage

### `buildFollowUpBlocks` — label param
- Called with no second arg: context text is `_Follow-up_` (existing test still passes)
- Called with `{ label: 'Diagnosing…' }`: context text is `_Diagnosing…_`

### `buildChatResolutionBlocks` — resolved state
- Returns an array
- First block is context with text containing `Root cause found`
- Second block is section with `data.title` and `data.diagnosis`
- Steps block contains the step text
- Source chips context block rendered when `refs` non-empty
- Actions block contains `wrong_answer_modal` and `new_chat` buttons
- No `copy_channel_post` button when `escalate: false`

### `buildChatResolutionBlocks` — escalation state
- First block contains `Needs escalation`
- Escalation path context block present
- `copy_channel_post` button present when `escalate: true` and `suggested_channel_post` non-empty
- `new_chat` button still present

### `buildResponseBlocks` — diagnosis + chips
- Diagnosis context block present when `findings_summary.diagnosis` is set
- Diagnosis block absent when `findings_summary` is missing
- Confluence chip present when `atlassian_refs` contains a confluence entry
- Slack chip present when `slack_refs` non-empty
- KB chip present when `kb_refs` non-empty
- No chips rendered when all ref arrays are empty
- `copy_channel_post` button present when `should_escalate: true` and `suggested_channel_post` set
- `copy_channel_post` button absent when `should_escalate: false`

### `buildChannelPostModal`
- Returns a modal with `type: 'modal'`
- No submit button (view-only)
- Section block contains the provided text
- Title is `📋 Channel post`

### `parseChatResponse` (exported from query.js)
- Valid diagnosing JSON → returns `{ state: 'diagnosing', acknowledgement, question }`
- Valid resolved JSON → returns `{ state: 'resolved', title, diagnosis, steps, refs, ... }`
- JSON wrapped in markdown fences → parsed correctly
- Plain text fallback → returns `{ state: 'diagnosing', acknowledgement: '', question: text }`

---

## Out of Scope

- Channel mention responses — unaffected
- Audit log flow — unaffected
- App Home tab, nomination flow, feedback flow — unaffected
- Streaming responses
- `findings_summary.guidance` surfacing (minor, defer)
- Persistent `_activeSessions` across bot restarts (in-memory only, acceptable)
