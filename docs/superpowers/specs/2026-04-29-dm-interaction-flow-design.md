# DM Interaction Flow — Thread-per-Session

## Goal

Replace the current flat DM handler (all messages → `handleQuery()` directly) and the parked routing-buttons module with a thread-per-session model: a standing welcome card gives users a clear entry point, each "New chat" press creates one session card, and all conversation happens in that card's thread. The DM channel stays clean — just a stack of session cards.

## Architecture

**Three new event/action handlers** drive the flow: `app_home_opened` posts the standing welcome once; `new_chat` posts a session card; `start_chat_thread` activates the thread with a prompt. The DM message handler is extended to support the fallback path (user types directly in the DM). Two new block builders (`buildWelcomeCard`, `buildSessionCard`) are added to `blocks.js`. `buildResponseBlocks` gains an `isDm` flag that appends the "💬 New chat" button. `routing-buttons.js` is deleted entirely.

## Affected Files

- `src/slack/blocks.js` — `buildWelcomeCard`, `buildSessionCard`, `buildResponseBlocks` (isDm flag)
- `src/handlers/dm.js` — extended for fallback path; session thread detection
- `src/index.js` — `app_home_opened`, `new_chat`, `start_chat_thread` handlers; remove `integration_question` and `log_request`
- `src/slack/routing-buttons.js` — **deleted**
- `test.js` — new assertions for all new blocks and handlers

---

## The Flow

### State 1 — First contact: standing welcome card

**Trigger:** `app_home_opened` event (fires when the user clicks on the bot in the Slack sidebar).

**Behaviour:**
- On first fire per user, post the welcome card to the user's DM channel via `client.chat.postMessage`.
- Track welcomed users in an in-memory `Set` (`_welcomed`). On subsequent `app_home_opened` fires for the same user, do nothing.
- Resets on bot restart — acceptable; user will see one extra welcome card after a deploy. This is not disruptive since existing session cards remain in the DM.

**Also triggered on first DM message (dual-trigger):**
- If a user DMs the bot before `app_home_opened` has fired (e.g., they found the bot via search rather than the sidebar), the DM handler posts the welcome card on their first top-level message before creating the session card.
- The same `_welcomed` Set guards against double-posting: if `app_home_opened` already ran first, the DM handler skips welcome.

**Welcome card block structure (`buildWelcomeCard()`):**
```js
[
  { type: 'divider' },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*👋 Welcome to IntBot!*\nI diagnose integration issues and walk you through step-by-step fixes. Start a chat when you\'re ready.' },
  },
  {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '💬 New chat', emoji: true },
        action_id: 'new_chat',
        style: 'primary',
        value: 'new_chat',
      },
    ],
  },
]
```

---

### State 2 — Session card

**Trigger:** `new_chat` action (button on welcome card OR button on a response in a thread).

**Behaviour:**
- Post a session card as a **new top-level message** in the user's DM channel (not in a thread).
- The session card's `ts` becomes the `sessionTs` — it is the thread root for all conversation in this session.
- Store nothing server-side; the session lives as a Slack thread.

**Session card block structure (`buildSessionCard()`):**
```js
[
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*🟢 Integration chat*\nReady when you are.' },
  },
  {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '💬 Ask an integration question', emoji: true },
        action_id: 'start_chat_thread',
        value: 'start_chat_thread',
      },
    ],
  },
]
```

No parameters — the builder is stateless. The `channelId` needed at action time is read from `body.channel.id` by the handler, not encoded in the blocks.

---

### State 3 — Thread prompt

**Trigger:** `start_chat_thread` action (button on the session card).

**Behaviour:**
- Post a prompt message in the thread of the session card:
  ```
  What integration issue are you working on? 👇
  ```
- **Double-click guard:** track fired session card TSs in an in-memory `Set` (`_promptedSessions`). If the `sessionTs` is already in the set, `ack()` and return without posting. This prevents duplicate prompts from double-clicks or accidental re-presses.
- Add `sessionTs` to `_promptedSessions`. Clean up after 24 hours (`setTimeout(() => _promptedSessions.delete(sessionTs), 86_400_000)`).

---

### State 4 — Thread conversation

**Trigger:** User posts a message in the thread of a session card.

**Detection in DM handler:**
- A message is a **thread reply** when `message.thread_ts` is set and differs from `message.ts`.
- All thread replies in a DM → `handleQuery()` with `threadTs: message.thread_ts`, `isDm: true`. This is the same as the current handler; no special session-card detection is needed — any DM thread is a valid conversation thread.

**Response:**
- Identical block structure to channel responses (compact info line, customer message, steps, action buttons).
- `buildResponseBlocks(data, { isDm: true })` appends `💬 New chat` as the last action button:
  ```js
  {
    type: 'button',
    text: { type: 'plain_text', text: '💬 New chat', emoji: true },
    action_id: 'new_chat',
    value: 'new_chat',
  }
  ```
- Clicking "New chat" from within a thread posts a new session card at the top level of the DM. The user exits the thread to find it.

---

### Fallback — user types directly in the DM (top-level message)

**Trigger:** DM message where `message.thread_ts` is absent (top-level, not a thread reply).

**Behaviour:**
1. If user not yet welcomed (`!_welcomed.has(userId)`): post welcome card, add to `_welcomed`.
2. Post a session card (same as `new_chat` action).
3. Post the thread prompt in the session card's thread.
4. Add session card TS to `_promptedSessions`.
5. Call `handleQuery()` with `threadTs: sessionCardTs`, `isDm: true` — routing the user's message into the new thread as the first question.

This ensures users who skip the session card flow still get a clean thread-based response. No dead ends.

---

## `buildResponseBlocks` — isDm flag

**New signature:**
```js
export function buildResponseBlocks(data, { isDm = false } = {})
```

When `isDm` is `true`, the "New chat" button is appended as the last element in the actions block:
```js
{
  type: 'button',
  text: { type: 'plain_text', text: '💬 New chat', emoji: true },
  action_id: 'new_chat',
  value: 'new_chat',
}
```

All callers that pass `isDm: true` (the DM handler via `handleQuery`) will get this button. Channel responses are unaffected (`isDm` defaults to `false`).

`handleQuery` in `mention.js` already receives `isDm`. There are four `buildResponseBlocks` call sites in that file (lines 179, 231, 238, 368) — all must become `buildResponseBlocks(data, { isDm })` so the flag propagates correctly.

---

## What Is Removed

| What | Where | Why |
|---|---|---|
| `routing-buttons.js` | entire file deleted | Replaced by session card flow |
| `integration_question` action handler | `src/index.js` lines 44–62 | No longer needed |
| `log_request` action handler | `src/index.js` lines 64–78 | Log Request feature removed |
| `registerDmHandlerWithRouting` | was in routing-buttons.js | Deleted with file |
| `buildRoutingButtons` | was in routing-buttons.js | Deleted with file |

The `buildAuditLogModal` function and the Kibana audit log flow in channel mentions are **not touched**.

---

## Test Coverage

### `buildWelcomeCard`
- Returns an array of blocks
- Contains action with `action_id: 'new_chat'`
- Button text is `'💬 New chat'`
- Button style is `'primary'`

### `buildSessionCard`
- Returns an array of blocks
- Contains `*🟢 Integration chat*` in a section block
- Contains action with `action_id: 'start_chat_thread'`
- Button text is `'💬 Ask an integration question'`

### `buildResponseBlocks` — isDm flag
- Without `isDm`: actions block does NOT contain `new_chat` button
- With `isDm: true`: actions block contains button with `action_id: 'new_chat'` and text `'💬 New chat'`
- All existing response assertions still pass when `isDm` is omitted (default `false`)

---

## Out of Scope

- App Home tab UI (the visual tab in Slack apps) — not touched
- Persistent welcome tracking across bot restarts (in-memory only)
- Analytics or session tracking beyond what thread history provides
- Resolution journey / outcome tracking (future sub-project)
