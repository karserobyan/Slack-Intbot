# Channel Recommendation Design Spec

**Date:** 2026-04-01
**Status:** Approved

## Goal

Add a `channel_recommendation` field to CSA responses so the bot tells agents whether to post their question in `#ks-integration` (quick/sanity check, CSA-appropriate) or `#ask-integrations` (complex issue, company-wide visibility). Also adds `#ks-integration` as a search source so the bot learns from past questions posted there.

## Scope

CSA mode only. Specialist responses are unchanged.

---

## Architecture

Three files change:

| File | Change |
|------|--------|
| `src/claude/prompts.js` | Add `#ks-integration` to CSA search channels; add `channel_recommendation` to CSA JSON schema with classification rules |
| `src/slack/blocks.js` | Render a new "Post in #channel" block for CSA responses |
| `test.js` | TDD tests for the new block |

---

## JSON Schema Change (`SYSTEM_PROMPT_CSA`)

### New field added to CSA output

```json
"channel_recommendation": {
  "channel": "ks-integration | ask-integrations",
  "reason": "one sentence explaining why"
}
```

### Classification rules (in system prompt)

**Use `ks-integration` when:**
- Quick how-to or sanity check
- Single setting to verify
- Well-known issue with a clear, established fix
- CSA can likely resolve without broader team input

**Use `ask-integrations` when:**
- Unknown or unusual issue with no clear resolution
- Potential bug or platform-level problem
- Involves multiple systems or integrations
- Something the whole integrations team should see
- No relevant results found in searches

### Channel list update

`#ks-integration` added to the Slack MCP search list in `SYSTEM_PROMPT_CSA`:

```
- slack: Search past Slack threads from #ask-integrations, #ask-leads-integration,
  #ks-integration, #200ok-specialists, and #integrations-ts-specialists
```

---

## UI Block (`blocks.js`)

A new block rendered **after `escalate_decision`** and **before the agent steps divider**, visible only when `channel_recommendation` is present:

**#ks-integration:**
```
📢 Post this in #ks-integration
_Quick sanity check — no need for company-wide visibility_
```

**#ask-integrations:**
```
📢 Post this in #ask-integrations
_Complex issue — worth the whole team seeing_
```

The block is a standard `section/mrkdwn` block. The channel name is rendered as a Slack channel link: `<#channel-name>` format is not used since we don't have channel IDs — plain `#channel-name` text is used instead.

---

## Independence of Fields

`channel_recommendation` and `escalate_decision` are intentionally independent:

- **Escalate=true, channel=#ks-integration** — needs a Specialist, but a quick known issue; no need to broadcast
- **Escalate=false, channel=#ask-integrations** — CSA can handle it, but the issue is unusual enough for the team to see

Both fields are always present in CSA responses. Neither overrides the other.

---

## Testing

TDD: failing tests added first, then implementation.

Tests cover:
- `channel_recommendation` block renders when field is present
- `ks-integration` variant renders correct icon and text
- `ask-integrations` variant renders correct icon and text
- Block is absent when `channel_recommendation` field is missing (no regression)
- Existing CSA block rendering tests continue to pass

---

## What Does NOT Change

- Specialist prompt and blocks — untouched
- `escalate_decision` logic — untouched
- `query.js`, `mention.js`, `index.js` — untouched
- Feedback moderation — untouched
