# Findings Summary — Design Spec

**Date:** 2026-04-15
**Status:** Approved

## Goal

Remove the customer email draft feature and replace it with a "Bottom Line" findings summary — a short, scannable section that tells the agent what's happening, what to do, and what to watch out for.

The email feature was trying to do too much: it invented copy for a channel (customer email) that has nothing to do with the agent's immediate job, which is triaging and resolving. The summary focuses on what the agent actually needs.

---

## What Changes

### 1. JSON Schema — Both CSA and Specialist prompts

Remove `customer_email`. Add `findings_summary`:

```json
"findings_summary": {
  "diagnosis": "One sentence: what's broken and why.",
  "actions": ["Action 1", "Action 2", "Action 3"],
  "guidance": "Optional: one watch-out, edge case, or fallback if the fix doesn't work. Omit field entirely if nothing noteworthy."
}
```

**Field rules:**
- `diagnosis` — always present; one sentence; states the root cause plainly ("The Zapier integration is failing because API access hasn't been enabled on the ServiceTitan backend for this tenant.")
- `actions` — 2–4 bullets; imperative, discrete; no duplication of step titles from `agent_steps` — these are the shortened, scannable version
- `guidance` — optional; only include when there is a genuine edge case, common gotcha, or "if this doesn't work, try X" note worth flagging

### 2. Slack Rendering — `buildResponseBlocks` in `blocks.js`

The "Bottom Line" section renders after the agent steps, where the email section used to be:

```
💡 *Bottom Line*
*[diagnosis sentence]*

• [action 1]
• [action 2]
• [action 3]

_[guidance — only if present]_
```

- Header: `💡 *Bottom Line*`
- Diagnosis rendered bold
- Actions rendered as a bullet list (`• ` prefix per line)
- Guidance rendered italic, only if the field is present
- Low confidence: show the summary anyway — it is findings-based, not invented. Drop the "email suppressed" warning block entirely.

### 3. Action Row

The action row currently has: `📋 Copy Email Draft` | `👎 Wrong Answer` | `🔍 Show Specialist Detail` (optional).

After this change: `👎 Wrong Answer` | `🔍 Show Specialist Detail` (optional). "Copy Email Draft" is removed.

### 4. Removed Entirely

| Item | Location |
|------|----------|
| `customer_email` field | Both prompt schemas |
| Email suppression warning block (low confidence) | `blocks.js` → `buildResponseBlocks` |
| `buildEmailModal` function | `blocks.js` |
| `copy_email_modal` action handler | `src/handlers/mention.js` (if present) |
| `customer_email` line in history summary | `prompts.js` → `summarizeResultForHistory` |
| Email confidence note in `SHARED_RULES` | `prompts.js` → `SHARED_RULES` |

### 5. `summarizeResultForHistory` in `prompts.js`

Remove the `customer_email` line. Add a brief summary of `findings_summary` for conversation history continuity:

```
Bottom line I gave: [diagnosis] Actions: [action 1]; [action 2]
```

---

## Layout After Change

```
[intro_message]
[confidence header]
[divider]
[escalate_decision — CSA only]
[channel_recommendation — CSA only]
[🔧 Agent Troubleshooting]
  Step 1...
  Step 2...
[divider]
[💡 Bottom Line]
  *diagnosis*
  • action 1
  • action 2
  _guidance (if present)_
[action row: 👎 Wrong Answer | 🔍 Show Specialist Detail (if applicable)]
[divider]
```

---

## Files Touched

| File | Change |
|------|--------|
| `src/claude/prompts.js` | Remove `customer_email` from both schemas; add `findings_summary`; update `SHARED_RULES`; update `summarizeResultForHistory` |
| `src/slack/blocks.js` | Replace email section with Bottom Line section; remove `buildEmailModal`; update action row |
| `src/handlers/mention.js` | Remove `copy_email_modal` action handler (if present) |
| `test.js` | Update any tests referencing `customer_email`; add test for `findings_summary` rendering |

---

## Out of Scope

- No changes to the guided diagnostic flow (`CHAT_SYSTEM_PROMPT`, `queryChat`)
- No changes to accounting redirect handling
- No changes to the "Wrong Answer" feedback modal
- No changes to the escalate/channel recommendation sections
