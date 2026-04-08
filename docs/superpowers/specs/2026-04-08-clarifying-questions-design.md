# Clarifying Questions + Response Cleanup — Design Spec

**Date:** 2026-04-08
**Branch:** `main`
**Status:** Approved

---

## Problem

**Too bulky.** The initial bot response is visually overwhelming — integration identifier, sources badges, a full sources reference section, a context footer, and every troubleshooting step regardless of what the agent has already tried. Agents are in the middle of a call or ticket and need targeted, readable answers.

**No context gathering.** When a query is vague ("Zapier not working"), the bot dumps all possible steps. It never asks what the agent has already done, so the answer is often irrelevant to where they actually are.

---

## Approach

**A — `clarifying_question` JSON field + response format cleanup.**

Add an optional `clarifying_question` field to the structured JSON schema. Claude sets it when the query lacks enough specifics to give a targeted answer. The bot posts the question conversationally, seeds history with the search-based analysis, then the existing follow-up path delivers a targeted answer informed by both the search and what the agent replies.

Simultaneously, strip visual noise from `buildResponseBlocks`: remove the integration/sources metadata line, the sources reference section, and the context footer. Confidence icon moves inline with the header title.

---

## Design

### 1. `clarifying_question` field — `src/claude/prompts.js`

**JSON schema addition** (both CSA and Specialist prompts):

```json
"clarifying_question": "One focused question to ask before answering, or null if the query already has enough context."
```

**When to set it (in `SHARED_RULES`):**

Set `clarifying_question` to a focused question when ALL of the following are true:
- No specific error code or error message was provided
- No steps already tried are mentioned
- Symptoms are vague (e.g. "not working", "stopped syncing", "not connecting") with no further detail
- The question is not a simple how-to or clarification request

Set `clarifying_question` to `null` when ANY of the following is true:
- The agent described specific symptoms or error messages
- The agent mentioned steps already tried
- The query is specific enough that you know exactly what to check
- The agent is asking how to do something (not troubleshooting a failure)

The question must be ONE focused question only. Not a list. Aim for what would most change your troubleshooting path — e.g. "Has Zapier API access already been enabled on the backend, or is that still to check?" or "What error is the customer seeing — is it on the ServiceTitan side or in Zapier?"

**`summarizeResultForHistory` update:**

When `result.clarifying_question` is non-null, append to the summary:

```
\n\nI asked the agent: "[clarifying_question]"
```

This ensures `queryChat` in the follow-up knows what was asked.

---

### 2. Response format cleanup — `src/slack/blocks.js`

**Remove entirely:**
- Integration/sources metadata line: `` *Integration:* `Zapier`    *Sources:* `slack` `confluence`    🟢 High confidence ``
- Sources reference section: the `slack_refs` and `atlassian_refs` display blocks at the bottom
- Context footer: `_IntegrationsBot • Sources searched: … • Powered by Claude_`

**Simplify confidence display:**

Move confidence icon inline with the header title:

```
Before: 🔌 Zapier API Access Not Enabled  (header)
        *Integration:* `Zapier`  🟢 High confidence  (separate section)

After:  🟢 Zapier API Access Not Enabled  (header, icon replaces 🔌)
```

The `🔌` plug emoji is replaced by the confidence icon (`🟢` / `🟡` / `🔴`). This communicates confidence at a glance without a separate line.

**Block count reduction:** ~16 blocks → ~8–10 blocks depending on content.

---

### 3. Wiring — `src/handlers/mention.js`

After `queryWithContext` returns, check `result.clarifying_question`:

**If set (vague query):**
1. Post the clarifying question using `buildFollowUpBlocks(result.clarifying_question)` — same polished format as follow-up replies.
2. Call `appendToHistory` with the analysis summary (which now includes the appended question via `summarizeResultForHistory`).
3. Return early — do NOT render the full Block Kit response.

**If null (specific query):**
- Continue existing flow unchanged — render Block Kit response, seed history.

The thinking placeholder is already posted before `queryWithContext` returns. When a clarifying question is triggered, update the placeholder with the question (same `chat.update` pattern used for normal responses).

---

## Files Changed

| File | Change |
|---|---|
| `src/claude/prompts.js` | Add `clarifying_question` to JSON schemas; add rule to SHARED_RULES; update `summarizeResultForHistory` |
| `src/slack/blocks.js` | Remove metadata line, sources section, footer; move confidence icon to header |
| `src/handlers/mention.js` | Branch on `result.clarifying_question` after `queryWithContext` |

---

## Out of Scope

- `dm.js` — reuses `handleQuery`, gets the change for free.
- `queryChat` / `conversation.js` — no changes needed; follow-up path handles the rest.
- Channel recommendation block — kept as-is (agents act on this).
- Email draft and action buttons — kept as-is (agents use these).

---

## Success Criteria

1. Vague query → bot posts one focused clarifying question, no full answer yet.
2. Agent replies → bot gives targeted answer skipping already-tried steps.
3. Specific query → bot skips clarifying question, goes straight to answer.
4. Initial response block count reduced to ~8–10 blocks.
5. Confidence communicated via header icon, no separate metadata line.
6. No sources section in any response.
7. All 135 existing tests still pass; new tests cover the clarifying question branch.
