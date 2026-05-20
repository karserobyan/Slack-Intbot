# Query-Understanding Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current single-Claude-call query path with a four-stage pipeline (Interpreter → Search Executor → Evaluator → Refine → Answerer), all gated behind `NEW_PIPELINE=true`, that understands the question before searching.

**Architecture:** Build the new pipeline alongside the existing `queryWithContext` / `queryChat` code, hidden behind a feature flag. When the flag is off (default), the bot behaves exactly as today. When on, `handleQuery` routes to the new `src/claude/pipeline.js` orchestrator, which calls the four new stage modules in turn. After a week of clean traffic on the flag-on state, a follow-up cleanup PR deletes the old code path entirely.

**Tech Stack:** Node.js ESM, `@slack/bolt` v4, `@anthropic-ai/sdk` (Haiku 4.5 for Interpreter/Evaluator, Sonnet 4.6 for Answerer), Confluence REST, Jira REST, Slack Web API `search.messages`, Google Custom Search (KB), plain Node.js `assert()` for tests (no framework).

**Spec:** `docs/superpowers/specs/2026-05-19-query-understanding-redesign.md`

---

## Phase 1 — Build the pipeline gated off

All work in this phase happens on branch `feature/query-understanding-redesign`. The flag `NEW_PIPELINE` defaults to `false`, so production behavior is unchanged. Open one PR at the end of Phase 1 (Task 12 below).

### File map for Phase 1

**New files:**
- `src/utils/feature-flags.js` — env-var-backed flag reader
- `src/slack/search-client.js` — Slack Web API `search.messages` wrapper
- `src/claude/search-executor.js` — runs a search plan in parallel
- `src/claude/prompts/answerer.js` — CSA + Specialist system prompts (ported from `prompts.js` with MANDATORY-SEARCHES removed)
- `src/claude/answerer.js` — final-response stage (replaces `queryWithContext`'s Claude call)
- `src/claude/prompts/interpreter.js` — Interpreter system prompt
- `src/claude/interpreter.js` — first stage (Haiku)
- `src/claude/prompts/evaluator.js` — Evaluator system prompt
- `src/claude/evaluator.js` — third stage (Haiku)
- `src/claude/pipeline.js` — orchestrator
- `test/fixtures/interpreter-queries.json` — 10-query manual prompt-quality gate

**Modified files:**
- `src/slack/cache.js` — add cleaned-question second key
- `src/handlers/mention.js` — branch to `pipeline.js` when `NEW_PIPELINE=true`
- `.env.example` — add `NEW_PIPELINE=false`
- `README.md` — document the flag + pipeline overview
- `test.js` — add test blocks for each new stage

---

### Task 1: Feature-flag scaffolding

**Files:**
- Create: `src/utils/feature-flags.js`
- Test: `test.js` (append a new test block)
- Modify: `.env.example`

- [ ] **Step 1: Write the failing test**

Append to `test.js` after the existing block-rendering tests, just before the `Results:` summary line:

```javascript
// ── feature-flags ─────────────────────────────────────────────────────────────
console.log('\n🔹 feature-flags');

import { isNewPipelineEnabled } from './src/utils/feature-flags.js';

delete process.env.NEW_PIPELINE;
assert(isNewPipelineEnabled() === false, 'unset NEW_PIPELINE → false');

process.env.NEW_PIPELINE = 'false';
assert(isNewPipelineEnabled() === false, '"false" → false');

process.env.NEW_PIPELINE = 'true';
assert(isNewPipelineEnabled() === true, '"true" → true');

process.env.NEW_PIPELINE = 'TRUE';
assert(isNewPipelineEnabled() === true, '"TRUE" (case-insensitive) → true');

process.env.NEW_PIPELINE = '1';
assert(isNewPipelineEnabled() === false, 'numeric "1" is NOT true (strict "true" only)');

delete process.env.NEW_PIPELINE;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: failure with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../src/utils/feature-flags.js`.

- [ ] **Step 3: Create the feature-flags module**

Create `src/utils/feature-flags.js`:

```javascript
/**
 * Reads the NEW_PIPELINE env var. Strict: only the literal string "true"
 * (case-insensitive) returns true. Anything else, including "1" or "yes",
 * returns false. This avoids accidental enablement from typos.
 */
export function isNewPipelineEnabled() {
  return (process.env.NEW_PIPELINE ?? '').toLowerCase() === 'true';
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all assertions pass, results line shows the new count (was 377, now 382).

- [ ] **Step 5: Add the flag to .env.example**

In `.env.example`, append at the very end:

```
# ── New pipeline rollout flag ────────────────────────────────────────────────
# Enables the four-stage query pipeline (Interpreter → Search → Evaluator → Answerer).
# Default OFF. Flip to "true" to opt in. Strict comparison — only "true" enables it.
NEW_PIPELINE=false
```

- [ ] **Step 6: Commit**

```bash
git checkout -b feature/query-understanding-redesign
git add src/utils/feature-flags.js test.js .env.example
git commit -m "feat: add NEW_PIPELINE feature flag scaffolding"
```

---

### Task 2: Slack Web API search client

**Files:**
- Create: `src/slack/search-client.js`
- Test: `test.js`

- [ ] **Step 1: Write the failing test**

Append to `test.js` after the feature-flags block:

```javascript
// ── slack search-client ───────────────────────────────────────────────────────
console.log('\n🔹 slack search-client');

import { searchSlackMessages } from './src/slack/search-client.js';

// No token → null
delete process.env.SLACK_USER_TOKEN;
const noToken = await searchSlackMessages('zapier');
assert(noToken === null, 'searchSlackMessages returns null when SLACK_USER_TOKEN is missing');

// Placeholder token → null
process.env.SLACK_USER_TOKEN = 'xoxp-replace-me';
const placeholder = await searchSlackMessages('zapier');
assert(placeholder === null, 'searchSlackMessages returns null for placeholder token');

// Successful response → parsed refs
process.env.SLACK_USER_TOKEN = 'xoxp-test-token';
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  assert(url.startsWith('https://slack.com/api/search.messages'), 'hits Slack API');
  assert(opts.headers.Authorization === 'Bearer xoxp-test-token', 'uses Bearer auth');
  return new Response(JSON.stringify({
    ok: true,
    messages: {
      matches: [
        { permalink: 'https://slack.com/archives/C1/p123', channel: { name: 'integrations' }, text: 'Zapier issue resolved by enabling API' },
        { permalink: 'https://slack.com/archives/C1/p124', channel: { name: 'support' }, text: 'Another Zapier thread' },
      ],
    },
  }), { status: 200 });
};
const ok = await searchSlackMessages('zapier');
assert(ok !== null, 'parses successful response');
assert(ok.refs.length === 2, 'returns two refs');
assert(ok.refs[0].url === 'https://slack.com/archives/C1/p123', 'extracts permalink');
assert(ok.refs[0].channel === '#integrations', 'prefixes channel with #');
assert(ok.text.includes('integrations'), 'text contains channel');

// Empty matches → null
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, messages: { matches: [] } }), { status: 200 });
const empty = await searchSlackMessages('zapier');
assert(empty === null, 'returns null when no matches');

// Non-200 → null
globalThis.fetch = async () => new Response('{}', { status: 500 });
const fail = await searchSlackMessages('zapier');
assert(fail === null, 'returns null on non-200');

globalThis.fetch = origFetch;
delete process.env.SLACK_USER_TOKEN;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Cannot find module .../src/slack/search-client.js`.

- [ ] **Step 3: Create the search client**

Create `src/slack/search-client.js`:

```javascript
const SEARCH_URL = 'https://slack.com/api/search.messages';
const TIMEOUT_MS = 8000;

/**
 * Searches Slack messages via the Web API (NOT MCP).
 * Returns { text, refs } on success, null on missing token, placeholder token,
 * HTTP error, empty results, or any thrown exception.
 *
 * @param {string} query
 * @returns {Promise<{ text: string, refs: Array<{ url: string, channel: string, title: string }> } | null>}
 */
export async function searchSlackMessages(query) {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token || token === 'xoxp-replace-me') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('count', '5');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[slack-search] HTTP error:', res.status);
      return null;
    }

    const data = await res.json();
    if (data.ok === false) {
      console.warn('[slack-search] Slack error:', data.error);
      return null;
    }

    const matches = data.messages?.matches ?? [];
    if (matches.length === 0) return null;

    const refs = matches.map(m => ({
      url: m.permalink ?? '',
      channel: m.channel?.name ? `#${m.channel.name}` : '',
      title: (m.text ?? '').slice(0, 200),
    }));

    const text = refs
      .map((r, i) => `${i + 1}. [${r.channel}] ${r.title}\n   ${r.url}`)
      .join('\n\n');

    return { text, refs };
  } catch (err) {
    if (controller.signal.aborted) {
      console.warn('[slack-search] timed out after 8s');
    } else {
      console.warn('[slack-search] error:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all new assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/slack/search-client.js test.js
git commit -m "feat: add Slack Web API search client (search.messages)"
```

---

### Task 3: Search Executor

**Files:**
- Create: `src/claude/search-executor.js`
- Test: `test.js`

Behavior contract:
- Input: a `search_plan` object shaped like `{ sources: [{ name, priority, query }, ...] }`
- Output: a map `{ kb: {refs,text,priority}|null, confluence: ..., jira: ..., slack: ... }`
- Calls only the sources present in the plan; sources not in the plan return `null`
- Uses `Promise.allSettled` so one failure doesn't block others
- Passes `priority` through to the output

- [ ] **Step 1: Write the failing test**

Append to `test.js`:

```javascript
// ── search-executor ───────────────────────────────────────────────────────────
console.log('\n🔹 search-executor');

import { executeSearchPlan } from './src/claude/search-executor.js';

// Mock the source modules via global fetch
const origFetchSE = globalThis.fetch;

// Helper: each call to fetch returns a fixture response based on the URL
globalThis.fetch = async (url) => {
  if (url.includes('customsearch')) {
    return new Response(JSON.stringify({ items: [{ link: 'https://help.servicetitan.com/x', title: 'KB hit', snippet: 'foo' }] }), { status: 200 });
  }
  if (url.includes('atlassian.net/wiki')) {
    return new Response(JSON.stringify({ results: [{ title: 'Confluence hit', url: '/page/1', excerpt: 'bar' }] }), { status: 200 });
  }
  if (url.includes('atlassian.net/rest/api/3/search')) {
    return new Response(JSON.stringify({ issues: [{ key: 'JIRA-1', fields: { summary: 'Jira hit', status: { name: 'Open' } } }] }), { status: 200 });
  }
  if (url.includes('slack.com/api/search.messages')) {
    return new Response(JSON.stringify({ ok: true, messages: { matches: [{ permalink: 'https://slack.com/archives/C1/p1', channel: { name: 'c' }, text: 'Slack hit' }] } }), { status: 200 });
  }
  return new Response('{}', { status: 500 });
};
process.env.GOOGLE_CSE_API_KEY = 'k';
process.env.GOOGLE_CSE_ID = 'cx';
process.env.ATLASSIAN_EMAIL = 'a@b.c';
process.env.ATLASSIAN_API_TOKEN = 't';
process.env.SLACK_USER_TOKEN = 'xoxp-real';

const plan = {
  sources: [
    { name: 'kb',         priority: 'medium', query: 'kb query' },
    { name: 'confluence', priority: 'high',   query: 'confluence query' },
    { name: 'jira',       priority: 'low',    query: 'jira query' },
    { name: 'slack',      priority: 'high',   query: 'slack query' },
  ],
};
const result = await executeSearchPlan(plan);

assert(result.kb !== null, 'kb executed');
assert(result.kb.priority === 'medium', 'kb priority passed through');
assert(result.confluence !== null, 'confluence executed');
assert(result.confluence.priority === 'high', 'confluence priority passed through');
assert(result.jira !== null, 'jira executed');
assert(result.jira.priority === 'low', 'jira priority passed through');
assert(result.slack !== null, 'slack executed');
assert(result.slack.priority === 'high', 'slack priority passed through');

// Plan with only two sources → other two are null
const partialPlan = { sources: [{ name: 'kb', priority: 'high', query: 'kb only' }, { name: 'slack', priority: 'high', query: 'slack only' }] };
const partial = await executeSearchPlan(partialPlan);
assert(partial.kb !== null, 'kb runs');
assert(partial.slack !== null, 'slack runs');
assert(partial.confluence === null, 'confluence stays null');
assert(partial.jira === null, 'jira stays null');

// One failing source does not break others
globalThis.fetch = async (url) => {
  if (url.includes('customsearch')) throw new Error('boom');
  if (url.includes('atlassian.net/wiki')) {
    return new Response(JSON.stringify({ results: [{ title: 'OK', url: '/x', excerpt: '' }] }), { status: 200 });
  }
  return new Response('{}', { status: 500 });
};
const partialFail = await executeSearchPlan({ sources: [{ name: 'kb', priority: 'high', query: 'q' }, { name: 'confluence', priority: 'high', query: 'q' }] });
assert(partialFail.kb === null, 'failing kb returns null');
assert(partialFail.confluence !== null, 'confluence still succeeds');

globalThis.fetch = origFetchSE;
delete process.env.GOOGLE_CSE_API_KEY;
delete process.env.GOOGLE_CSE_ID;
delete process.env.ATLASSIAN_EMAIL;
delete process.env.ATLASSIAN_API_TOKEN;
delete process.env.SLACK_USER_TOKEN;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Cannot find module .../src/claude/search-executor.js`.

- [ ] **Step 3: Create the Search Executor**

Create `src/claude/search-executor.js`:

```javascript
import { searchKnowledgeBase } from './kb-search.js';
import { searchConfluence, searchJira } from './atlassian-search.js';
import { searchSlackMessages } from '../slack/search-client.js';

const SOURCE_FUNCS = {
  kb: searchKnowledgeBase,
  confluence: searchConfluence,
  jira: searchJira,
  slack: searchSlackMessages,
};

/**
 * Runs every source in the plan in parallel. Returns a map keyed by source name
 * with `{ ...result, priority }` for sources that returned data, `null` for
 * sources that were absent from the plan, errored, or returned no results.
 *
 * @param {{ sources: Array<{ name: string, priority: string, query: string }> }} plan
 * @returns {Promise<Record<'kb'|'confluence'|'jira'|'slack', object|null>>}
 */
export async function executeSearchPlan(plan) {
  const sources = plan?.sources ?? [];
  const tasks = sources.map(s => {
    const fn = SOURCE_FUNCS[s.name];
    if (!fn) return Promise.resolve({ name: s.name, value: null });
    return Promise.resolve(fn(s.query))
      .then(v => ({ name: s.name, value: v, priority: s.priority }))
      .catch(() => ({ name: s.name, value: null }));
  });

  const settled = await Promise.allSettled(tasks);

  const result = { kb: null, confluence: null, jira: null, slack: null };
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value?.value) {
      result[r.value.name] = { ...r.value.value, priority: r.value.priority };
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all new assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude/search-executor.js test.js
git commit -m "feat: add Search Executor running plan sources in parallel"
```

---

### Task 4: Answerer system prompt extraction

**Files:**
- Create: `src/claude/prompts/answerer.js`

The existing `src/claude/prompts.js` exports `SYSTEM_PROMPT_CSA`, `SYSTEM_PROMPT_SPECIALIST`, `parseClaudeResponse`, `summarizeResultForHistory`, `CHAT_SYSTEM_PROMPT`, `parseChatResponse`. We extract a clean copy of the CSA + Specialist prompts, **delete the `HARD RULE — MANDATORY SEARCHES` block**, and **replace any phrasing that mentions Atlassian as an MCP tool** with REST-aware language.

This task is a careful port — no behavior change beyond those two deletions. The same prompts will be served by the Answerer.

- [ ] **Step 1: Read the existing prompts to identify what to port**

```bash
cd ~/Slack-Intbot && grep -n "MANDATORY SEARCHES\|atlassian.*search.*tools\|HARD RULE" src/claude/prompts.js
```

Expected output: line numbers for the MANDATORY-SEARCHES block and any "atlassian tools" references inside `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST`.

- [ ] **Step 2: Create the new prompts/ directory and answerer.js**

Read `src/claude/prompts.js` and identify:
- The `SHARED_RULES` constant (if present) and the body of `SYSTEM_PROMPT_CSA`
- The body of `SYSTEM_PROMPT_SPECIALIST`
- `parseClaudeResponse` and `summarizeResultForHistory` functions

Create `src/claude/prompts/answerer.js` with the same exports, copying verbatim, then:
- Delete the `HARD RULE — MANDATORY SEARCHES` block entirely
- Replace any phrase like "use your atlassian and slack search tools" with "review the [CONFLUENCE RESULTS], [JIRA RESULTS], [KB RESULTS], and [SLACK RESULTS] context blocks provided"

Skeleton (fill in the verbatim ported text from `src/claude/prompts.js`):

```javascript
/**
 * Answerer stage prompts.
 *
 * Ported from src/claude/prompts.js (the original SYSTEM_PROMPT_CSA / SYSTEM_PROMPT_SPECIALIST),
 * with two deletions:
 *   1. The HARD RULE — MANDATORY SEARCHES block (it forced Claude to call Slack MCP
 *      before emitting JSON; the new pipeline does search upstream, not inside Claude).
 *   2. Phrasing that mentions Atlassian as an MCP tool (Atlassian is REST now).
 */

const SHARED_RULES = `[paste verbatim from prompts.js's SHARED_RULES]`;

export const ANSWERER_PROMPT_CSA = `[paste verbatim from prompts.js's SYSTEM_PROMPT_CSA, minus MANDATORY block + atlassian-as-tool phrasing]`;

export const ANSWERER_PROMPT_SPECIALIST = `[paste verbatim from prompts.js's SYSTEM_PROMPT_SPECIALIST, minus MANDATORY block + atlassian-as-tool phrasing]`;

export { parseClaudeResponse, summarizeResultForHistory } from '../prompts.js';
```

The `export { ... } from '../prompts.js'` re-exports re-use the existing parser without duplicating code. They'll be replaced by direct exports in the cleanup phase.

- [ ] **Step 3: Sanity-check the prompt diff**

```bash
diff <(cat src/claude/prompts.js | grep -A 200 "SYSTEM_PROMPT_CSA = ") <(cat src/claude/prompts/answerer.js | grep -A 200 "ANSWERER_PROMPT_CSA = ") | head -50
```

Expected: only the MANDATORY block and atlassian-tool phrasing show as deletions. Nothing else should differ.

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts/answerer.js
git commit -m "feat: extract Answerer prompts (CSA + Specialist) without MANDATORY-SEARCHES rule"
```

---

### Task 5: Answerer stage

**Files:**
- Create: `src/claude/answerer.js`
- Test: `test.js`

The Answerer takes the cleaned question, search results, role, team knowledge, and feedback corrections, calls Claude Sonnet 4.6 with the answerer prompt, and returns the parsed structured response.

- [ ] **Step 1: Write the failing test**

Append to `test.js`:

```javascript
// ── answerer ──────────────────────────────────────────────────────────────────
console.log('\n🔹 answerer');

import { runAnswerer } from './src/claude/answerer.js';

// Mock the Anthropic SDK by intercepting fetch (the SDK uses fetch under the hood)
const origFetchAns = globalThis.fetch;
let lastAnthropicBody;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    lastAnthropicBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"issue_title":"Test","integration_type":"Zapier","is_accounting_topic":false,"confidence":"high","customer_message":"Hi.","escalate_decision":{"should_escalate":false,"reason":""},"channel_recommendation":{"channel":"","reason":""},"agent_steps":[],"findings_summary":{"diagnosis":"","actions":[]},"slack_refs":[],"atlassian_refs":[],"kb_refs":[],"sources_used":["slack"]}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchAns(url, opts);
};
process.env.ANTHROPIC_API_KEY = 'test-key';

const result = await runAnswerer({
  cleanedQuestion: 'Zapier not syncing',
  searchResults: {
    kb: null,
    confluence: { text: 'C content', refs: [], priority: 'high' },
    jira: null,
    slack: { text: 'S content', refs: [], priority: 'high' },
  },
  role: 'csa',
  teamKnowledge: 'TK content',
  feedbackContext: 'Past correction: X',
});

assert(result !== null, 'answerer returns parsed JSON');
assert(result.issue_title === 'Test', 'parses issue_title');
assert(result.integration_type === 'Zapier', 'parses integration_type');
assert(lastAnthropicBody.system.includes('CSA') || lastAnthropicBody.system.includes('Customer Support'), 'uses CSA system prompt for csa role');
assert(lastAnthropicBody.messages[0].content.includes('Zapier not syncing'), 'user content includes cleaned question');
assert(lastAnthropicBody.messages[0].content.includes('TK content'), 'user content includes team knowledge');
assert(lastAnthropicBody.messages[0].content.includes('C content'), 'user content includes confluence');
assert(lastAnthropicBody.messages[0].content.includes('S content'), 'user content includes slack');
assert(lastAnthropicBody.messages[0].content.includes('Past correction: X'), 'user content includes feedback');
assert(!('mcp_servers' in lastAnthropicBody), 'no mcp_servers in answerer call (Slack moved to Web API)');

// Specialist role uses specialist prompt
await runAnswerer({
  cleanedQuestion: 'q',
  searchResults: { kb: null, confluence: null, jira: null, slack: null },
  role: 'specialist',
  teamKnowledge: null,
  feedbackContext: '',
});
assert(lastAnthropicBody.system.includes('Specialist'), 'uses Specialist prompt for specialist role');

globalThis.fetch = origFetchAns;
delete process.env.ANTHROPIC_API_KEY;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Cannot find module .../src/claude/answerer.js`.

- [ ] **Step 3: Create the Answerer**

Create `src/claude/answerer.js`:

```javascript
import Anthropic from '@anthropic-ai/sdk';
import { ANSWERER_PROMPT_CSA, ANSWERER_PROMPT_SPECIALIST, parseClaudeResponse } from './prompts/answerer.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10) || 90000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Final stage: takes cleaned question + search results + context, returns parsed
 * structured response in the existing CSA / Specialist JSON schema.
 *
 * No MCP. No mandatory-search rule. Sources come in via the searchResults parameter
 * pre-fetched by the Search Executor.
 *
 * @param {object} args
 * @param {string} args.cleanedQuestion
 * @param {object} args.searchResults - { kb, confluence, jira, slack } each {text,refs,priority}|null
 * @param {'csa'|'specialist'} args.role
 * @param {string|null} args.teamKnowledge - contents of data/knowledge.md or null
 * @param {string} args.feedbackContext - sanitized past corrections (empty string if none)
 * @param {string|null} args.agentName - to personalize customer_message
 * @returns {Promise<object>} Parsed JSON response. Throws on Anthropic failure or parse failure.
 */
export async function runAnswerer({
  cleanedQuestion,
  searchResults,
  role,
  teamKnowledge,
  feedbackContext,
  agentName = null,
}) {
  const basePrompt = role === 'specialist' ? ANSWERER_PROMPT_SPECIALIST : ANSWERER_PROMPT_CSA;
  const systemPrompt = agentName
    ? `${basePrompt}\n\nThe agent's display name is: ${agentName}. Use this name in customer_message.`
    : basePrompt;

  let userContent = `Issue: ${cleanedQuestion}`;
  if (teamKnowledge) userContent += `\n\n[TEAM KNOWLEDGE]\n${teamKnowledge}\n[/TEAM KNOWLEDGE]`;
  if (searchResults.kb?.text)         userContent += `\n\n[KB RESULTS]\n${searchResults.kb.text}\n[/KB RESULTS]`;
  if (searchResults.confluence?.text) userContent += `\n\n[CONFLUENCE RESULTS]\n${searchResults.confluence.text}\n[/CONFLUENCE RESULTS]`;
  if (searchResults.jira?.text)       userContent += `\n\n[JIRA RESULTS]\n${searchResults.jira.text}\n[/JIRA RESULTS]`;
  if (searchResults.slack?.text)      userContent += `\n\n[SLACK RESULTS]\n${searchResults.slack.text}\n[/SLACK RESULTS]`;
  if (feedbackContext)                userContent += feedbackContext;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }, { signal: controller.signal });

    const fullText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const parsed = parseClaudeResponse(fullText);
    if (!parsed) throw new Error('Could not parse Answerer response.');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
```

Note: no `betas: ['mcp-client-2025-04-04']` because the Answerer doesn't use MCP.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all new assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude/answerer.js test.js
git commit -m "feat: add Answerer stage (final-response Sonnet call, no MCP)"
```

---

### Task 6: Interpreter system prompt + golden fixtures

**Files:**
- Create: `src/claude/prompts/interpreter.js`
- Create: `test/fixtures/interpreter-queries.json`

- [ ] **Step 1: Create the Interpreter system prompt**

Create `src/claude/prompts/interpreter.js`:

```javascript
export const INTERPRETER_PROMPT = `You are the Interpreter stage of IntegrationsBot — an internal Slack bot for ServiceTitan integrations support agents. Your job is to take a raw user message and produce a structured JSON object that downstream stages can use to plan a search and write an answer.

Your only output is a single JSON object. No prose. No markdown fences.

# Input
You receive a raw user message. It may contain:
- A real question
- Pasted email content with greetings, signatures, quoted history
- Customer names, tenant IDs, redundant references
- Multiple questions stacked together

# Your output
{
  "cleaned_question": "string — the core question, stripped of email noise, names, and redundant references. 1–2 sentences max.",
  "intent": "troubleshooting | how-to | policy | integration-setup | unclear",
  "entities": {
    "integration": "Zapier | Angi | RwG | ServiceChannel | Thumbtack | Procore | Chat-to-Text | null",
    "error_code": "exact code or HTTP status if mentioned, else null",
    "tenant_id": "tenant identifier if mentioned, else null",
    "customer_mentioned": "boolean — true if the agent is asking on behalf of a named customer",
    "symptom": "short noun phrase describing what's wrong, null for non-troubleshooting intents"
  },
  "question_confidence": "high | medium | low",
  "clarifying_question": "string when question_confidence is low, else null",
  "search_plan": {
    "sources": [
      { "name": "confluence", "priority": "high|medium|low", "query": "targeted keyword string" },
      { "name": "slack",      "priority": "high|medium|low", "query": "..." },
      { "name": "kb",         "priority": "high|medium|low", "query": "..." },
      { "name": "jira",       "priority": "high|medium|low", "query": "..." }
    ],
    "rationale": "one sentence explaining the source choices"
  }
}

# Confidence rules
- high: the integration is named AND the symptom is clear AND there's no contradiction
- medium: one side is named, the other is vague — search anyway, but be prepared for a clarifying question downstream
- low: integration is missing AND symptom is vague, or the message contradicts itself → set intent to "unclear", set clarifying_question, set search_plan to null

# Intent rules
- troubleshooting: something is broken; user wants a fix
- how-to: user wants to know how to do something that's already working
- policy: questions about scopes, rules, who-owns-what, escalation paths
- integration-setup: net-new integration onboarding — separate Confluence space; no error to diagnose
- unclear: only when question_confidence is low

# Source priority rules
- Set priority high when the source is the most likely place to find the answer
- Set priority medium for plausible secondary sources
- Set priority low for sources unlikely to help; include only if there's some chance
- Drop a source from sources[] entirely if it's irrelevant (e.g. Jira for a policy question)

# Cleaning rules
- Strip greetings, signatures, "thanks", email quoting (lines starting with >)
- Replace customer names with the role: "the customer is reporting X"
- Collapse repeated references — only keep one mention of an integration/tenant
- Preserve specific facts: error codes, dates, exact field names

# Examples

User: "Hi team, our customer Acme Corp says their Zapier integration stopped working yesterday. Thanks, Sarah"
Output: {"cleaned_question":"Zapier integration stopped working yesterday for a customer","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":true,"symptom":"stopped working yesterday"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"confluence","priority":"high","query":"Zapier integration troubleshooting"},{"name":"slack","priority":"high","query":"Zapier stopped working"},{"name":"kb","priority":"medium","query":"Zapier integration"},{"name":"jira","priority":"low","query":"Zapier"}],"rationale":"Troubleshooting Zapier; Confluence and Slack are best for recent breakage; KB for general docs."}}

User: "it's not working"
Output: {"cleaned_question":"unspecified integration not working","intent":"unclear","entities":{"integration":null,"error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"not working"},"question_confidence":"low","clarifying_question":"Which integration is having trouble — Zapier, Angi, Reserve with Google, ServiceChannel, Thumbtack, Procore, or Chat-to-Text?","search_plan":null}

# Follow-ups
If you receive prior thread history, treat the current message as a refinement of the previous question. Pull entities from the prior turns. The cleaned_question should be the COMBINED understanding.

Output ONLY the JSON object. No preamble. No code fences. No trailing text.`;
```

- [ ] **Step 2: Create the golden fixtures file**

Create `test/fixtures/interpreter-queries.json`:

```json
{
  "version": 1,
  "note": "Manual prompt-quality gate. Run the Interpreter against real Anthropic with each `input` and verify the actual output matches `expected`. Not executed in CI.",
  "fixtures": [
    {
      "id": "clear-troubleshoot-1",
      "input": "Customer's Zapier integration stopped syncing leads after tenant migration last week",
      "expected": {
        "intent": "troubleshooting",
        "entities": { "integration": "Zapier", "symptom_contains": "sync" },
        "question_confidence": "high",
        "search_plan_must_include": ["confluence", "slack"]
      }
    },
    {
      "id": "clear-troubleshoot-2",
      "input": "We're getting 502 Bad Gateway calling the Angi webhook for new leads",
      "expected": {
        "intent": "troubleshooting",
        "entities": { "integration": "Angi", "error_code_contains": "502" },
        "question_confidence": "high",
        "search_plan_must_include": ["confluence", "slack"]
      }
    },
    {
      "id": "clear-troubleshoot-3",
      "input": "RwG bookings showing pending status but not appearing in the schedule",
      "expected": {
        "intent": "troubleshooting",
        "entities": { "integration": "RwG", "symptom_contains": "pending" },
        "question_confidence": "high",
        "search_plan_must_include": ["confluence", "slack"]
      }
    },
    {
      "id": "vague-1",
      "input": "it's broken",
      "expected": {
        "intent": "unclear",
        "question_confidence": "low",
        "clarifying_question_not_null": true,
        "search_plan_is_null": true
      }
    },
    {
      "id": "vague-2",
      "input": "Something's off with the integration thing",
      "expected": {
        "intent": "unclear",
        "question_confidence": "low",
        "clarifying_question_not_null": true,
        "search_plan_is_null": true
      }
    },
    {
      "id": "email-noise-1",
      "input": "Hi Bot,\n\nHope you had a great weekend! Our customer ABC Corp (tenant 12345) reached out about their Zapier integration. They said it stopped pushing new leads to their CRM since Friday. Could you take a look?\n\nThanks!\nSarah Lee\nIntegrations Specialist\n----\n> Original email from customer:\n> Hi support, our Zapier hasn't been working since Friday.",
      "expected": {
        "intent": "troubleshooting",
        "entities": { "integration": "Zapier", "tenant_id_contains": "12345" },
        "cleaned_question_must_omit": ["Sarah", "Hope you had", "Original email"],
        "question_confidence": "high"
      }
    },
    {
      "id": "email-noise-2",
      "input": "From: customer@example.com\nSubject: ServiceChannel issue\n\nWe're seeing duplicate work orders in ServiceChannel ever since the last release. Can your team check this?\n\n--\nRegards,\nMike\nIT Manager",
      "expected": {
        "intent": "troubleshooting",
        "entities": { "integration": "ServiceChannel", "symptom_contains": "duplicate" },
        "cleaned_question_must_omit": ["From:", "Subject:", "Regards"],
        "question_confidence": "high"
      }
    },
    {
      "id": "how-to-1",
      "input": "How do I enable the Thumbtack integration for an existing tenant?",
      "expected": {
        "intent": "how-to",
        "entities": { "integration": "Thumbtack" },
        "question_confidence": "high",
        "search_plan_must_include": ["confluence", "kb"]
      }
    },
    {
      "id": "policy-1",
      "input": "What's the escalation path when a Procore integration affects multiple tenants?",
      "expected": {
        "intent": "policy",
        "entities": { "integration": "Procore" },
        "question_confidence": "high",
        "search_plan_must_include": ["confluence"]
      }
    },
    {
      "id": "integration-setup-1",
      "input": "What do I need to provision for a brand new Chat-to-Text integration?",
      "expected": {
        "intent": "integration-setup",
        "entities": { "integration": "Chat-to-Text" },
        "question_confidence": "high",
        "search_plan_must_include": ["confluence"]
      }
    }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add src/claude/prompts/interpreter.js test/fixtures/interpreter-queries.json
git commit -m "feat: add Interpreter system prompt + 10-query golden fixtures"
```

---

### Task 7: Interpreter stage

**Files:**
- Create: `src/claude/interpreter.js`
- Test: `test.js`

- [ ] **Step 1: Write the failing test**

Append to `test.js`:

```javascript
// ── interpreter ───────────────────────────────────────────────────────────────
console.log('\n🔹 interpreter');

import { runInterpreter } from './src/claude/interpreter.js';

const origFetchInt = globalThis.fetch;
let lastInterpreterBody;

// Happy path
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    lastInterpreterBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"cleaned_question":"Zapier stopped syncing","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"stopped syncing"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"confluence","priority":"high","query":"Zapier sync"}],"rationale":"r"}}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchInt(url, opts);
};
process.env.ANTHROPIC_API_KEY = 'test';

const ok = await runInterpreter('Zapier stopped syncing');
assert(ok.cleaned_question === 'Zapier stopped syncing', 'parses cleaned_question');
assert(ok.intent === 'troubleshooting', 'parses intent');
assert(ok.question_confidence === 'high', 'parses question_confidence');
assert(lastInterpreterBody.model === 'claude-haiku-4-5-20251001' || lastInterpreterBody.model.includes('haiku'), 'uses Haiku model');

// Follow-up: thread history passed in
await runInterpreter('still not working', { threadHistory: [
  { role: 'user', content: 'My Zapier broke' },
  { role: 'assistant', content: 'Did you check the API toggle?' },
]});
assert(lastInterpreterBody.messages.length >= 1, 'has user message');
const lastMsg = lastInterpreterBody.messages[lastInterpreterBody.messages.length - 1].content;
assert(lastMsg.includes('still not working'), 'includes current message');
assert(lastMsg.includes('Zapier broke'), 'includes prior thread history');

// Retry-once on transient 5xx
let attempts = 0;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    attempts++;
    if (attempts === 1) return new Response('upstream error', { status: 503 });
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"cleaned_question":"q","intent":"unclear","entities":{"integration":null,"error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":null},"question_confidence":"low","clarifying_question":"Which?","search_plan":null}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchInt(url, opts);
};
const retried = await runInterpreter('vague');
assert(attempts === 2, 'retried exactly once on 5xx');
assert(retried.question_confidence === 'low', 'got the eventual response');

// After two failures, falls back to a generic clarifying question
attempts = 0;
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    attempts++;
    return new Response('boom', { status: 503 });
  }
  return origFetchInt(url, opts);
};
const fallback = await runInterpreter('test');
assert(attempts === 2, 'tries twice total before giving up');
assert(fallback.question_confidence === 'low', 'fallback confidence is low');
assert(fallback.intent === 'unclear', 'fallback intent is unclear');
assert(fallback.clarifying_question && fallback.clarifying_question.length > 0, 'fallback includes clarifying_question');
assert(fallback.search_plan === null, 'fallback skips search');

globalThis.fetch = origFetchInt;
delete process.env.ANTHROPIC_API_KEY;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Cannot find module .../src/claude/interpreter.js`.

- [ ] **Step 3: Create the Interpreter**

Create `src/claude/interpreter.js`:

```javascript
import Anthropic from '@anthropic-ai/sdk';
import { INTERPRETER_PROMPT } from './prompts/interpreter.js';

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 15000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FALLBACK = Object.freeze({
  cleaned_question: '',
  intent: 'unclear',
  entities: { integration: null, error_code: null, tenant_id: null, customer_mentioned: false, symptom: null },
  question_confidence: 'low',
  clarifying_question: 'I had trouble understanding the question — can you rephrase it with the integration name and what specifically is going wrong?',
  search_plan: null,
});

function buildUserMessage(rawQuery, threadHistory) {
  if (!threadHistory || threadHistory.length === 0) return rawQuery;
  const historyText = threadHistory.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n');
  return `[PRIOR THREAD HISTORY]\n${historyText}\n[/PRIOR THREAD HISTORY]\n\nCURRENT MESSAGE: ${rawQuery}`;
}

async function callOnce(userMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: INTERPRETER_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }, { signal: controller.signal });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Interpreter response');
    return JSON.parse(match[0]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the Interpreter. Retries once on any failure. Returns FALLBACK after
 * two failures (intent: "unclear", clarifying_question set, search_plan null).
 *
 * @param {string} rawQuery
 * @param {object} [opts]
 * @param {Array<{role: string, content: string}>} [opts.threadHistory]
 * @returns {Promise<object>} The Interpreter output (never throws).
 */
export async function runInterpreter(rawQuery, { threadHistory = [] } = {}) {
  const userMessage = buildUserMessage(rawQuery, threadHistory);
  try {
    return await callOnce(userMessage);
  } catch (err1) {
    console.warn('[interpreter] first attempt failed:', err1.message);
    try {
      return await callOnce(userMessage);
    } catch (err2) {
      console.warn('[interpreter] second attempt failed, returning fallback:', err2.message);
      return FALLBACK;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all new assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude/interpreter.js test.js
git commit -m "feat: add Interpreter stage with retry-once and clarifying-question fallback"
```

---

### Task 8: Evaluator system prompt + stage

**Files:**
- Create: `src/claude/prompts/evaluator.js`
- Create: `src/claude/evaluator.js`
- Test: `test.js`

- [ ] **Step 1: Create the Evaluator system prompt**

Create `src/claude/prompts/evaluator.js`:

```javascript
export const EVALUATOR_PROMPT = `You are the Evaluator stage of IntegrationsBot. Your job is to judge whether the search results we already have are enough to answer the cleaned question, or whether we should run one refined search round to find better material.

Your only output is a single JSON object. No prose. No markdown fences.

# Input
You receive:
- The cleaned question
- The search results from round 1: each of KB, Confluence, Jira, Slack is either a list of refs/snippets or null
- The original search plan that produced these results

# Your output
{
  "sufficient": true | false,
  "rationale": "one sentence explaining why",
  "refined_plan": {
    "sources": [
      { "name": "confluence|slack|kb|jira", "priority": "high|medium|low", "query": "improved keyword string" }
    ]
  } | null
}

# Rules
- sufficient: true when at least one source returned material that clearly addresses the cleaned question. Set refined_plan to null.
- sufficient: false when round 1 returned nothing relevant, returned material about a different integration or symptom, or was too generic. Emit a refined_plan with at most 2 sources and tighter keywords. Skip sources that already returned good material.
- Be conservative: prefer "sufficient: true" if results are at least passable. A second round costs ~5 seconds.
- Do NOT include a source in refined_plan that already returned good material in round 1.
- Output ONLY the JSON object.`;
```

- [ ] **Step 2: Write the failing test for the stage**

Append to `test.js`:

```javascript
// ── evaluator ─────────────────────────────────────────────────────────────────
console.log('\n🔹 evaluator');

import { runEvaluator } from './src/claude/evaluator.js';

const origFetchEv = globalThis.fetch;

// Sufficient: true → proceed
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"sufficient":true,"rationale":"good","refined_plan":null}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchEv(url, opts);
};
process.env.ANTHROPIC_API_KEY = 'test';

const suff = await runEvaluator({ cleanedQuestion: 'q', searchResults: { kb: null, confluence: { text: 't', refs: [] }, jira: null, slack: null }, originalPlan: { sources: [] } });
assert(suff.sufficient === true, 'parses sufficient: true');
assert(suff.refined_plan === null, 'refined_plan null when sufficient');

// Sufficient: false → refined plan
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('anthropic.com')) {
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"sufficient":false,"rationale":"results off-topic","refined_plan":{"sources":[{"name":"slack","priority":"high","query":"better keywords"}]}}' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetchEv(url, opts);
};
const insuff = await runEvaluator({ cleanedQuestion: 'q', searchResults: { kb: null, confluence: null, jira: null, slack: null }, originalPlan: { sources: [] } });
assert(insuff.sufficient === false, 'parses sufficient: false');
assert(insuff.refined_plan.sources[0].query === 'better keywords', 'parses refined query');

// Failure → assume sufficient
globalThis.fetch = async () => new Response('boom', { status: 503 });
const failed = await runEvaluator({ cleanedQuestion: 'q', searchResults: { kb: null, confluence: null, jira: null, slack: null }, originalPlan: { sources: [] } });
assert(failed.sufficient === true, 'failure assumes sufficient (skip refinement)');
assert(failed.refined_plan === null, 'no refined plan on failure');

globalThis.fetch = origFetchEv;
delete process.env.ANTHROPIC_API_KEY;
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Cannot find module .../src/claude/evaluator.js`.

- [ ] **Step 4: Create the Evaluator**

Create `src/claude/evaluator.js`:

```javascript
import Anthropic from '@anthropic-ai/sdk';
import { EVALUATOR_PROMPT } from './prompts/evaluator.js';

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 15000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function summarizeResults(searchResults) {
  const lines = [];
  for (const [name, r] of Object.entries(searchResults)) {
    if (!r) { lines.push(`${name.toUpperCase()}: (no results)`); continue; }
    lines.push(`${name.toUpperCase()}: ${r.text ?? '(empty text)'}`);
  }
  return lines.join('\n\n');
}

/**
 * Runs the Evaluator on round-1 results. If the call fails, assumes sufficient:true
 * (skips refinement). Never throws — refinement is an optimization, not required.
 *
 * @param {{ cleanedQuestion: string, searchResults: object, originalPlan: object }} input
 * @returns {Promise<{ sufficient: boolean, rationale: string, refined_plan: object|null }>}
 */
export async function runEvaluator({ cleanedQuestion, searchResults, originalPlan }) {
  const userContent = `Cleaned question: ${cleanedQuestion}\n\nOriginal plan: ${JSON.stringify(originalPlan)}\n\nRound 1 results:\n${summarizeResults(searchResults)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: EVALUATOR_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }, { signal: controller.signal });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in Evaluator response');
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('[evaluator] failed, assuming sufficient:', err.message);
    return { sufficient: true, rationale: 'evaluator failed; skipping refinement', refined_plan: null };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all new assertions pass.

- [ ] **Step 6: Commit**

```bash
git add src/claude/prompts/evaluator.js src/claude/evaluator.js test.js
git commit -m "feat: add Evaluator stage with assume-sufficient fallback on failure"
```

---

### Task 9: Two-key cache support

**Files:**
- Modify: `src/slack/cache.js`
- Test: `test.js`

- [ ] **Step 1: Write the failing test**

Append to `test.js`:

```javascript
// ── cache two-key support ─────────────────────────────────────────────────────
console.log('\n🔹 cache two-key');

import { setCachedMulti } from './src/slack/cache.js';
const dummy = { issue_title: 'X' };

// Setting under raw + cleaned makes both keys hit
setCachedMulti(['raw text here', 'raw text'], dummy);
assert(getCached('raw text here') !== null, 'raw key1 hits');
assert(getCached('raw text') !== null, 'raw key2 hits');
assert(getCached('different query') === null, 'unrelated key misses');

// Single-key call still works
setCachedMulti(['only one'], dummy);
assert(getCached('only one') !== null, 'single-key write works');
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: `setCachedMulti is not exported`.

- [ ] **Step 3: Add `setCachedMulti` to cache.js**

In `src/slack/cache.js`, after the existing `setCached` function, add:

```javascript
/**
 * Stores a response under multiple keys (e.g. raw query + cleaned_question).
 * Both keys point at the same data object, so memory cost is just the keys.
 *
 * @param {string[]} keys - distinct queries that should map to the same response
 * @param {object} data
 */
export function setCachedMulti(keys, data) {
  for (const k of keys) {
    if (k != null && k !== '') setCached(k, data);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all new assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/slack/cache.js test.js
git commit -m "feat: add setCachedMulti for two-key cache writes (raw + cleaned)"
```

---

### Task 10: Pipeline orchestrator

**Files:**
- Create: `src/claude/pipeline.js`
- Test: `test.js`

The orchestrator wires it all together: Interpreter → Search → Evaluator → maybe refined Search → Answerer. Enforces the 60s hard cap with AbortController. Retries the Answerer once on transient errors. Returns either a `clarifying_question` shortcut response or the full Answerer JSON.

- [ ] **Step 1: Write the failing test**

Append to `test.js`:

```javascript
// ── pipeline orchestrator ─────────────────────────────────────────────────────
console.log('\n🔹 pipeline');

import { runPipeline } from './src/claude/pipeline.js';

const origFetchPipe = globalThis.fetch;
process.env.ANTHROPIC_API_KEY = 'test';

// Sequence of Anthropic responses: Interpreter → Evaluator → Answerer
let stepCounter = 0;
const sequenceResponses = [];
function nextResponse() {
  const r = sequenceResponses[stepCounter++];
  if (!r) throw new Error(`No response queued for step ${stepCounter}`);
  return r;
}

function anthropicMock(body) {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: body }],
    stop_reason: 'end_turn',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function passThroughFetch(url, opts) {
  if (typeof url === 'string' && url.includes('anthropic.com')) return nextResponse();
  if (typeof url === 'string' && (url.includes('atlassian.net') || url.includes('customsearch') || url.includes('slack.com/api'))) {
    return new Response(JSON.stringify({ results: [], items: [], issues: [], messages: { matches: [] } }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
}

// Test A: question_confidence: low → clarifying-question shortcut
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  anthropicMock('{"cleaned_question":"vague","intent":"unclear","entities":{"integration":null,"error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":null},"question_confidence":"low","clarifying_question":"Which one?","search_plan":null}'),
);
globalThis.fetch = passThroughFetch;
const lowConfResult = await runPipeline({ rawQuery: 'vague', role: 'csa' });
assert(lowConfResult.clarifying_question === 'Which one?', 'low-confidence shortcut returns clarifying_question');
assert(stepCounter === 1, 'only Interpreter was called');

// Test B: sufficient:true → skips refinement
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  // Interpreter
  anthropicMock('{"cleaned_question":"q","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"x"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"slack","priority":"high","query":"q"}],"rationale":"r"}}'),
  // Evaluator
  anthropicMock('{"sufficient":true,"rationale":"good","refined_plan":null}'),
  // Answerer
  anthropicMock('{"issue_title":"T","integration_type":"Zapier","is_accounting_topic":false,"confidence":"high","customer_message":"","escalate_decision":{"should_escalate":false,"reason":""},"channel_recommendation":{"channel":"","reason":""},"agent_steps":[],"findings_suuary":{"diagnosis":"","actions":[]},"slack_refs":[],"atlassian_refs":[],"kb_refs":[],"sources_used":["slack"]}'),
);
globalThis.fetch = passThroughFetch;
const okResult = await runPipeline({ rawQuery: 'Zapier broke', role: 'csa' });
assert(okResult.issue_title === 'T', 'Answerer ran');
assert(stepCounter === 3, 'Interpreter + Evaluator + Answerer (no refinement)');

// Test C: sufficient:false → exactly one refinement
stepCounter = 0;
sequenceResponses.length = 0;
sequenceResponses.push(
  // Interpreter
  anthropicMock('{"cleaned_question":"q","intent":"troubleshooting","entities":{"integration":"Zapier","error_code":null,"tenant_id":null,"customer_mentioned":false,"symptom":"x"},"question_confidence":"high","clarifying_question":null,"search_plan":{"sources":[{"name":"slack","priority":"high","query":"q"}],"rationale":"r"}}'),
  // Evaluator (insufficient)
  anthropicMock('{"sufficient":false,"rationale":"miss","refined_plan":{"sources":[{"name":"slack","priority":"high","query":"q2"}]}}'),
  // Answerer
  anthropicMock('{"issue_title":"T2","integration_type":"Zapier","is_accounting_topic":false,"confidence":"medium","customer_message":"","escalate_decision":{"should_escalate":false,"reason":""},"channel_recommendation":{"channel":"","reason":""},"agent_steps":[],"findings_summary":{"diagnosis":"","actions":[]},"slack_refs":[],"atlassian_refs":[],"kb_refs":[],"sources_used":["slack"]}'),
);
globalThis.fetch = passThroughFetch;
const refinedResult = await runPipeline({ rawQuery: 'Zapier broke', role: 'csa' });
assert(refinedResult.issue_title === 'T2', 'Answerer ran after refinement');
assert(stepCounter === 3, 'Interpreter + Evaluator + Answerer (refinement triggers a second SEARCH, not a second Evaluator)');

globalThis.fetch = origFetchPipe;
delete process.env.ANTHROPIC_API_KEY;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test.js 2>&1 | tail -5
```

Expected: `Cannot find module .../src/claude/pipeline.js`.

- [ ] **Step 3: Create the orchestrator**

Create `src/claude/pipeline.js`:

```javascript
import { runInterpreter } from './interpreter.js';
import { executeSearchPlan } from './search-executor.js';
import { runEvaluator } from './evaluator.js';
import { runAnswerer } from './answerer.js';
import { getKnowledge } from '../slack/knowledge.js';
import { getRelevantFeedback } from '../slack/feedback.js';

const HARD_CAP_MS = 60000;

/**
 * Sanitizes past corrections for injection into the Answerer prompt.
 * Mirrors the logic from src/handlers/mention.js so behavior matches today.
 */
function sanitize(str) {
  return String(str ?? '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*>]+/gm, '')
    .trim()
    .slice(0, 300);
}

async function buildFeedbackContext(rawQuery) {
  try {
    const corrections = await getRelevantFeedback(rawQuery);
    if (corrections.length === 0) return '';
    const lines = corrections.map(c =>
      `- Query: "${sanitize(c.query)}" → Bot was wrong (${c.feedbackType}). Correct answer: ${sanitize(c.correction)}`,
    );
    return `\n\nIMPORTANT — Past corrections from agents (use these to avoid repeating mistakes):\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * Runs the four-stage pipeline. Returns either:
 *   - { clarifying_question, ...minimal fields } if question_confidence was low, OR
 *   - the full Answerer JSON response (existing CSA / Specialist schema)
 *
 * Hard cap: 60s. AbortController wraps the entire pipeline.
 *
 * @param {object} input
 * @param {string} input.rawQuery
 * @param {'csa'|'specialist'} input.role
 * @param {string|null} [input.agentName]
 * @param {Array<{role:string,content:string}>} [input.threadHistory]
 * @param {(event: object) => void} [input.onProgress]
 * @returns {Promise<object>} pipeline output (a parsed response, or the shortcut)
 */
export async function runPipeline({ rawQuery, role, agentName = null, threadHistory = [], onProgress }) {
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), HARD_CAP_MS);

  try {
    // Stage 1: Interpreter
    onProgress?.({ phase: 'stage', stage: 'interpreter' });
    const interp = await runInterpreter(rawQuery, { threadHistory });

    if (interp.question_confidence === 'low') {
      // Shortcut: return a clarifying-question response that downstream Block Kit can render
      return {
        clarifying_question: interp.clarifying_question,
        cleaned_question: interp.cleaned_question,
      };
    }

    // Stage 2: Search Round 1
    onProgress?.({ phase: 'stage', stage: 'search-1' });
    let searchResults = await executeSearchPlan(interp.search_plan);

    // Stage 3: Evaluator
    onProgress?.({ phase: 'stage', stage: 'evaluator' });
    const eval_ = await runEvaluator({
      cleanedQuestion: interp.cleaned_question,
      searchResults,
      originalPlan: interp.search_plan,
    });

    // Stage 2b: Refinement (at most once)
    if (!eval_.sufficient && eval_.refined_plan) {
      onProgress?.({ phase: 'stage', stage: 'search-2' });
      const round2 = await executeSearchPlan(eval_.refined_plan);
      // Merge round 2 over round 1 (round 2 wins where present)
      for (const k of Object.keys(round2)) {
        if (round2[k]) searchResults[k] = round2[k];
      }
    }

    // Stage 4: Answerer
    onProgress?.({ phase: 'stage', stage: 'answerer' });
    const teamKnowledge = await getKnowledge().catch(() => null);
    const feedbackContext = await buildFeedbackContext(rawQuery);

    let answer;
    try {
      answer = await runAnswerer({
        cleanedQuestion: interp.cleaned_question,
        searchResults,
        role,
        teamKnowledge,
        feedbackContext,
        agentName,
      });
    } catch (err1) {
      // Retry once on transient errors only (5xx, abort, network)
      const transient = err1.status >= 500 || err1.name === 'AbortError' || err1.code === 'ECONNRESET';
      if (!transient) throw err1;
      console.warn('[pipeline] Answerer first attempt failed, retrying:', err1.message);
      answer = await runAnswerer({
        cleanedQuestion: interp.cleaned_question,
        searchResults,
        role,
        teamKnowledge,
        feedbackContext,
        agentName,
      });
    }

    // Attach the cleaned_question so the caller can use it as the second cache key
    answer._cleanedQuestion = interp.cleaned_question;
    return answer;
  } finally {
    clearTimeout(overallTimer);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test.js 2>&1 | tail -10
```

Expected: all new assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/claude/pipeline.js test.js
git commit -m "feat: add Pipeline orchestrator with retry, refinement cap, and 60s budget"
```

---

### Task 11: Wire pipeline into handleQuery

**Files:**
- Modify: `src/handlers/mention.js`

This task plumbs `runPipeline` into the existing 16-step flow at:
- Step 6 (follow-ups in active threads)
- Step 10 (initial Claude call)

Both branches check `isNewPipelineEnabled()`; when false, today's behavior is preserved exactly.

- [ ] **Step 1: Add the import**

In `src/handlers/mention.js`, near the other claude imports (around line 5–10), add:

```javascript
import { runPipeline } from '../claude/pipeline.js';
import { isNewPipelineEnabled } from '../utils/feature-flags.js';
import { setCachedMulti } from '../slack/cache.js';
```

- [ ] **Step 2: Branch step 6 (follow-up path)**

Find the follow-up block that starts with `if (hasHistory(threadTs)) {` (around line 119). Immediately after that opening line, before the existing `const history = getHistory(threadTs);` line, insert:

```javascript
if (isNewPipelineEnabled()) {
  const history = getHistory(threadTs);

  let thinkingTs;
  try {
    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildThinkingBlocks(query),
      text: 'Thinking…',
    });
    thinkingTs = thinkingMsg.ts;
  } catch (err) {
    console.error('[mention] Failed to post thinking message:', err.message);
  }

  const { role: fuRole, agentName: fuAgentName } = await detectAgentRole(client, userId);

  let pipelineResult;
  try {
    pipelineResult = await runPipeline({
      rawQuery: query,
      role: fuRole,
      agentName: fuAgentName,
      threadHistory: history,
    });
  } catch (err) {
    console.error('[mention] pipeline (follow-up) failed:', err.message);
    const errText = 'Something went wrong — please retry or escalate manually.';
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText, blocks: buildErrorBlocks(query) });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errText, blocks: buildErrorBlocks(query) });
    }
    return;
  }

  // Clarifying-question shortcut
  if (pipelineResult.clarifying_question) {
    const blocks = buildFollowUpBlocks(pipelineResult.clarifying_question, { label: 'Diagnosing…' });
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: pipelineResult.clarifying_question.slice(0, 200) });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: pipelineResult.clarifying_question.slice(0, 200) });
    }
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: pipelineResult.clarifying_question },
    ]);
    return;
  }

  // Full structured response
  const blocks = buildResponseBlocks(pipelineResult, { isDm, role: fuRole });
  const plainText = `Troubleshooting steps for: ${pipelineResult.issue_title}`;
  if (thinkingTs) {
    await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: plainText.slice(0, 200) });
  } else {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: plainText.slice(0, 200) });
  }
  appendToHistory(threadTs, [
    { role: 'user', content: query },
    { role: 'assistant', content: summarizeResultForHistory(pipelineResult) },
  ]);
  return;
}
```

Leave the existing follow-up code below this insertion — it stays as the `NEW_PIPELINE=false` path. The new code returns early when the flag is on.

- [ ] **Step 3: Branch step 10 (initial query path)**

Find the comment `// 10. Full Claude query (MCP search — slowest path)` (around line 275). Immediately before the `const queryStart = Date.now();` line, insert:

```javascript
if (isNewPipelineEnabled()) {
  const queryStartPipe = Date.now();
  let pipelineResult;
  try {
    pipelineResult = await runPipeline({
      rawQuery: query,
      role,
      agentName,
    });
  } catch (err) {
    console.error('[mention] pipeline (initial) failed:', err.message);
    const errBlocks = buildErrorBlocks(query);
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: errBlocks, text: 'Something went wrong' });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: errBlocks, text: 'Something went wrong' });
    }
    return;
  }

  // Clarifying-question shortcut (no caching, no nomination)
  if (pipelineResult.clarifying_question) {
    const blocks = buildFollowUpBlocks(pipelineResult.clarifying_question, { label: 'Diagnosing…' });
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: pipelineResult.clarifying_question.slice(0, 200) });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: pipelineResult.clarifying_question.slice(0, 200) });
    }
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: pipelineResult.clarifying_question },
    ]);
    return;
  }

  // Accounting double-check (matches today's step 12)
  if (pipelineResult.is_accounting_topic) {
    const acctBlocks = buildAccountingRedirectBlocks(query);
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: acctBlocks, text: 'Routed to accounting channel.' });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: acctBlocks, text: 'Routed to accounting channel.' });
    }
    return;
  }

  // Cache the result under raw + cleaned keys
  const cleaned = pipelineResult._cleanedQuestion;
  delete pipelineResult._cleanedQuestion;
  setCachedMulti([query, cleaned].filter(Boolean), pipelineResult);

  // Render response
  const blocks = buildResponseBlocks(pipelineResult, { isDm, role });
  const plainText = `Troubleshooting steps for: ${pipelineResult.issue_title}`;
  if (thinkingTs) {
    await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: plainText.slice(0, 200) });
  } else {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: plainText.slice(0, 200) });
  }

  // Seed history + nomination, same as today's steps 15 + 16
  appendToHistory(threadTs, [
    { role: 'user', content: query },
    { role: 'assistant', content: summarizeResultForHistory(pipelineResult) },
  ]);

  const elapsedMs = Date.now() - queryStartPipe;
  await maybeNominate(pipelineResult, { query, elapsedMs, channelId, threadTs, client });
  return;
}
```

(Replace `maybeNominate` with whatever wrapper around `nominateResponse` is already used at step 16 — read lines 408–433 of `mention.js` to find the exact call shape. The call must match today's behavior.)

- [ ] **Step 4: Smoke-check the import resolution**

```bash
node -e "import('./src/handlers/mention.js').then(() => console.log('OK')).catch(e => { console.error(e); process.exit(1); })"
```

Expected: `OK`.

- [ ] **Step 5: Run the full test suite**

```bash
node test.js 2>&1 | tail -10
```

Expected: 0 failures. (Tests don't exercise the live pipeline; they exercise individual stages.)

- [ ] **Step 6: Manual smoke-test (gated off)**

```bash
NEW_PIPELINE=false node cli.js
```

Type a real query. Expected: today's behavior, unchanged.

```bash
NEW_PIPELINE=true node cli.js
```

Type a real query. Expected: the new pipeline runs, output is the same JSON schema rendered the same way.

If the CLI invocation fails or behaves differently between the two flag states, fix before moving on.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/mention.js
git commit -m "feat: branch handleQuery to new pipeline when NEW_PIPELINE=true"
```

---

### Task 12: README + docs updates and open the PR

**Files:**
- Modify: `README.md`
- Add a section to existing tests verifying the env flag default

- [ ] **Step 1: Update README**

In `README.md`, add a new section just before the "Project Structure" header:

```markdown
## New pipeline rollout

The bot supports a four-stage query pipeline (Interpreter → Search → Evaluator → Refine → Answerer) behind the `NEW_PIPELINE` feature flag. Default is OFF.

- `NEW_PIPELINE=false` (default) — today's `queryWithContext` / `queryChat` path runs unchanged
- `NEW_PIPELINE=true` — `handleQuery` routes to `src/claude/pipeline.js`, which understands the question first, then searches with targeted keywords

Both initial channel mentions and DM follow-ups respect the flag. Flip with a single env-var change; no code redeploy required to roll back.

See `docs/superpowers/specs/2026-05-19-query-understanding-redesign.md` for the full design.
```

- [ ] **Step 2: Run full tests one more time**

```bash
node test.js 2>&1 | tail -5
```

Expected: 0 failures.

- [ ] **Step 3: Manual verification checklist (do these by hand)**

Before opening the PR, walk through:

```
[ ] NEW_PIPELINE=false: send "@bot Zapier not syncing leads" in a test channel → today's response, unchanged
[ ] NEW_PIPELINE=true:  same query → response card looks the same (same Block Kit schema)
[ ] NEW_PIPELINE=true:  send a vague query "it's broken" → bot returns a clarifying question (no spurious search)
[ ] NEW_PIPELINE=true:  reply to the bot's clarifying question in-thread → pipeline interprets as a refinement
[ ] NEW_PIPELINE=true:  ask the same query twice → second one is a cache hit
[ ] Logs: no references to `MANDATORY SEARCHES`, no Slack MCP calls
```

- [ ] **Step 4: Commit the README change**

```bash
git add README.md
git commit -m "docs: document NEW_PIPELINE rollout flag in README"
```

- [ ] **Step 5: Push branch and open PR**

```bash
git push -u origin feature/query-understanding-redesign
gh pr create --title "feat: query-understanding pipeline (gated off by NEW_PIPELINE)" --body "$(cat <<'EOF'
## Summary

Phase 1 of the redesign in `docs/superpowers/specs/2026-05-19-query-understanding-redesign.md`. Implements the four-stage Interpreter → Search → Evaluator → Refine → Answerer pipeline, fully gated behind `NEW_PIPELINE=false` (default). No production behavior changes until the flag is flipped.

## What's new
- `src/claude/interpreter.js` — Haiku stage: cleans the question, extracts entities, builds a per-source search plan
- `src/claude/search-executor.js` — runs the plan in parallel across KB / Confluence / Jira / Slack Web API
- `src/claude/evaluator.js` — Haiku stage: judges sufficiency, can request one refined round
- `src/claude/answerer.js` — Sonnet stage: ports the existing CSA + Specialist prompts (minus MANDATORY-SEARCHES rule) for the final response
- `src/claude/pipeline.js` — orchestrator with retry, abort, 60s cap
- `src/slack/search-client.js` — direct Slack Web API `search.messages` client (replaces MCP for search)
- `src/utils/feature-flags.js` — `isNewPipelineEnabled()` helper
- `test/fixtures/interpreter-queries.json` — 10-query manual prompt-quality gate

## Test plan
- [x] All existing tests pass (`node test.js` — was 377, now ~430)
- [x] New stage tests: feature-flags, slack-client, search-executor, answerer, interpreter, evaluator, cache-multi, pipeline
- [ ] Manual: `NEW_PIPELINE=false` matches today's behavior exactly
- [ ] Manual: `NEW_PIPELINE=true` returns same response schema for representative queries
- [ ] Manual: vague queries get clarifying questions instead of error cards
- [ ] Manual: interpreter golden fixtures verified against real Anthropic

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 2 — Flip the default to ON

After at least one week of clean production traffic on `NEW_PIPELINE=true` (set via env in your deployment), open a small follow-up PR that flips the default in code.

### Task 13: Default-on flip

**Files:**
- Modify: `src/utils/feature-flags.js`
- Modify: `.env.example`

- [ ] **Step 1: Change the default in feature-flags**

In `src/utils/feature-flags.js`, replace the `isNewPipelineEnabled` body:

```javascript
export function isNewPipelineEnabled() {
  return (process.env.NEW_PIPELINE ?? 'true').toLowerCase() === 'true';
}
```

Default is now `true` when unset; explicit `NEW_PIPELINE=false` still disables.

- [ ] **Step 2: Update the test**

In `test.js`, the feature-flags block needs one assertion changed:

```javascript
delete process.env.NEW_PIPELINE;
assert(isNewPipelineEnabled() === true, 'unset NEW_PIPELINE → true (default-on)');
```

- [ ] **Step 3: Update .env.example**

```
NEW_PIPELINE=true
```

- [ ] **Step 4: Run tests**

```bash
node test.js 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 5: Commit, push, PR**

```bash
git checkout -b feature/new-pipeline-default-on
git add src/utils/feature-flags.js test.js .env.example
git commit -m "feat: default NEW_PIPELINE=true (one-line rollout flip)"
git push -u origin feature/new-pipeline-default-on
gh pr create --title "feat: flip NEW_PIPELINE default to true" --body "One-line default change after one week of clean traffic on the new pipeline. Set NEW_PIPELINE=false in env to roll back."
```

---

## Phase 3 — Cleanup (delete the old path)

After at least one more week with the default-on flag (and confirmation that no env in any deployment is overriding back to `false`), delete the old code path entirely.

### Task 14: Delete legacy code

**Files:**
- Delete: `src/claude/query.js`
- Delete: `src/claude/prompts.js`
- Delete: `process.md`
- Modify: `src/handlers/mention.js` — remove the legacy branches below each `isNewPipelineEnabled()` check, remove the feature-flag check itself
- Modify: `src/utils/feature-flags.js` — delete the file entirely
- Modify: `.env.example` — remove the `NEW_PIPELINE` block
- Modify: `README.md` — drop the "New pipeline rollout" section; replace with a section describing the (now-permanent) pipeline architecture and link to the spec
- Modify: `docs/functionality-overview.md` — rewrite §6 (query pipeline) to reflect the four-stage flow
- Modify: `test.js` — remove tests that depend on the deleted `parseChatResponse` and `queryChat`, remove the feature-flags test block
- Modify: `src/claude/answerer.js` — replace `export { parseClaudeResponse, ... } from '../prompts.js'` with the parser functions inlined (since prompts.js is deleted)

- [ ] **Step 1: Inline the parsers into answerer.js**

Read `src/claude/prompts.js` and copy `parseClaudeResponse` + `summarizeResultForHistory` into `src/claude/prompts/answerer.js`. Replace the re-export at the bottom with direct exports.

- [ ] **Step 2: Update imports in handlers**

Anywhere in `src/handlers/mention.js` or `src/index.js` that imports `parseClaudeResponse` or `summarizeResultForHistory` from `../claude/prompts.js`, change the import path to `../claude/prompts/answerer.js`.

- [ ] **Step 3: Delete feature-flag branches in mention.js**

In `src/handlers/mention.js`:
- Find both `if (isNewPipelineEnabled()) {` blocks
- For each: remove the `if (isNewPipelineEnabled()) {` line and its matching closing `}` so the new-pipeline code runs unconditionally
- Delete the old-path code that follows each of these blocks (the `queryChat` follow-up code, the `queryWithContext` initial path)
- Remove the import of `isNewPipelineEnabled` from the top

- [ ] **Step 4: Delete imports of the removed modules**

In `src/handlers/mention.js`:
- Remove `import { queryWithContext, queryChat } from '../claude/query.js'` (if present after Step 3, it will be unused)

In `src/index.js`:
- Verify it doesn't import from `src/claude/query.js` or `src/claude/prompts.js` directly — if it does, retarget the imports

- [ ] **Step 5: Delete the legacy files**

```bash
rm src/claude/query.js
rm src/claude/prompts.js
rm src/utils/feature-flags.js
rm process.md
```

- [ ] **Step 6: Remove obsolete tests**

In `test.js`:
- Delete the `feature-flags` test block (added in Task 1)
- Delete any tests that import from `./src/claude/query.js` or `./src/claude/prompts.js` directly. Specifically:
  - Tests that import `parseChatResponse` from `./src/claude/query.js` — delete those test blocks
  - Tests that import `parseClaudeResponse` or `summarizeResultForHistory` from `./src/claude/prompts.js` — update the import to `./src/claude/prompts/answerer.js`

- [ ] **Step 7: Update README**

In `README.md`:
- Delete the "New pipeline rollout" section
- Add a new "Architecture" section linking to `docs/superpowers/specs/2026-05-19-query-understanding-redesign.md`

- [ ] **Step 8: Update functionality-overview**

In `docs/functionality-overview.md`, replace §6 (currently describes `queryWithContext`) with a short description of the four-stage pipeline and a pointer to the spec.

- [ ] **Step 9: Remove flag from .env.example**

In `.env.example`, delete the `NEW_PIPELINE` block.

- [ ] **Step 10: Run the full test suite**

```bash
node test.js 2>&1 | tail -5
```

Expected: 0 failures. If anything breaks, the most likely cause is a leftover import to a deleted file — grep for it.

- [ ] **Step 11: Commit, push, PR**

```bash
git checkout -b chore/remove-legacy-query-path
git add -A
git commit -m "chore: delete legacy queryWithContext/queryChat and feature flag"
git push -u origin chore/remove-legacy-query-path
gh pr create --title "chore: delete legacy query path and NEW_PIPELINE flag" --body "Final cleanup after two weeks on the new pipeline. Deletes src/claude/query.js, src/claude/prompts.js, src/utils/feature-flags.js, process.md, and the flag scaffolding in mention.js. No behavior change."
```

---

## Self-review checklist

(Done during plan authoring; recording the results here for the executing engineer.)

**Spec coverage:**
- §1 Architecture → Tasks 2, 3, 5, 7, 8, 10
- §2 Data contracts → enforced in test JSON shapes (Tasks 3, 5, 7, 8)
- §3 Error handling → Task 7 (Interpreter retry+fallback), Task 8 (Evaluator assume-sufficient), Task 10 (Answerer retry on 5xx, 60s AbortController)
- §4 Testing → plain-assert tests in every code task, golden fixtures in Task 6
- §5 Migration → Task 11 (gated flag wiring), Task 12 (Phase 1 PR), Task 13 (Phase 2 flip), Task 14 (Phase 3 cleanup)
- §6 Files touched → mapped 1:1 in "File map for Phase 1" + Task 14 deletions
- §7 Risks → mitigated through retry/fallback (Task 7), assume-sufficient (Task 8), abort cap (Task 10), gated rollout (Tasks 12–14)

**Placeholder scan:** No "TBD", "TODO", or "implement later" remaining. The one "fill in" point in Task 4 (verbatim prompt port) explicitly tells the engineer to read the source and includes a `diff` verification step.

**Type consistency:** Confirmed across tasks:
- `runInterpreter` returns the schema in Task 6 → consumed in Task 10 (`interp.search_plan`, `interp.cleaned_question`, `interp.question_confidence`)
- `executeSearchPlan` returns `{ kb, confluence, jira, slack }` in Task 3 → consumed by `runAnswerer` (Task 5) and `runEvaluator` (Task 8) with the same shape
- `runAnswerer`'s response is the existing CSA / Specialist JSON schema → matches `buildResponseBlocks` expectations in Task 11
- `setCachedMulti` accepts a string array in Task 9 → used with `[query, cleaned].filter(Boolean)` in Task 11
- `runPipeline` attaches `_cleanedQuestion` → consumed in Task 11's step 10 branch

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-query-understanding-redesign.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
