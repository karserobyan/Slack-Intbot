# Sources Button + Broadened Search Coverage — Design Spec

**Date:** 2026-04-20
**Status:** Approved

---

## Overview

Two related improvements to make the bot more trustworthy and thorough:

1. **Sources button** — a `📎 Sources` button next to `👎 Wrong Answer` that opens a modal listing every reference Claude used to build its answer, grouped by source type.
2. **Broadened search coverage** — guarantee every query searches Slack, Atlassian (Confluence + Jira), and the ServiceTitan help KB, without sacrificing response time.

---

## Feature 1 — Sources Button + Modal

### Schema changes (`src/claude/prompts.js`)

Lock down the ref arrays in both `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST`. Replace the current untyped `slack_refs: [...]` and `atlassian_refs: [...]` with explicit schemas, and add a new `kb_refs` field:

```json
"slack_refs": [
  {
    "url": "https://servicetitan.slack.com/archives/...",
    "channel": "#channel-name",
    "title": "Brief description of what this thread is about"
  }
],
"atlassian_refs": [
  {
    "type": "confluence",
    "url": "https://...",
    "title": "Page title"
  },
  {
    "type": "jira",
    "url": "https://...",
    "title": "INT-1234 — ticket title"
  }
],
"kb_refs": [
  {
    "url": "https://help.servicetitan.com/...",
    "title": "Article title",
    "snippet": "One-line excerpt from the article"
  }
]
```

`kb_refs` is populated by our Node.js code after parsing Claude's response — Claude does not call the Google API. The field is added to the parsed result object before it reaches the blocks builder.

The hard rule for refs stays: Claude must never fabricate refs. Empty arrays are correct when nothing was found.

### UI — `buildSourcesModal(data)` (`src/slack/blocks.js`)

New exported function. Returns a Slack modal view (`type: 'modal'`) with sections grouped by source type:

- `💬 Slack (N)` — lists each `slack_ref` as a linked title + channel
- `📄 Atlassian (N)` — lists each `atlassian_ref` as a linked title, Confluence and Jira mixed
- `📚 Knowledge Base (N)` — lists each `kb_ref` as a linked title + snippet

Each section only renders if that array is non-empty. If all three arrays are empty, the modal shows a single message: "No specific sources were found for this answer."

### UI — `buildResponseBlocks()` update (`src/slack/blocks.js`)

Add a `📎 Sources` button to the actions block, immediately after `👎 Wrong Answer`. Button is only added when at least one ref exists across all three arrays. The button value is a JSON string of `{ slack_refs, atlassian_refs, kb_refs }`, with each array capped at 5 entries before encoding to stay within Slack's 2000-char button value limit.

### Action handler (`src/index.js`)

New `view_sources_modal` action — same pattern as `wrong_answer_modal`:

```js
app.action('view_sources_modal', async ({ ack, body, client, action }) => {
  await ack();
  let refsData = { slack_refs: [], atlassian_refs: [], kb_refs: [] };
  try { refsData = JSON.parse(action.value); } catch { /* show empty modal */ }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildSourcesModal(refsData),
  });
});
```

---

## Feature 2 — Broadened Search Coverage

### Google Custom Search integration (`src/claude/query.js`)

New function `searchKnowledgeBase(query)`:
- Calls `https://www.googleapis.com/customsearch/v1` with `key`, `cx`, and `q` params
- `cx` is a Custom Search Engine scoped to `help.servicetitan.com`
- Returns top 3 results as a formatted string for context injection
- On any error (missing key, quota exceeded, network failure) — logs a warning and returns `null`. Never throws.

Required env vars:
- `GOOGLE_CSE_API_KEY` — Google Cloud API key
- `GOOGLE_CSE_ID` — Custom Search Engine ID

In `queryWithContext()`, run KB search in parallel with the existing `getKnowledge()` call:

```js
const [knowledge, kbText] = await Promise.all([
  getKnowledge(),
  searchKnowledgeBase(userQuery),
]);
```

Both are injected into `userContent` before the Claude API call:
- Team knowledge → `[TEAM KNOWLEDGE]...[/TEAM KNOWLEDGE]` (existing)
- KB results → `[KB RESULTS]...[/KB RESULTS]` (new, omitted if null)

After parsing Claude's response, attach the Google results as `kb_refs` on the result object.

### Mandatory search coverage (`src/claude/prompts.js`)

Replace the current "stop when you have a confident answer after Search 1" speed rule with a two-phase strategy in both `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST`:

**Phase 1 — Mandatory breadth (always):**
- Run one Slack search (integration name or symptom)
- Run one Atlassian search (same or complementary keywords)
- KB results are pre-injected — no search needed

**Phase 2 — Depth (if needed):**
- If Phase 1 results are specific and sufficient → answer immediately
- If not → run Search 3 (alternate name, error code, tool switch) as today

The stop-early rule now only applies after Phase 1 is complete. This guarantees every query touches both Slack and Atlassian, while preserving the fast path for clear answers.

**No change** to Search 3 logic, escalation rules, or clarifying question behaviour.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Google API key missing | `kb_refs: []`, no KB section in modal, bot continues |
| Google quota exceeded | Same as above — silent skip |
| Claude returns malformed refs | Modal skips unparseable entries |
| All ref arrays empty | Modal shows "No specific sources found" message |
| No refs at all | `📎 Sources` button hidden entirely |

---

## Files Changed

| File | Change |
|------|--------|
| `src/claude/query.js` | Add `searchKnowledgeBase()`, run in parallel, attach `kb_refs` |
| `src/claude/prompts.js` | Lock ref schemas, add `kb_refs` field, update search strategy |
| `src/slack/blocks.js` | Add `buildSourcesModal()`, add Sources button to `buildResponseBlocks()` |
| `src/index.js` | Register `view_sources_modal` action handler |
| `test.js` | Tests for `buildSourcesModal()` and Sources button visibility logic |
| `.env.example` | Document `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_ID` |

---

## Future Follow-ons (out of scope here)

- **KB result caching** — LRU cache keyed by query to avoid redundant Google API calls and save quota. Same pattern as `src/slack/cache.js`.
- **Knowledge auto-save** — automatically feed successful bot interactions into `knowledge.md` so the bot learns over time without manual editing.
