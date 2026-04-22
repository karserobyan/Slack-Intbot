# Response Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the bot's Slack response layout to be clearer, more actionable, and visually confident — replacing the current scattered structure with BLUF layout, a prominent routing signal, a role-tailored customer talktrack, and colorful numbered steps.

**Architecture:** Rewrite `buildResponseBlocks()` in `blocks.js` to render a new block order with a routing-signal banner as the main visual element for CSAs. Update both Claude system prompts to add `customer_message` and `suggested_channel_post` fields and remove `intro_message`. Simplify `buildThinkingBlocks()`.

**Tech Stack:** Slack Block Kit (section/header/context/actions blocks only — no CSS), Node.js ESM

---

## What changes

**`src/slack/blocks.js`** — rewrite `buildResponseBlocks()`:
- Remove: `intro_message` block, standalone escalation block, standalone channel block, Bottom Line section, "Agent Troubleshooting / Internal only" header
- Add: diagnosis callout (🔍 Root Cause), routing signal banner (prominent, role-conditional), customer talktrack (💬 Message the customer), colored step-number emojis
- Simplify `buildThinkingBlocks()` to just "Checking…"

**`src/claude/prompts.js`** — both SYSTEM_PROMPT_CSA and SYSTEM_PROMPT_SPECIALIST:
- Add `customer_message` field (Claude generates it, role-tailored voice)
- Add `suggested_channel_post` field (optional, present when channel routing applies)
- Remove `intro_message` field
- Add voice guidance for `customer_message`: assertive, confident, professionally charismatic, empathetic

**`src/claude/prompts.js`** — `summarizeResultForHistory()`:
- Replace `intro_message` reference with `customer_message`

**`test.js`** — update block structure tests

---

## New block rendering order (`buildResponseBlocks`)

```
1. header       → confidence icon + issue_title
2. divider
3. section      → 🔍 Root Cause (diagnosis callout — bold diagnosis + action line)
4. section      → routing signal banner [CSA only — see logic below]
5. section      → 💬 Message the customer (customer_message, italic)
6. section      → "🔧 What you do" label
7. section × N  → each agent step (colored emoji circle + num + title + tag + detail)
8. context      → sources footer
9. actions      → buttons (Wrong Answer, Sources, Show Specialist Detail)
10. divider
```

Specialist omits block 4 (routing signal). Everything else renders for both roles.

---

## Routing signal logic (block 4, CSA only)

The routing signal replaces the old escalate_decision + channel_recommendation blocks. Three scenarios:

**✅ Handle yourself** — when `escalate_decision.should_escalate === false` AND `confidence === 'high'`
```
✅ *You've got this — handle it yourself*
_High confidence · no escalation needed_
```

**📢 Post in #channel** — when `escalate_decision.should_escalate === true`
```
📢 *Post in #<channel>*
_<escalate reason> · suggested message below_
> <suggested_channel_post>
```

**🔎 Post to verify** — when `confidence === 'low'` OR `confidence === 'medium'`
(regardless of `should_escalate` value)
```
🔎 *Post to verify — not fully certain*
_<confidence level> confidence · <escalate reason or channel reason>_
> <suggested_channel_post>
```

When both `should_escalate === true` AND confidence is low/medium — "Post in #channel" wins (more urgent).

Channel name comes from `channel_recommendation.channel`. `suggested_channel_post` comes from Claude.

---

## Diagnosis callout (block 3)

Uses `findings_summary.diagnosis` as the bold root cause, and `findings_summary.actions[0]` (if present) as the follow-up line. Rendered as a section:

```
*🔍 Root Cause*
*<diagnosis>*
<actions[0] if present>
```

---

## Step rendering (blocks 7×N)

Each step uses a colored emoji circle matching its tag type:
- `action` → 🔵
- `backend` → 🟠
- `verify` → 🟢
- `escalate` → 🔴

Format per step:
```
<tagEmoji> *<num>. <title>*  `<tag>`
<detail>
```

`TAG_DISPLAY` map updated to return just the emoji (used as the circle), separate from the backtick label inline.

---

## Thinking blocks simplification

`buildThinkingBlocks()` reduced to:
```
*🔍 Checking…*
_"<query truncated to 120 chars>"_
```
Context element: `_IntegrationsBot is working on it…_`

---

## New Claude JSON fields

### Add to both prompts:

**`customer_message`** (string, required in full response):
A first-person message the agent sends to the customer. Rules:
- Assertive and confident — the agent knows what's happening
- Professionally charismatic — warm, not stiff
- Empathetic — acknowledges the customer's frustration or situation
- Specific — references the actual issue, not a generic placeholder
- CSA: friendly, accessible language, no technical jargon
- Specialist: can use technical terms, assumes customer has some familiarity
- Never starts with "I" — starts with "Hi [Name]" or "Hey [Name]"
- 2–4 sentences max

**`suggested_channel_post`** (string, optional, **CSA prompt only** — include when `escalate_decision.should_escalate === true` OR `confidence` is low/medium):
A ready-to-post message for the Slack channel. First-person agent voice (not bot voice). Concise. Includes: what the issue is, what's been checked, what's needed. 2–3 sentences.

### Remove from both prompts:
- `intro_message` — no longer rendered or used

### Keep (schema unchanged):
- `findings_summary` — still in JSON; `diagnosis` and `actions[0]` drive the diagnosis callout (block 3). The Bottom Line section no longer renders as a standalone block — `findings_summary` is consumed only for the callout.

### `summarizeResultForHistory()` update:
Replace `intro_message` line with `customer_message` in the summary output.

---

## Voice guidance for `customer_message` (add to both prompts)

```
customer_message rules:
- Lead with empathy: acknowledge the disruption before explaining what you know
- Be assertive: state what you know is happening, not "it seems like" or "it might be"
- Be charismatic: natural language, contractions, a hint of warmth — not corporate-flat
- Be specific: name the integration, what broke, and what the fix is
- Keep it tight: 2–4 sentences, no filler
- CSA voice: accessible, non-technical, reassuring
- Specialist voice: peer-to-peer, technically precise, still warm
```

---

## Tests to update

`buildResponseBlocks()` tests in `test.js`:
- Remove assertions for: `intro_message` block, escalation block, channel recommendation block, Bottom Line section, "Agent Troubleshooting" header
- Add assertions for: diagnosis callout (🔍 Root Cause text present), routing signal block (✅/📢/🔎), customer talktrack (💬 text present), colored step emoji (🔵/🟠/🟢/🔴)
- Add routing signal scenario tests: handle-yourself, post-in-channel, post-to-verify (low confidence, mid confidence)
- Update: thinking blocks test (should match new short format)
