# Guided Diagnostic Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-shot answers with a guided yes/no diagnostic loop — the bot asks targeted questions informed by MCP search results, acknowledges each answer with a brief explanation, and delivers the final answer once confident.

**Architecture:** Initial query always searches first (MCP tools); after searching, Claude evaluates whether it can give a specific grounded answer — if not, it outputs only a yes/no clarifying question. Follow-up answers drive a diagnostic conversation loop via `queryChat` / `CHAT_SYSTEM_PROMPT` until the bot is confident enough to answer fully.

**Tech Stack:** Node.js ESM, `@slack/bolt`, `@anthropic-ai/sdk` (MCP beta), prompt engineering in `src/claude/prompts.js`

---

## File Map

| File | Change |
|------|--------|
| `src/claude/prompts.js` | All changes — 3 prompt rewrites (CSA, Specialist, Chat) + `summarizeResultForHistory` cleanup |
| `test.js` | Add 2 tests for clarifying-question-only response parsing |

No other files change. The `mention.js` handler already handles `result.clarifying_question` correctly.

---

### Task 1: Add test for clarifying-question-only response

The bot will now emit `{"clarifying_question": "..."}` with no other fields. Verify `parseClaudeResponse` and `summarizeResultForHistory` handle this correctly before changing prompts.

**Files:**
- Modify: `test.js` (add after line 99, inside the `Claude Response Parsing` section)

- [ ] **Step 1: Add the failing-then-passing tests**

In `test.js`, find the line:
```js
// Parse invalid JSON should throw
```

Insert these two tests immediately before it:

```js
// Parse clarifying-question-only response (no other fields)
const clarifyOnly = parseClaudeResponse('{"clarifying_question": "Has Zapier API access been enabled for this tenant?"}');
assert(clarifyOnly.clarifying_question === 'Has Zapier API access been enabled for this tenant?', 'Parses clarifying-question-only response');
assert(clarifyOnly.issue_title === undefined, 'No issue_title in clarifying-question-only response');
```

Also find the comment `// clarifying_question absent when null` block (near line 178) and add after the last `assert` in that block:

```js
// summarizeResultForHistory with clarifying-question-only result (no intro, no steps)
const clarifyOnlyResult = { clarifying_question: 'Has Zapier API access been enabled for this tenant?' };
const clarifyOnlySummary = summarizeResultForHistory(clarifyOnlyResult);
assert(clarifyOnlySummary.includes('Has Zapier API access been enabled'), 'clarify-only summary includes the question');
assert(!clarifyOnlySummary.includes('Confidence: unknown'), 'clarify-only summary omits noise when no confidence/sources');
```

- [ ] **Step 2: Run tests — expect the last assert to fail**

```bash
node test.js
```

Expected: all pass except `clarify-only summary omits noise when no confidence/sources` (fails because `summarizeResultForHistory` currently always appends the confidence/sources line).

- [ ] **Step 3: Fix `summarizeResultForHistory` to skip the confidence/sources line when the result is clarifying-question-only**

In `src/claude/prompts.js`, find:

```js
  const confidence = result.confidence ?? 'unknown';
  const sources = (result.sources_used ?? []).join(', ') || 'none';
  lines.push(`\nConfidence: ${confidence} | Sources: ${sources}`);
```

Replace with:

```js
  if (result.confidence !== undefined || (result.sources_used ?? []).length > 0) {
    const confidence = result.confidence ?? 'unknown';
    const sources = (result.sources_used ?? []).join(', ') || 'none';
    lines.push(`\nConfidence: ${confidence} | Sources: ${sources}`);
  }
```

- [ ] **Step 4: Run tests — all should pass**

```bash
node test.js
```

Expected: `Results: N passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add test.js src/claude/prompts.js
git commit -m "test: add clarifying-question-only parsing tests and fix summarize noise"
```

---

### Task 2: Fix SYSTEM_PROMPT_CSA — post-search evaluation gate

The current Step 0 says "before searching" — wrong. The bot must search first, then decide whether to answer fully or ask a clarifying question.

**Files:**
- Modify: `src/claude/prompts.js` — `SYSTEM_PROMPT_CSA` constant

- [ ] **Step 1: Remove the incorrect Step 0 block from SYSTEM_PROMPT_CSA**

In `src/claude/prompts.js`, find and remove this exact block (it appears before `STEP 1 — Search before answering` in the CSA prompt):

```
STEP 0 — Before searching, evaluate whether the query has enough context for a targeted answer.
If ALL of the following are true, output ONLY {"clarifying_question": "your single focused question"} and stop — do NOT search, do NOT fill any other fields:
- No specific error code or error message was provided
- No steps already tried are mentioned
- Symptoms are vague ("not working", "stopped syncing", "not connecting") with no further detail
- This is not a how-to or setup question (e.g. "how do I set up Zapier")

One question only. One sentence. Ask what would most change your troubleshooting path.
Good examples: "Has Zapier API access already been enabled on the backend, or is that still to check?" or "What error is the customer seeing — on the ServiceTitan side or in Zapier itself?"

If the query already has enough detail, skip Step 0 and proceed directly to Step 1.

```

Replace it with nothing (delete it entirely, leaving `STEP 1 — Search before answering.` as the first step).

- [ ] **Step 2: Add a post-search evaluation gate to STEP 2 in SYSTEM_PROMPT_CSA**

Find the line in `SYSTEM_PROMPT_CSA`:

```
STEP 2 — Generate structured JSON output.
```

Replace it with:

```
STEP 2 — Evaluate your search results, then respond.

After searching, ask yourself: do my results give me a specific, grounded answer for THIS exact integration + symptom combination?

**If YES** (you found specific matching docs/threads/KB entries for this integration AND this symptom): generate the full structured JSON below.

**If NO** (query is vague — symptoms like "not working", "stopped syncing", "not connecting" with no error code and no steps tried — AND your searches returned nothing specifically matching this integration + symptom): output ONLY this JSON and stop — do NOT fill any other fields:
{"clarifying_question": "your first yes/no question"}

The question must be:
- Yes/No format, one sentence
- Specific to this integration (not generic)
- Targeting the single most likely root cause based on your search findings
- Example: "Has Zapier API access been enabled for this tenant on the ServiceTitan backend?"

```

- [ ] **Step 3: Run tests to confirm nothing broke**

```bash
node test.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: replace CSA Step 0 with post-search evaluation gate"
```

---

### Task 3: Fix SYSTEM_PROMPT_SPECIALIST — same post-search evaluation gate

**Files:**
- Modify: `src/claude/prompts.js` — `SYSTEM_PROMPT_SPECIALIST` constant

- [ ] **Step 1: Remove the incorrect Step 0 block from SYSTEM_PROMPT_SPECIALIST**

Find and remove this exact block (it appears before `STEP 1 — Search before answering` in the Specialist prompt):

```
STEP 0 — Before searching, evaluate whether the query has enough context for a targeted answer.
If ALL of the following are true, output ONLY {"clarifying_question": "your single focused question"} and stop — do NOT search, do NOT fill any other fields:
- No specific error code or error message was provided
- No steps already tried are mentioned
- Symptoms are vague ("not working", "stopped syncing", "not connecting") with no further detail
- This is not a how-to or setup question (e.g. "how do I set up Zapier")

One question only. One sentence. Ask what would most change your troubleshooting path.
Good examples: "Has Zapier API access already been enabled on the backend, or is that still to check?" or "What error is the customer seeing — on the ServiceTitan side or in Zapier itself?"

If the query already has enough detail, skip Step 0 and proceed directly to Step 1.

```

Replace with nothing.

- [ ] **Step 2: Add the post-search evaluation gate to STEP 2 in SYSTEM_PROMPT_SPECIALIST**

Find in `SYSTEM_PROMPT_SPECIALIST`:

```
STEP 2 — Generate structured JSON output. No escalate_decision field — specialists own the resolution.
```

Replace with:

```
STEP 2 — Evaluate your search results, then respond.

After searching, ask yourself: do my results give me a specific, grounded answer for THIS exact integration + symptom combination?

**If YES** (you found specific matching docs/threads/KB entries for this integration AND this symptom): generate the full structured JSON below.

**If NO** (query is vague — symptoms like "not working", "stopped syncing", "not connecting" with no error code and no steps tried — AND your searches returned nothing specifically matching this integration + symptom): output ONLY this JSON and stop — do NOT fill any other fields:
{"clarifying_question": "your first yes/no question"}

The question must be:
- Yes/No format, one sentence
- Specific to this integration (not generic)
- Targeting the single most likely root cause based on your search findings
- Example: "Has Zapier API access been enabled for this tenant on the ServiceTitan backend?"

No escalate_decision field — specialists own the resolution.
```

- [ ] **Step 3: Run tests**

```bash
node test.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: replace Specialist Step 0 with post-search evaluation gate"
```

---

### Task 4: Redesign CHAT_SYSTEM_PROMPT for guided diagnostic mode

The existing `CHAT_SYSTEM_PROMPT` is a general conversational assistant. It needs to become a guided diagnostic assistant: acknowledge → explain → next yes/no question OR final answer.

**Files:**
- Modify: `src/claude/prompts.js` — `CHAT_SYSTEM_PROMPT` constant

- [ ] **Step 1: Replace CHAT_SYSTEM_PROMPT entirely**

Find the entire `CHAT_SYSTEM_PROMPT` export (from `export const CHAT_SYSTEM_PROMPT = \`` through the closing backtick before `parseClaudeResponse`).

Replace the string value (everything between the backticks) with:

```
You are IntegrationsBot — a knowledgeable integrations expert and a sharp, helpful work colleague for ServiceTitan support agents.

You are in guided diagnostic mode. Your job is to ask yes/no questions to narrow down the root cause of the agent's issue, then deliver a clear, complete answer once you are confident.

## How to respond

Read the full conversation history — it shows what questions you have already asked and what the agent has already answered.

**Format for each response:**

1. **Acknowledge** (1 sentence): State what the agent's answer means diagnostically. Be specific.
   - "Got it — if API access isn't enabled, Zapier can't authenticate at all, which explains why nothing's syncing."
   - "OK, so access is confirmed — that rules out the most common cause."
   - "Interesting — if it worked before and suddenly stopped, this is almost certainly an auth token expiry or a recent config change."

2. **Bridge**: Choose one path:
   - **Still diagnosing** (you need one more piece of information): Ask the next yes/no question. One sentence. Target the next most likely cause, or the key differentiator between two plausible root causes.
   - **Confident** (you know the root cause and the fix): Deliver the final answer. Be specific, complete, and actionable. Include what to do, why it works, and any exact steps or paths confirmed by your knowledge. Plain conversational text — no JSON.

## When to stop asking and give the answer

Stop asking when you know:
- What caused the issue
- What the fix is
- What the agent should do next

When in doubt, give the answer. Do not over-diagnose.

## Searching mid-diagnosis

If the agent's answer points to a specific error code, sub-integration, or scenario you have not searched yet — use your Atlassian or Slack search tools to look it up before asking the next question or giving the final answer. Ground everything in what you find.

## Question rules

- Yes/No format only. One sentence.
- Never ask about something already answered in the conversation history.
- Never ask two questions at once.
- Ask about the single most diagnostic thing — the answer that would most change what you tell them next.

## Tone

Warm, direct, like a senior colleague walking through a checklist together. Brief explanations — not lectures. Use contractions. Match the agent's energy.

## Hard rules

HARD RULE — NO INVENTION: Never invent specific menu paths, field names, API paths, or settings not confirmed by search results or the common integration knowledge below.

HARD RULE — NO REPEATED QUESTIONS: Never ask a question whose answer is already in the conversation history.

HARD RULE — ONE QUESTION: Never ask more than one question per message.

HARD RULE — NO JSON: Reply in plain conversational text only. No JSON output, ever.

HARD RULE — COMPLETE FINAL ANSWER: When you give the final answer, be complete. Do not leave the agent needing to ask obvious follow-up questions.

HARD RULE — ACCOUNTING EXCLUSION: If the follow-up touches accounting integrations (QuickBooks, NetSuite, Xero, Sage Intacct, Viewpoint Vista, etc.), redirect to #ask-partner-enabled-accounting-integrations.

HARD RULE — HONESTY: If you do not know the specific answer and cannot find it via search, say so briefly and point the agent to #ask-integrations or #ask-leads-integration.

## Common integration knowledge (use when search returns nothing)
- Zapier: Agent must enable Zapier API access on ST backend for the tenant.
- Angi/Angi Leads: Check booking provider IDs, job type mapping under Settings > Integrations > Marketing Integrations > Angi.
- Reserve with Google (RwG): Check Actions Center, verify account matching status.
- ServiceChannel: Check attachment settings, verify API credentials.
- Thumbtack: For redirect loop — clear cache/cookies, try incognito.
- Procore: Check cost code mappings for job cost export failures.
- Chat-to-Text widget: Verify embed code placement, check SMS number setup.
```

- [ ] **Step 2: Run tests**

```bash
node test.js
```

Expected: all pass (CHAT_SYSTEM_PROMPT is not directly tested — tests cover parsing and blocks).

- [ ] **Step 3: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: redesign CHAT_SYSTEM_PROMPT for guided yes/no diagnostic mode"
```

---

### Task 5: Manual end-to-end verification

- [ ] **Step 1: Disable debug log (it's noisy during testing)**

In `.env`, confirm or set:
```
LOG_LEVEL=debug
```
(Keep debug on so you can see raw Claude responses during testing.)

- [ ] **Step 2: Start the bot**

```bash
npm run dev
```

- [ ] **Step 3: Test — vague query should trigger a yes/no question**

Send to the bot (DM or mention):
> Zapier not working

Expected behavior:
- Bot searches (takes ~10-30s)
- Bot responds with a single yes/no question, e.g. *"Has Zapier API access been enabled for this tenant on the ServiceTitan backend?"*
- No full answer yet

Check terminal for `[claude] Raw response` — it should be `{"clarifying_question": "..."}` with no other fields.

- [ ] **Step 4: Test — answer the question, expect acknowledgment + next question or answer**

Reply in the same thread:
> No

Expected behavior:
- Bot acknowledges: explains what "no" means (API access is missing = likely root cause)
- Bot either asks a follow-up question OR delivers the final answer if it's now confident

- [ ] **Step 5: Test — specific query should skip straight to an answer**

Start a fresh DM or mention (new thread):
> Customer getting 401 error on Zapier after re-authenticating — API access is already enabled

Expected behavior:
- Bot searches and delivers a full structured answer directly
- No clarifying question asked

- [ ] **Step 6: Disable debug log**

In `.env`, comment out:
```
# LOG_LEVEL=debug
```

- [ ] **Step 7: Final commit**

```bash
git add .env
git commit -m "chore: disable debug logging after verification"
```
