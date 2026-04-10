# Guided Diagnostic Questions — Design Spec

**Date:** 2026-04-10
**Status:** Approved

## Problem

The bot currently jumps straight to a full structured answer for every query. For vague or complex queries ("Zapier not working", "integration stopped syncing"), this produces generic or low-confidence responses. Agents need to be walked through a diagnosis, not handed a guess.

## Goal

Replace the single-shot answer with a guided yes/no diagnostic loop. The bot asks targeted questions, acknowledges each answer with a brief explanation of what it means, and continues until it is confident about the root cause — then delivers the answer. It educates the agent along the way.

## Approach

Search first, then diagnose. The bot uses MCP search results (Confluence, Jira, Slack) to inform its first question. Subsequent questions adapt based on the agent's answers. Only skips to a full answer immediately if the query is already specific enough (error code provided, steps already tried, clear how-to).

## Flow

```
Agent query
    │
    ▼
queryWithContext (MCP search)
    │
    ├─ Query is specific → full structured JSON answer (existing behavior)
    │
    └─ Query is vague/complex → {"clarifying_question": "yes/no question"}
                                        │
                                        ▼
                               Bot posts question
                               History seeded with question
                                        │
                                Agent answers
                                        │
                                        ▼
                              queryChat (CHAT_SYSTEM_PROMPT)
                                        │
                              ┌─────────┴─────────┐
                              │                   │
                        Not confident          Confident
                              │                   │
                     Acknowledge answer     Deliver final answer
                     + explain meaning      (plain conversational text)
                     + next yes/no Q
                              │
                         (loop back)
```

## Components

### 1. Initial query prompt (`SYSTEM_PROMPT_CSA`, `SYSTEM_PROMPT_SPECIALIST`)

After searching (Step 1), Claude evaluates whether it can give a specific, grounded answer:

- **Can answer specifically** (query has error code, steps tried, or clear intent) → generate full structured JSON, same as today
- **Cannot answer specifically** (vague symptom, no error, no tried steps) → output only `{"clarifying_question": "..."}` and stop

The first question must be:
- Yes/No format
- One sentence
- Targeted at the single most likely root cause based on search results
- Example: *"Has Zapier API access been enabled for this tenant on the ServiceTitan backend?"*

No other fields are populated when asking a question — the bot has not answered yet.

### 2. Diagnostic conversation prompt (`CHAT_SYSTEM_PROMPT`)

Full redesign. The bot is a guided diagnostic assistant, not a free-form conversational helper.

**Response format for each turn:**

1. **Acknowledge** (1 sentence) — what the agent's answer means diagnostically
   - e.g. *"Got it — if API access isn't enabled, Zapier can't authenticate at all, which explains the sync failure."*

2. **Bridge** — one of two paths:
   - **Still diagnosing:** ask the next yes/no question, targeting the next most likely cause or differentiating factor
   - **Confident:** deliver the final answer — clear, actionable, plain text. Include what the agent should do and why.

The bot decides autonomously when it has enough information. No hard question limit.

**Mid-diagnosis search:** The bot may re-search Confluence/Jira/Slack as the diagnosis narrows (MCP tools are available in `queryChat`). If an agent's answer points to a specific error or sub-issue, search before asking the next question.

**Tone:** Warm, direct, like a senior colleague walking through a checklist. Not robotic. Brief explanations, not lectures.

### 3. No changes to

- `mention.js` / `dm.js` — `clarifying_question` branch already posts the question and seeds history correctly
- `query.js` — search, parsing, and MCP setup unchanged
- `summarizeResultForHistory` — already stores the question in history
- Blocks, cache, rate limiting — untouched

## Scope

All changes are in `src/claude/prompts.js`:
- `SYSTEM_PROMPT_CSA`: replace current Step 0 with post-search evaluation gate
- `SYSTEM_PROMPT_SPECIALIST`: same
- `CHAT_SYSTEM_PROMPT`: full redesign into guided diagnostic assistant

## Success Criteria

- Vague queries ("Zapier not working", "leads not showing up") trigger a yes/no question, not a full answer
- Specific queries ("getting 401 on Zapier after re-auth") still get a direct answer
- Each answer is acknowledged with a one-sentence explanation before the next question
- The bot converges to a final answer — it does not ask questions indefinitely
- Final answer is clear, actionable, and grounded in search results
