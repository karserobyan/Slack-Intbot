# Thread Continuation UX — Design Spec

**Date:** 2026-04-07  
**Branch:** `claude/servicetitan-slack-bot-Bvw77`  
**Status:** Approved

---

## Problem

Two issues degrade the follow-up thread experience:

**B — Broken history context.** The initial bot response is stored in conversation history as raw `JSON.stringify(result)`. When Claude reads this back during a follow-up query, its "prior turn" is a giant JSON blob. It cannot naturally reference what it said, cite specific steps, or build on its previous answer conversationally.

**C — Poor visual experience.** Follow-up replies are plain text. The thinking indicator is a bare `"Thinking…"` string. There are no Block Kit blocks, no formatting, no visual continuity with the initial structured response.

---

## Approach

**Humanize at storage time.** Convert the structured JSON result into a readable text summary before storing it as the assistant's history turn. The store stays clean permanently — no on-the-fly transforms needed.

**Add follow-up Block Kit.** A new `buildFollowUpBlocks()` builder renders follow-up replies with a polished middle-ground look: a subtle context header + markdown-enabled body. The follow-up thinking indicator also gets the same Block Kit treatment as the initial path.

---

## Design

### 1. `summarizeResultForHistory(result)` — `src/claude/prompts.js`

New exported function. Called instead of `JSON.stringify(result)` when saving the initial response to conversation history.

Output format (plain text, readable by Claude as its own prior turn):

```
[intro_message]

Steps I gave:
1. [title] ([tag]): [detail]
2. ...

Escalation: [should_escalate ? "Should escalate — [reason] via [escalation_path]" : "No escalation needed — [reason]"]

Customer email drafted: "[subject]"

Confidence: [confidence] | Sources: [sources_used joined with ", "]
```

Rules:
- `intro_message` always leads — it's the most natural entry point for Claude to recall.
- Steps are numbered, include title, tag, and detail. Detail is truncated to 300 chars to keep history from ballooning.
- `escalate_decision` block only included if `result.escalate_decision` exists (Specialist mode omits it).
- `customer_email` line only included if `result.customer_email` is non-null (suppressed on low confidence).
- `is_accounting_topic: true` results should never reach this function (they skip history seeding entirely) — but guard with an early return just in case.

### 2. `buildFollowUpBlocks(text)` — `src/slack/blocks.js`

New exported function. Returns a Block Kit block array for follow-up replies.

Structure:
```
[context block]  →  "_Follow-up_"  (muted label, sets conversation framing)
[section block]  →  markdown-enabled body text (Claude's reply)
```

- Uses `mrkdwn: true` on the section so bold, italics, and bullet points in Claude's reply render.
- No dividers, no heavy card chrome — lighter than the initial response but clearly formatted.
- `text` fallback set to first 200 chars of the reply for notifications.

### 3. Wiring in `src/handlers/mention.js`

**History storage (two locations):**

- Line ~150 (cache hit path): change `JSON.stringify(cached)` → `summarizeResultForHistory(cached)`
- Line ~279 (normal path after Claude response): change `JSON.stringify(result)` → `summarizeResultForHistory(result)`

**Follow-up thinking indicator (~line 92):**

- Change from posting plain `text: 'Thinking…'` to using `buildThinkingBlocks(query)` — same as the initial path. This gives visual continuity.

**Follow-up reply rendering (~line 123):**

- Change from `client.chat.update({ text: replyText })` to `client.chat.update({ blocks: buildFollowUpBlocks(replyText), text: replyText.slice(0, 200) })`.
- Same for the fallback `postMessage` path on line ~125.

---

## Files Changed

| File | Change |
|---|---|
| `src/claude/prompts.js` | Add `summarizeResultForHistory()` export |
| `src/slack/blocks.js` | Add `buildFollowUpBlocks()` export |
| `src/handlers/mention.js` | Wire up both: humanized history + follow-up blocks |

No changes to `conversation.js`, `query.js`, `dm.js`, or any prompts.

---

## Out of Scope

- DM handler (`dm.js`) — it reuses `handleQuery`, so it gets the history fix for free. No separate work needed.
- `CHAT_SYSTEM_PROMPT` — no changes needed. The prompt already instructs Claude to reference prior context naturally; the problem was the data, not the instructions.
- Streaming — not in scope.

---

## Success Criteria

1. After an initial response, the stored assistant history turn is human-readable text, not JSON.
2. Claude follow-up replies naturally reference specific steps and issue context from the prior turn.
3. Follow-up replies render with Block Kit formatting (context label + markdown body).
4. Follow-up thinking indicator uses Block Kit, matching the initial response experience.
