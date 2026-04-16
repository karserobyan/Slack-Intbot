# Near-Term Improvements — Design Spec

**Date:** 2026-04-16
**Scope:** Four targeted improvements to IntegrationsBot: cache bug fix, confidence logging, accounting check order, and a role-gated help command.

---

## 1. Cache Bug Fix

### Problem

`setCached(query, result)` in `src/handlers/mention.js` (step 6, line 247) runs unconditionally before the `clarifying_question` check at step 8a (line 271). When Claude returns a clarifying-question-only result `{ clarifying_question: "..." }` — which has no `issue_title`, no `agent_steps`, and no other fields — that stub gets cached under the query key.

The next agent who sends the identical query hits the cache path (step 2, line 155), which calls `buildResponseBlocks(cached)` with a stub object. The result is a broken Slack message: the header renders `🟡 undefined`, steps are empty, the confidence context block shows no sources.

### Fix

Guard `setCached` so it only runs for full structured responses. A full response always has `issue_title`; a clarifying-question-only result does not.

```js
// Only cache full structured responses — not clarifying-question stubs
if (!result.clarifying_question) setCached(query, result);
```

**File:** `src/handlers/mention.js`
**Change:** One line — add the `if (!result.clarifying_question)` guard around `setCached`.

No other changes. Cache behavior for full responses is unchanged.

---

## 2. Confidence Logging

### Goal

Emit structured log lines so operators can observe, over time, how often queries hit "high" vs "medium" vs "low" confidence, which integrations are queried most, and whether cached vs live results are being served.

### Log lines

**Cache hit** (step 2 in `handleQuery`, after serving from cache):
```
[query] cache-hit confidence=high integration=Zapier sources=slack,confluence
```

**Live result** (after the full result is resolved and confirmed to be a full response — after accounting and clarifying-question checks):
```
[query] role=csa confidence=high integration=Zapier sources=slack,confluence
```

### Format

- Uses existing `app.logger.info` (Bolt's structured logger) in `registerMentionHandler`, and `console.info` in `handleQuery` where `app.logger` is not in scope.
- Single line per query. No multi-line payloads.
- Fields: `role` (live only), `confidence`, `integration` (from `result.integration_type`), `sources` (comma-joined `result.sources_used`).
- Truncate `integration_type` to 50 chars to prevent log bloat.

**File:** `src/handlers/mention.js`

---

## 3. Accounting Check Order

### Problem

The execution order in `handleQuery` is:

1. Empty query check
2. Rate limit check
3. **History check** (`hasHistory`) → routes to `queryChat` if thread has history
4. Accounting check → fast-path redirect (keyword regex)
5. Cache check
6. Claude call

Because the history check fires before the accounting check, a follow-up message in an active thread that mentions an accounting integration (e.g. "what about QuickBooks?") bypasses the accounting fast-path, goes to `queryChat`, and hits Claude unnecessarily. `CHAT_SYSTEM_PROMPT` has an accounting exclusion hard rule so Claude does eventually redirect, but this wastes an API call and adds latency.

### Fix

Move the accounting check to before the history check:

1. Empty query check
2. Rate limit check
3. **Accounting check** ← moved up
4. **Help command check** ← new (see §4)
5. History check → `queryChat`
6. Cache check
7. Claude call

The accounting keyword regex is cheap (< 1ms). Accounting redirects never seed conversation history in either the old or new order — both paths return early. No behavioral change for agents; one fewer Claude call when a thread follow-up touches accounting.

**File:** `src/handlers/mention.js`

---

## 4. Help Command

### Trigger

Query is exactly `"help"` (case-insensitive, after stripping the bot mention). Matched with:
```js
if (query.toLowerCase() === 'help') { ... }
```

Placed in the execution order after the accounting check, before the history check — so asking "help" in an active diagnostic thread always produces the help response, not a confused follow-up reply.

### Role detection

Calls `detectAgentRole(client, userId)` inline. No thinking placeholder — help responses are constructed locally with no Claude call, so they're instant.

### Response A — Capability overview (public, all roles)

Posted as a normal thread message visible to everyone. Block Kit content:

- **Header:** `🤖 IntegrationsBot — Help`
- **What I do:** Searches Confluence, Jira, and Slack history to give integrations support agents troubleshooting steps for integration issues.
- **Integrations covered:** Zapier, Angi/Angi Leads, Reserve with Google (RwG), ServiceChannel, Thumbtack, Procore, Chat-to-Text widget, and others.
- **What I can't help with:** Accounting integrations (QuickBooks, NetSuite, Sage Intacct, Xero, etc.) — those go to `#ask-partner-enabled-accounting-integrations`.
- **How to use:** Just describe the issue. Tag me or DM me. Example queries:
  - _"Customer's Zapier integration shows no API access on their tenant"_
  - _"Angi leads stopped syncing after the tenant migration"_
  - _"Procore job cost export failing for one specific job type"_
- **Context footer:** `_IntegrationsBot • For support: #ask-integrations_`

### Response C — Full reference (Specialist only, ephemeral)

Sent via `client.chat.postEphemeral` — visible only to the requesting Specialist in that channel. In a DM (`channel_type === 'im'`), `postEphemeral` is not available, so C is appended to the public response (DMs are already private).

Block Kit content:

- **Confidence levels:**
  - 🟢 High — every step traced word-for-word to a search result. Act on it.
  - 🟡 Medium — partial match or drawn from built-in integration knowledge. Verify before actioning.
  - 🔴 Low — no direct match found. Treat steps as a starting point; escalate if unsure.
- **Wrong Answer feedback:** Click 👎 Wrong Answer → fill in the correction → goes to pending review in the feedback channel → approved corrections are injected into future Claude prompts for the same query type.
- **Show Specialist Detail button:** Appears on CSA responses. Clicking it triggers a second Claude call in Specialist mode and posts the full technical response in the same thread.
- **Thread continuation / guided diagnostic mode:** After the bot's first response, any follow-up in the same thread enters guided diagnostic mode — the bot asks yes/no questions to narrow down root cause, then delivers a final answer.
- **"No direct match" escalation:** When confidence is low and the bot outputs a single escalate step, that is intentional honesty — not a failure. It means searches returned nothing specific.

### No history seeding

Help responses do not append to conversation history. A "help" query in an active diagnostic thread leaves the thread context untouched.

### Files changed

- `src/handlers/mention.js` — add help handler, move accounting check, add logging, fix cache guard
- `src/slack/blocks.js` — add `buildHelpBlocks(role)` returning the A blocks, add `buildHelpDetailBlocks()` returning the C blocks

---

## Execution order in `handleQuery` after all changes

1. Empty query check
2. Rate limit check
3. Accounting check (keyword regex, fast-path) ← moved up
4. Help command check (`query === 'help'`) ← new
5. History check → `queryChat`
6. Cache check + cache-hit log line ← new log
7. Role detection + thinking placeholder (parallel)
8. Feedback injection
9. Claude call
10. Accounting double-check (Claude response)
11. Clarifying question check
12. `setCached` — **only if `!result.clarifying_question`** ← bug fix
13. Full result delivery + live result log line ← new log

---

## Testing

- `test.js`: Add `buildHelpBlocks` and `buildHelpDetailBlocks` import and assertions — blocks are arrays, contain expected text strings, no crash.
- Cache bug: Add a test that passes a `clarifying_question`-only result through the cache write guard and asserts it is not stored.
- No new integration tests needed — logging is observable only at runtime.

---

## Out of scope

- Slash command registration (requires manifest changes)
- Help content localization
- Feedback analytics dashboard (medium-term item)
