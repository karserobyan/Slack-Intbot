# Knowledge Lifecycle — Design Spec

**Date:** 2026-04-22
**Status:** Approved

---

## Overview

Two related improvements that turn `knowledge.md` from a static, manually-edited file into a living knowledge base that the bot grows itself:

1. **Knowledge auto-save** — the bot nominates high-quality responses and KB articles for saving to `knowledge.md`, with moderator approval gating bot responses and auto-save for KB articles.
2. **Knowledge fast-lookup** — before running a full Claude+MCP search, check whether `knowledge.md` already has a matching answer and serve it directly without MCP tool calls.

---

## Lookup Tiers (updated)

The bot now has three answer tiers, checked in order:

| Tier | Source | Speed | API cost |
|------|--------|-------|----------|
| 1 | In-memory cache | Instant | Zero |
| 2 | knowledge.md match | Fast (~5–10s) | Claude only, no MCP |
| 3 | Full Claude + MCP search | Slow (20–50s) | Claude + Slack/Atlassian MCPs |

**Tier 2 implementation:** Before calling `queryWithContext()`, scan `knowledge.md` for entries under the matching integration section. If a relevant entry is found, call Claude with only that entry as context — no MCP servers attached. If Claude returns a high-confidence structured response, serve it. If not (low confidence or clarifying question), fall through to Tier 3.

---

## Feature 1 — Knowledge Auto-Save

### Nomination criteria

**Bot responses** — all four must be true:
- Response time > 30 seconds (configurable via `KNOWLEDGE_MIN_MS`, default 30000)
- At least one real reference (`slack_refs.length > 0` OR `atlassian_refs.length > 0`)
- No escalation (`escalate_decision.should_escalate !== true`)
- Has concrete steps (`agent_steps.length > 0`)

**KB articles** — auto-saved on every query that returns results from `searchKnowledgeBase()`. No approval needed. Deduplicated by URL.

### Moderation flow (bot responses only)

1. Bot posts to the moderator channel (`FEEDBACK_CHANNEL`) with the proposed entry text, integration name, source refs, and **Approve / Reject** buttons — same channel as wrong-answer reports.
2. Moderator clicks **Approve** → entry written to `knowledge.md`, confirmation posted in the same thread.
3. Moderator clicks **Reject** → silently dismissed, no write.

### Slack alert (all writes)

Every write to `knowledge.md` — whether a KB auto-save or an approved bot response — sends a notification to `FEEDBACK_CHANNEL`:

- KB: `📚 KB article auto-saved to knowledge.md: [Integration] — [title]`
- Bot response: `✅ Knowledge entry approved and saved: [Integration] — [issue_title]`

### Storage format

Entries appended under the matching `## [Integration]` section. Section created if it doesn't exist.

```markdown
## Zapier

- [kb, 2026-04-22] Setting Up Zapier Integration — https://help.servicetitan.com/... — Enable API access in admin portal before connecting Zapier.
- [auto, 2026-04-22] Zapier API access resets after tenant migration: re-enable via ST backend admin panel for that tenant. Confirmed in Slack #ask-integrations + Confluence.
```

Tag conventions:
- `[kb, YYYY-MM-DD]` — auto-saved KB article
- `[auto, YYYY-MM-DD]` — bot-nominated, moderator-approved
- No tag — manually added by a human

**Deduplication:**
- KB articles: skip if URL already appears anywhere in `knowledge.md`
- Bot responses: skip if an entry with the same `issue_title` already exists under that integration section

### System prompt note

Both prompts (`SYSTEM_PROMPT_CSA`, `SYSTEM_PROMPT_SPECIALIST`) updated to tell Claude:

> If `[TEAM KNOWLEDGE]` contains a specific, matching entry for this integration AND this symptom — answer from it immediately. Do not run Phase 1 searches.

---

## Feature 2 — Knowledge Fast-Lookup

### Where it lives (`src/handlers/mention.js`)

Between the cache check (Step 2) and the Claude+MCP call (Step 5), add a new Step 2.5:

```
2.5 — Knowledge lookup
  - Extract integration hint from query (keyword match against known integration names)
  - Find matching section in knowledge.md
  - If entries found → call Claude with those entries as context, no MCP servers
  - If Claude returns a full structured response → serve it (log as knowledge-hit)
  - If Claude returns a clarifying question or low-confidence → fall through to Step 5
```

### Fast-path Claude call

Same model and system prompt as the full call, but:
- No `mcp_servers` attached
- `userContent` is: `Issue: [query]\n\n[TEAM KNOWLEDGE]\n[matching entries]\n[/TEAM KNOWLEDGE]`
- Max tokens: 2048 (answers from known knowledge are concise)
- Result is NOT cached (knowledge.md is already the persistent store)

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `knowledge.md` write fails | Log error, notify moderator channel, bot continues |
| Integration section not found | Create it at end of file |
| Duplicate entry detected | Skip silently, no notification |
| `FEEDBACK_CHANNEL` not configured | Log warning, skip nomination/alert |
| Fast-lookup Claude call fails | Fall through to full MCP search |
| Fast-lookup returns low confidence | Fall through to full MCP search |

---

## Files Changed

| File | Change |
|------|--------|
| `src/slack/knowledge-writer.js` | New — write entries to `knowledge.md`, dedup check, send Slack alert |
| `src/slack/nominations.js` | New — build nomination Slack messages, approve/reject logic |
| `src/handlers/mention.js` | Add fast-lookup (Step 2.5), add nomination check after result |
| `src/claude/query.js` | Trigger KB auto-save after `searchKnowledgeBase()` returns results |
| `src/claude/prompts.js` | Add instruction to answer from `[TEAM KNOWLEDGE]` before searching |
| `src/index.js` | Register `approve_nomination` and `reject_nomination` action handlers |
| `test.js` | Tests for knowledge-writer (dedup, format, section creation) and nominations |

---

## Future Follow-ons (out of scope here)

- **Staleness review** — periodic job that flags `[kb, ...]` and `[auto, ...]` entries older than 90 days for moderator re-review.
- **Knowledge search index** — replace keyword-based section matching in fast-lookup with a proper embedding-based similarity search for better recall.
