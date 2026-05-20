# Query-Understanding Redesign — Design Spec

_Date: 2026-05-19_
_Branch (target): `feature/query-understanding-redesign`_

## Goal

Replace the current single-Claude-call query path with a four-stage pipeline (Interpreter → Search → Evaluator → Refine → Answerer) that **understands the question before searching**. Designed to fix three failure modes that have been hurting the bot since the REST migration:

1. **`parseClaudeResponse` throws on malformed JSON** — the `HARD RULE — MANDATORY SEARCHES` rule forces Claude to call Slack MCP before any JSON output; when Slack MCP fails, Claude emits prose, the parser throws, and the user sees "Something went wrong"
2. **Slack MCP brittleness** — missing/placeholder tokens silently produce zero results; combined with the mandatory-search rule, Claude gets stuck
3. **Verbatim search noise** — `searchConfluence` / `searchJira` use raw user text as `text ~ "..."` queries; email pastes, names, and redundant references leak into search keywords

The redesign **eliminates the mandatory-search rule entirely** (the Interpreter decides which sources to hit), moves Slack from MCP to direct Web API, and generates targeted keywords instead of passing the raw query through verbatim.

## Non-goals

- Changing the response schema seen by `buildResponseBlocks` — must remain byte-for-byte compatible so existing Block Kit tests and the Specialist Detail view keep working unchanged
- Re-architecting the feedback / nomination / knowledge.md flows — they keep their current shape and wire into the new pipeline at the same logical points
- Changing the channel-mention / DM-mention entry points or the `app_home_opened` / `new_chat` / `start_chat_thread` actions
- Adding new sources (Slack, Confluence, Jira, KB, team knowledge stay as the five sources)

---

## 1. Architecture

```
Raw user question (from @mention or DM)
   │
   ▼
[Fast paths: empty / help / accounting / rate limit / cache] ── early exit
   │
   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ NEW PIPELINE (when NEW_PIPELINE=true)                              │
│                                                                     │
│   [Interpreter — Haiku 4.5]                       ~2s              │
│   ├─ question_confidence: low  → clarifying question, return       │
│   └─ ok → { cleaned_question, intent, entities, search_plan }      │
│                                                                     │
│   [Search Executor — direct API/REST, no AI]      ~5s              │
│   ├─ Runs every source in the plan in parallel                     │
│   ├─ `priority` passes through as metadata (no execution gating v1)│
│   └─ Slack via Web API (NOT MCP)                                   │
│                                                                     │
│   [Evaluator — Haiku 4.5]                         ~2s              │
│   ├─ sufficient: true  → skip refinement                            │
│   └─ sufficient: false → refined_plan                              │
│                  ▼                                                  │
│                  [Search Round 2]                 ~5s              │
│                                                                     │
│   [Answerer — Sonnet 4.6]                         ~15s             │
│   └─ Produces the existing CSA/Specialist JSON schema              │
└─────────────────────────────────────────────────────────────────────┘
   │
   ▼
[Existing post-pipeline: cache write, accounting double-check,
 clarifying-question early-return, render response,
 seed history, nominate to knowledge.md]
```

Latency budget: ~25s fast path, ~35–45s with one refinement round. Hard cap: 60s with AbortController.

### Stage responsibilities

| Stage | File | Model | Job |
|---|---|---|---|
| Interpreter | `src/claude/interpreter.js` (new) | Haiku 4.5 | Strip email noise, extract entities, judge `question_confidence` + per-source `priority`, build search plan |
| Search Executor | `src/claude/search-executor.js` (new) | none (direct API) | Run every source in the plan in parallel: KB / Confluence / Jira / Slack Web API. `priority` is passed through as metadata; v1 does not gate execution on it |
| Evaluator | `src/claude/evaluator.js` (new) | Haiku 4.5 | Judge if results match cleaned question; emit refined plan if not. Hard cap: 1 refinement round |
| Answerer | `src/claude/answerer.js` (new, derived from `queryWithContext`) | Sonnet 4.6 | Produce final structured response in the existing CSA / Specialist JSON schema |
| Orchestrator | `src/claude/pipeline.js` (new) | — | Coordinates the four stages; called from `handleQuery` when `NEW_PIPELINE=true` |

### Slack moves from MCP to direct Web API

The Search Executor uses `search.messages` (the Slack Web API endpoint) with the user token. This removes:
- The `HARD RULE — MANDATORY SEARCHES` rule in the system prompts
- The MCP plumbing in `query.js`
- The class of failures where Slack MCP returns empty / errors silently

### Prompt files split

`prompts.js` splits into three new files:
- `src/claude/prompts/interpreter.js` — Interpreter system prompt
- `src/claude/prompts/evaluator.js` — Evaluator system prompt
- `src/claude/prompts/answerer.js` — Answerer system prompt (the existing CSA + Specialist + shared rules, with the MANDATORY SEARCHES rule deleted and REST-aware language)

`CHAT_SYSTEM_PROMPT` and `parseChatResponse` are deleted once the feature flag is removed (Step 3 of rollout below).

---

## 2. Data contracts

### Interpreter output — happy path (`question_confidence: high`)

```json
{
  "cleaned_question": "Zapier integration not syncing leads after tenant migration",
  "intent": "troubleshooting",
  "entities": {
    "integration": "Zapier",
    "error_code": null,
    "tenant_id": null,
    "customer_mentioned": true,
    "symptom": "leads not syncing after migration"
  },
  "question_confidence": "high",
  "clarifying_question": null,
  "search_plan": {
    "sources": [
      { "name": "confluence", "priority": "high",   "query": "Zapier leads sync tenant migration" },
      { "name": "slack",      "priority": "high",   "query": "Zapier sync migration" },
      { "name": "kb",         "priority": "medium", "query": "Zapier leads sync" },
      { "name": "jira",       "priority": "low",    "query": "Zapier migration" }
    ],
    "rationale": "Troubleshooting Zapier post-migration. Confluence likely has migration runbook; Slack likely has prior cases. KB for general docs. Jira low because no known ticket pattern."
  }
}
```

### Interpreter output — clarifying-question path (`question_confidence: low`)

```json
{
  "cleaned_question": "Integration not working",
  "intent": "unclear",
  "entities": {
    "integration": null,
    "error_code": null,
    "tenant_id": null,
    "customer_mentioned": false,
    "symptom": "not working"
  },
  "question_confidence": "low",
  "clarifying_question": "Which integration is this about — Zapier, Angi, RwG, or something else?",
  "search_plan": null
}
```

### Field definitions

**`intent`** — one of:
- `troubleshooting` — something broke, agent wants a fix
- `how-to` — agent wants to know how to do something
- `policy` — questions about rules, scopes, who-owns-what
- `integration-setup` — net-new integration onboarding (different Confluence space, no error to diagnose)
- `unclear` — Interpreter couldn't classify; always paired with `question_confidence: low` and a `clarifying_question`

**`entities`** — five fields:
- `integration` — Zapier | Angi | RwG | ServiceChannel | Thumbtack | Procore | Chat-to-Text | null
- `error_code` — exact code if present (e.g. `4xx Bad Gateway`, `WEBHOOK_TIMEOUT`); null otherwise
- `tenant_id` — extracted if mentioned
- `customer_mentioned` — boolean; whether the agent is asking on behalf of a named customer (affects sensitivity handling downstream)
- `symptom` — short noun phrase describing what's wrong; null for non-troubleshooting intents

**`question_confidence`** — three tiers:
- `high` — integration named AND symptom clear AND no contradictions → commit to a structured response
- `medium` — one side named, the other vague → run the search plan, but the Answerer prompt is told "if results don't strongly support a specific answer, return a `clarifying_question` instead of a structured response"
- `low` — both missing, or contradictions → return `clarifying_question`, skip search entirely

**`search_plan.sources[]`** — array of plans (replaces the old map-of-queries shape). Each entry:
- `name` — one of `confluence`, `slack`, `jira`, `kb`
- `priority` — `high` | `medium` | `low`. The Search Executor runs all entries in parallel but can downgrade or skip `low`-priority sources if a time budget is tight (v1: always runs all, priority is metadata for the Evaluator and Answerer)
- `query` — the targeted keyword string for that source

### Search Executor output

```json
{
  "kb":         { "refs": [...], "text": "...", "priority": "medium" } | null,
  "confluence": { "refs": [...], "text": "...", "priority": "high"   } | null,
  "jira":       { "refs": [...], "text": "...", "priority": "low"    } | null,
  "slack":      { "refs": [...], "text": "...", "priority": "high"   } | null
}
```

`null` means either "not in the plan" or "the call failed" (Answerer treats both identically — no signal leakage about transient errors). `priority` is passed through from the Interpreter so downstream stages know how to weight each source.

### Evaluator output

```json
{
  "sufficient": false,
  "rationale": "Confluence returned a migration runbook but no Zapier-specific section; Slack results were about a different integration. Retry with API-access keywords.",
  "refined_plan": {
    "sources": [
      { "name": "confluence", "priority": "high",   "query": "Zapier API access enable tenant" },
      { "name": "slack",      "priority": "high",   "query": "Zapier API access not working" }
    ]
  }
}
```

When `sufficient: true`, `refined_plan` is null and the pipeline skips directly to the Answerer.

### Answerer output

**Unchanged.** Same CSA / Specialist JSON schema as today (see `docs/functionality-overview.md` §6 for the full schema). This is the explicit interface contract that keeps `buildResponseBlocks`, the 377 existing tests, the nomination criteria, and the Specialist Detail view working without modification.

---

## 3. Error handling & fallbacks

| Failure | Behavior |
|---|---|
| Interpreter call fails (network 5xx, timeout, malformed JSON) | Retry once with the same payload. If still failing, post a generic clarifying question: `"I had trouble understanding the question — can you rephrase it with the integration name and what's going wrong?"` Never falls back to verbatim search (that's the failure mode we're killing). |
| Single Search Executor source fails | Continue with what we have (`Promise.allSettled` pattern). The Answerer sees `null` for that source and proceeds. No retry on individual sources. |
| Evaluator call fails | Assume `sufficient: true` — skip refinement, proceed to Answerer with round-1 results. Saves latency on a failure; refinement is an optimization, not a requirement. |
| Answerer call fails (5xx, timeout) | Retry once for transient errors only (5xx, timeout, network). Do NOT retry on 4xx (programmer error, won't get better). If retry fails, post the existing "Something went wrong" error card via `buildErrorBlocks`. |
| Pipeline exceeds 60s total | AbortController triggers; show "Something went wrong — try rephrasing or being more specific." Same error block as today's `CLAUDE_TIMEOUT_MS` path. |

### Why no verbatim-search fallback

The previous design proposed falling back to "treat raw question as cleaned, run all sources verbatim" if the Interpreter failed. We're rejecting this because:

- It re-introduces the email-noise / name-noise failure mode we're explicitly trying to eliminate
- A clarifying question is a better UX than a low-quality verbatim search — agents can refine in one turn
- It adds a code path that has to stay working forever

---

## 4. Testing strategy

### Test runner: plain `assert()` (no framework)

Matches `CLAUDE.md` convention. The new stages get new test blocks alongside the existing 377 assertions in `test.js`. No `vitest` / `node:test` migration.

### Stage tests

- **Interpreter** — two-part testing:
  - **Automated (`test.js`):** mocked Anthropic SDK returning a fixed JSON string; asserts the Interpreter wraps the SDK call correctly (right system prompt, right user message, JSON-parsed output, error handling for malformed responses)
  - **Manual prompt iteration (`test/fixtures/interpreter-queries.json`):** 10 hand-curated queries with their expected `cleaned_question`, `intent`, `entities`, `question_confidence`. Developer runs the Interpreter against real Anthropic during development and checks the actual output against the fixture. Fixture is the **prompt-quality gate**; it's not executed in CI but must be verified before any prompt change ships. Mix of fixtures:
    - 3 clear troubleshooting queries (integration + symptom both named)
    - 2 vague queries triggering `question_confidence: low`
    - 2 queries with heavy email-paste noise (verifying that gets stripped)
    - 1 `how-to` query
    - 1 `policy` query
    - 1 `integration-setup` query

- **Search Executor** — pure unit tests with mocked REST clients, mocked Slack Web API, mocked Google CSE. Asserts:
  - Sources in the plan get called in parallel
  - Sources NOT in the plan are NOT called
  - A failing source returns `null` (doesn't throw, doesn't block other sources)
  - `priority` field is passed through to the output

- **Evaluator** — mocked Anthropic SDK. Asserts the refined plan respects the same shape as the interpreter's `search_plan`.

- **Answerer** — port the existing `parseClaudeResponse` tests; verify the JSON schema matches today's `buildResponseBlocks` expectations.

- **Orchestrator** — mocked stages. Asserts:
  - `question_confidence: low` skips the Search/Evaluator/Answerer stages and returns a clarifying question
  - `sufficient: true` skips the refinement round
  - `sufficient: false` triggers exactly one refinement round (never two)
  - 60s AbortController fires correctly

### What stays mock-only

No live Anthropic / live REST tests in `test.js`. Live verification happens manually via `cli.js` before merging. CI runs `node test.js` only.

### Existing tests must keep passing

All 377 existing assertions stay green. The Answerer's output schema is the contract that makes this true.

---

## 5. Migration plan

### Rollout: feature flag `NEW_PIPELINE`

Three deploys:

1. **Ship gated off (default `false`)** — new pipeline code lives in the repo, default-off. Old `queryWithContext` / `queryChat` path runs for everyone. Manual testing via CLI with `NEW_PIPELINE=true` set locally
2. **Flip the default to `true`** — one week after step 1 if no regressions, change the default. Old path still in tree as a one-line revert option
3. **Delete the old path** — one week after step 2, delete `queryWithContext`, `queryChat`, `parseChatResponse`, the chat-mode prompt, MCP plumbing for Slack, and the `NEW_PIPELINE` flag itself

### Follow-ups (DM thread replies)

The follow-up branch (`handleQuery` step 6, `hasHistory(threadTs)`) also uses the new pipeline. The Interpreter prompt has a follow-up-aware mode: when called with prior thread history, it interprets the new message as a refinement of the previous question rather than as a standalone query. Same Search / Evaluator / Answerer stages run.

This unifies the two code paths and eliminates `queryChat` entirely after the cleanup phase. The state machine that `queryChat` implemented (diagnosing → resolved) is replaced by the Answerer's existing schema (`clarifying_question` for "still diagnosing", full response for "resolved").

### Auxiliary flows — where they fit

| Flow | Today (16-step) | New pipeline | Why |
|---|---|---|---|
| Accounting redirect | Step 3 (regex check, fast-path) | Same — runs before the Interpreter | Keyword regex is free and ~1ms; calling Haiku for accounting classification would burn 2s + tokens to do worse |
| Rate limiting | Step 2 | Same — unchanged | No reason to move |
| Help / empty / greeting | Steps 1, 2, 4 | Same — unchanged | No reason to move |
| Cache lookup | Step 7 (key on raw query) | Two-phase: first lookup by raw query before the Interpreter runs; if miss, run the Interpreter, then second lookup by `cleaned_question`. On final write, store the response under **both** keys (raw + cleaned) so future queries hit on either form | Initial dedupe stays cheap (one map lookup). Double-key write means a later query with different email-noise but the same cleaned form hits cache without re-running the Interpreter |
| Feedback corrections | Injected into Claude prompt (`mention.js:254-273`) | Injected into the **Answerer** prompt's context block | Corrections are about "the right answer for this question", not about understanding the question. They don't belong in the Interpreter |
| Team knowledge (`data/knowledge.md`) | Loaded by `src/slack/knowledge.js`, injected into the Claude prompt as `[TEAM KNOWLEDGE]` | Same — injected into the **Answerer** prompt's context block | Team knowledge is curated context, not a search target. It's always present regardless of the Interpreter's plan |
| Nomination | Step 16 (`nominateResponse` after handleQuery returns) | Same — orchestrator calls `nominateResponse()` after the Answerer returns | Answerer output schema is unchanged; nomination criteria (`has refs && no escalation && has steps && >30s elapsed && !clarifying_question`) work as-is |
| KB auto-save | Inside `queryWithContext` | Moves to the Search Executor's KB stage — when a KB ref is returned with priority high/medium, append to `knowledge.md` if not already present | Same dedupe-by-URL logic |
| Specialist Detail button | Re-runs `queryWithContext(query, { role: 'specialist' })` | Re-runs the pipeline with `role: 'specialist'`; the Answerer's prompt switches | Output schema unchanged so the button keeps working |

### Implementation order

Bottom-up with the Answerer brought forward — five PRs (one per stage, then orchestrator), or a single big PR if you prefer. The order:

1. **Search Executor** (`src/claude/search-executor.js`) — fully deterministic, easiest to unit-test. No AI dependency. Build it with a fake plan and verify all four sources route correctly. Adds the new Slack Web API client (`src/slack/search-client.js`) to replace MCP for search
2. **Answerer** (`src/claude/answerer.js`) — port the prompt-building from `queryWithContext`. Validate that with a real round-1 search result it produces JSON that passes `parseClaudeResponse` and matches the existing Block Kit tests byte-for-byte
3. **Interpreter** (`src/claude/interpreter.js`) — write the system prompt; build the 10-query golden fixture; iterate the prompt against the fixtures until all 10 pass
4. **Evaluator** (`src/claude/evaluator.js`) — smaller prompt; iterate against fixtures pulled from real Search Executor outputs
5. **Orchestrator** (`src/claude/pipeline.js`) — wires the four stages together with the abort controller, retry logic, and `NEW_PIPELINE` flag. Plumb into `handleQuery` at step 6 (follow-ups) and step 10 (initial queries)

### Rollback plan

At any point during the gated-off and flag-flipped phases, `NEW_PIPELINE=false` reverts to today's behavior in a single env-var change — no code deploy needed. The old path stays in tree until the deletion phase, which only happens after one week of clean traffic on the new pipeline.

---

## 6. Files touched

### New files

- `src/claude/interpreter.js`
- `src/claude/search-executor.js`
- `src/claude/evaluator.js`
- `src/claude/answerer.js`
- `src/claude/pipeline.js`
- `src/claude/prompts/interpreter.js`
- `src/claude/prompts/evaluator.js`
- `src/claude/prompts/answerer.js`
- `src/slack/search-client.js` — Slack Web API `search.messages` wrapper
- `test/fixtures/interpreter-queries.json`

### Modified files

- `src/handlers/mention.js` — `handleQuery` branches to the new pipeline when `NEW_PIPELINE=true`, both for initial queries (step 10) and follow-ups (step 6)
- `src/claude/query.js` — stays untouched during the gated-off phase; **deleted entirely** during cleanup (nothing left in it once `queryWithContext` / `queryChat` / `parseChatResponse` are gone)
- `src/claude/prompts.js` — stays untouched during the gated-off phase; **deleted entirely** during cleanup (replaced by the three new prompt files under `src/claude/prompts/`)
- `src/slack/cache.js` — supports two-key lookup (raw + cleaned_question)
- `test.js` — new test blocks for each stage; existing 377 assertions keep passing
- `.env.example` — add `NEW_PIPELINE=false` with a comment
- `README.md` — document the flag, the new pipeline architecture (one paragraph + the diagram from §1)
- `docs/functionality-overview.md` — updated after the cleanup phase to reflect the new architecture

### Deleted (cleanup phase, after one week of clean traffic on `NEW_PIPELINE=true`)

- `src/claude/query.js`'s `queryWithContext`, `queryChat`, `parseChatResponse`
- `src/claude/prompts.js` entirely (replaced by `src/claude/prompts/*`)
- The Slack MCP plumbing in the inference path (Slack token usage moves to the Web API client)
- The `NEW_PIPELINE` env var (always-on at this point)
- `process.md` (handoff doc; superseded by this spec)

---

## 7. Open risks and mitigations

| Risk | Mitigation |
|---|---|
| Interpreter prompt is hard to get right — Haiku might over-classify as `unclear` (too many clarifying questions, worse UX than today) | Golden fixtures lock down behavior on 10 representative queries before the flag flips. Tune the prompt against the fixtures until precision/recall feel right |
| Slack Web API `search.messages` returns lower-quality results than MCP's search | Manual A/B against the current MCP search on 5 real queries before flag flip. Adjust query construction (use `in:` filters, channel scoping) if needed |
| The Answerer prompt loses some implicit behavior currently encoded in `SYSTEM_PROMPT_CSA` / `SYSTEM_PROMPT_SPECIALIST` (those are ~200 lines each) | Port them verbatim minus the `MANDATORY SEARCHES` rule and the `atlassian tools` phrasing. Diff the prompts side-by-side before deletion |
| Two-key cache (raw + cleaned_question) doubles memory footprint | Current cap is 50 entries; new cap stays the same. Two keys can point at the same value object so memory only goes up by ~50 string keys (~5KB) |
| Refinement round doubles latency for hard queries | Hard cap of one refinement enforced in the orchestrator. 60s AbortController catches runaway cases |

---

## 8. Success criteria

The redesign is successful when:

1. All 377 existing tests pass on `NEW_PIPELINE=true`
2. New tests pass: 10 interpreter golden fixtures + Search Executor unit tests + Evaluator tests + Orchestrator tests
3. "Something went wrong" rate (measured by counting `buildErrorBlocks` calls in logs) drops to <1% of queries over a one-week window
4. Manual eval: 5 real queries with email-paste noise produce search keywords that omit the email content (verified by inspecting the Search Executor's actual queries)
5. Median end-to-end latency stays under 30s; p95 under 45s
6. After the cleanup phase, `wc -l src/claude/*.js` shows fewer lines than today — refactor pays for itself in maintainability

---

## 9. References

- `process.md` (handoff doc 2026-05-13) — original brainstorm context, superseded by this spec
- `docs/functionality-overview.md` — capability-grouped reference for the current bot (baseline before redesign)
- `CLAUDE.md` — branch + testing conventions
- Anthropic SDK docs — Haiku 4.5 and Sonnet 4.6 model usage
- Slack Web API — `search.messages` endpoint reference
