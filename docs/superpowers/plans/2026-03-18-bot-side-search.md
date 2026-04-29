# Bot-Side Search (Slack + Confluence) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken MCP approach with bot-side search — the bot fetches real Slack channel history and Confluence pages before calling Claude, injecting them as grounded context so Claude stops hallucinating.

**Architecture:** Two new search modules (`slack-search.js`, `confluence-search.js`) run in parallel before every Claude call. Results are formatted into a `[CONTEXT]` block and appended to the user message. The system prompt is updated to tell Claude to use this context instead of MCP tools.

**Tech Stack:** `@slack/web-api` (already available via `@slack/bolt`), native `fetch` for Confluence REST API, existing Anthropic SDK.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/search/slack-search.js` | Fetch channel history, score by keyword relevance, return top threads |
| Create | `src/search/confluence-search.js` | Query Confluence REST API via CQL, return matching pages |
| Create | `src/search/index.js` | Run both searches in parallel, merge results |
| Modify | `src/claude/query.js` | Call search before Claude, inject context into prompt |
| Modify | `src/claude/prompts.js` | Remove MCP instructions, add pre-fetched context instructions |
| Modify | `.env.example` | Document `ATLASSIAN_EMAIL` |
| Modify | `test.js` | Add tests for search modules (mocked network calls) |

> **Note on `dm.js`:** `dm.js` delegates entirely to `handleQuery` in `mention.js` and does not import `query.js` directly. It requires no changes.
>
> **Note on streaming:** The original `queryWithMcp` had an `onToken` streaming callback. No caller in the codebase passes this argument, so it is intentionally removed in `queryWithContext`.
>
> **Note on `test.js` imports:** This project uses ESM (`"type": "module"`). All `import` statements must be at the top of `test.js` — not inline in test sections. Tasks 1, 2, and 3 include new imports that must be added to the existing import block at the top of `test.js` (lines 6–17), not in the test body.

---

## Task 1: Slack Channel Search

**Files:**
- Create: `src/search/slack-search.js`

### What this does
Fetches the last 200 messages from each configured Slack channel using the bot token and scores them by keyword overlap with the query. Returns the top 5 most relevant messages.

### Channels to search
- `#ask-integrations` — CAF8XRX6J
- `#ask-leads-integration` — C012EQ3RMSS
- `#200ok-specialists` — GCV2UN2MA
- `#integrations-ts-specialists` — C031LUD5X8A

- [ ] **Step 1: Create `src/search/slack-search.js`**

```js
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

const CHANNELS = [
  { id: 'CAF8XRX6J',    name: 'ask-integrations' },
  { id: 'C012EQ3RMSS',  name: 'ask-leads-integration' },
  { id: 'GCV2UN2MA',    name: '200ok-specialists' },
  { id: 'C031LUD5X8A',  name: 'integrations-ts-specialists' },
];

/**
 * Extracts keywords from a query string.
 * Filters stop words and short tokens.
 * @param {string} query
 * @returns {string[]}
 */
export function extractKeywords(query) {
  const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'for', 'and', 'or', 'not', 'with', 'that', 'this', 'has', 'have', 'had', 'they', 'their', 'our', 'your']);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/**
 * Scores a message by how many query keywords it contains.
 * @param {string} text
 * @param {string[]} keywords
 * @returns {number}
 */
export function scoreMessage(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

/**
 * Searches Slack channels for messages relevant to the query.
 * Fetches up to 200 recent messages per channel and scores by keyword match.
 *
 * @param {string} query - The agent's support query
 * @param {object} [options]
 * @param {number} [options.limit=200] - Messages to fetch per channel
 * @param {number} [options.topN=5] - How many top results to return
 * @returns {Promise<Array<{channel: string, text: string, score: number, ts: string}>>}
 */
export async function searchSlackChannels(query, { limit = 200, topN = 5 } = {}) {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const results = await Promise.allSettled(
    CHANNELS.map(async (ch) => {
      const res = await client.conversations.history({ channel: ch.id, limit });
      return (res.messages ?? [])
        .filter((m) => m.type === 'message' && !m.subtype && m.text?.trim())
        .map((m) => ({
          channel: ch.name,
          text: m.text.slice(0, 500),
          score: scoreMessage(m.text, keywords),
          ts: m.ts,
        }))
        .filter((m) => m.score > 0);
    }),
  );

  const all = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  return all
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
```

- [ ] **Step 2: Add Slack search tests to `test.js`**

Add `import { extractKeywords, scoreMessage } from './src/search/slack-search.js';` to the import block at the **top** of `test.js` (alongside existing imports on lines 6–17).

Then add this section before the summary block:

```js
// ── 8. Slack Search Utilities ─────────────────────────────────────────────────
console.log('\n🔹 Slack Search Utilities');

assert(extractKeywords('Zapier API access not working').includes('zapier'), 'Extracts "zapier"');
assert(extractKeywords('Zapier API access not working').includes('access'), 'Extracts "access"');
assert(!extractKeywords('Zapier API access not working').includes('not'), '"not" is filtered (stop word)');
assert(!extractKeywords('api').includes('api'), 'Short words (≤3 chars) filtered');

assert(scoreMessage('zapier api access issue on tenant', ['zapier', 'access']) === 2, 'Scores 2 keyword hits');
assert(scoreMessage('angi leads not syncing', ['zapier']) === 0, 'Scores 0 for no match');
assert(scoreMessage('ZAPIER Integration Setup', ['zapier']) === 1, 'Score is case-insensitive');
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all existing tests pass + new Slack search utility tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/search/slack-search.js test.js
git commit -m "feat: add Slack channel search module with keyword scoring"
```

---

## Task 2: Confluence Search

**Files:**
- Create: `src/search/confluence-search.js`
- Modify: `.env.example`

### What this does
Queries `https://servicetitan.atlassian.net/wiki/rest/api/content/search` with a CQL expression built from the query keywords. Returns up to 3 matching pages with title, excerpt, and URL.

- [ ] **Step 1: Add `ATLASSIAN_EMAIL` to `.env.example`**

In `.env.example`, add after the `ATLASSIAN_MCP_TOKEN` line:

```
# Your Atlassian account email — required for Confluence search (Basic auth = email:token)
ATLASSIAN_EMAIL=you@servicetitan.com
```

Also add `ATLASSIAN_EMAIL=kserobyan@servicetitan.com` to your local `.env`.

- [ ] **Step 2: Create `src/search/confluence-search.js`**

```js
const BASE_URL = 'https://servicetitan.atlassian.net/wiki/rest/api';

/**
 * Builds a Basic auth header from env vars.
 * Confluence REST API uses email:api_token base64-encoded.
 * @returns {string}
 */
function authHeader() {
  const email = process.env.ATLASSIAN_EMAIL ?? '';
  const token = process.env.ATLASSIAN_MCP_TOKEN ?? '';
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

/**
 * Builds a CQL query string from keywords.
 * Searches page title and body text.
 * @param {string[]} keywords
 * @returns {string}
 */
export function buildCql(keywords) {
  if (keywords.length === 0) return 'type=page';
  const terms = keywords.map((kw) => `text ~ "${kw}"`).join(' AND ');
  return `type=page AND (${terms})`;
}

/**
 * Searches Confluence for pages relevant to the query.
 *
 * @param {string[]} keywords - Pre-extracted keywords from the query
 * @param {object} [options]
 * @param {number} [options.limit=3] - Max pages to return
 * @returns {Promise<Array<{title: string, excerpt: string, url: string}>>}
 */
export async function searchConfluence(keywords, { limit = 3 } = {}) {
  if (!process.env.ATLASSIAN_MCP_TOKEN || !process.env.ATLASSIAN_EMAIL) return [];
  if (keywords.length === 0) return [];

  const cql = buildCql(keywords);
  const url = `${BASE_URL}/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=excerpt`;

  const res = await fetch(url, {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Confluence search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.results ?? []).map((page) => ({
    title: page.title,
    excerpt: (page.excerpt ?? '').replace(/<[^>]+>/g, '').slice(0, 300),
    url: `https://servicetitan.atlassian.net/wiki${page._links?.webui ?? ''}`,
  }));
}
```

- [ ] **Step 3: Add Confluence tests to `test.js`**

Add `import { buildCql } from './src/search/confluence-search.js';` to the import block at the **top** of `test.js`.

Then add this section before the summary block:

```js
// ── 9. Confluence Search Utilities ───────────────────────────────────────────
console.log('\n🔹 Confluence Search Utilities');

assert(buildCql([]).includes('type=page'), 'Empty keywords returns safe default CQL');
assert(buildCql(['zapier', 'access']).includes('text ~ "zapier"'), 'CQL includes first keyword');
assert(buildCql(['zapier', 'access']).includes('text ~ "access"'), 'CQL includes second keyword');
assert(buildCql(['zapier', 'access']).includes('AND'), 'CQL joins multiple keywords with AND');
assert(buildCql(['zapier']).includes('text ~ "zapier"'), 'Single keyword CQL is valid');
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/search/confluence-search.js .env.example test.js
git commit -m "feat: add Confluence REST API search module"
```

---

## Task 3: Search Orchestrator

**Files:**
- Create: `src/search/index.js`

### What this does
Runs Slack and Confluence searches in parallel. Formats results into a clean `[CONTEXT]` block string for injection into the Claude prompt. Silently skips any search that fails.

- [ ] **Step 1: Create `src/search/index.js`**

```js
import { extractKeywords, searchSlackChannels } from './slack-search.js';
import { searchConfluence } from './confluence-search.js';

/**
 * Formats search results into a context block for Claude.
 * @param {object} params
 * @param {Array} params.slackResults
 * @param {Array} params.confluenceResults
 * @returns {string} Formatted context string, or empty string if no results
 */
export function formatContext({ slackResults, confluenceResults }) {
  const parts = [];

  if (slackResults.length > 0) {
    parts.push('## Relevant Slack threads found:');
    slackResults.forEach((r) => {
      parts.push(`- [#${r.channel}] ${r.text}`);
    });
  }

  if (confluenceResults.length > 0) {
    parts.push('\n## Relevant Confluence pages found:');
    confluenceResults.forEach((p) => {
      parts.push(`- **${p.title}**: ${p.excerpt} (${p.url})`);
    });
  }

  return parts.length > 0 ? `\n\n[CONTEXT]\n${parts.join('\n')}\n[/CONTEXT]` : '';
}

/**
 * Runs Slack and Confluence searches in parallel for a given query.
 * Fails gracefully — a failed search returns empty results, not an error.
 *
 * @param {string} query
 * @returns {Promise<string>} Formatted context block (empty string if nothing found)
 */
export async function gatherContext(query) {
  const keywords = extractKeywords(query);

  const [slackResult, confluenceResult] = await Promise.allSettled([
    searchSlackChannels(query),
    searchConfluence(keywords),
  ]);

  const slackResults = slackResult.status === 'fulfilled' ? slackResult.value : [];
  const confluenceResults = confluenceResult.status === 'fulfilled' ? confluenceResult.value : [];

  if (slackResult.status === 'rejected') {
    console.warn('[search] Slack search failed:', slackResult.reason?.message);
  }
  if (confluenceResult.status === 'rejected') {
    console.warn('[search] Confluence search failed:', confluenceResult.reason?.message);
  }

  return formatContext({ slackResults, confluenceResults });
}
```

- [ ] **Step 2: Add orchestrator tests to `test.js`**

Add `import { formatContext } from './src/search/index.js';` to the import block at the **top** of `test.js`.

Then add this section before the summary block:

```js
// ── 10. Search Orchestrator ───────────────────────────────────────────────────
console.log('\n🔹 Search Orchestrator');

const noResults = formatContext({ slackResults: [], confluenceResults: [] });
assert(noResults === '', 'Empty results returns empty string');

const withSlack = formatContext({
  slackResults: [{ channel: 'ask-integrations', text: 'Zapier fix here', score: 2, ts: '123' }],
  confluenceResults: [],
});
assert(withSlack.includes('[CONTEXT]'), 'Context block present when results exist');
assert(withSlack.includes('ask-integrations'), 'Slack channel name in context');

const withBoth = formatContext({
  slackResults: [{ channel: 'ask-integrations', text: 'Zapier fix', score: 1, ts: '1' }],
  confluenceResults: [{ title: 'Zapier Setup Guide', excerpt: 'How to set up Zapier', url: 'https://servicetitan.atlassian.net/wiki/zapier' }],
});
assert(withBoth.includes('Confluence'), 'Confluence section present');
assert(withBoth.includes('Zapier Setup Guide'), 'Confluence page title in context');
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/search/index.js test.js
git commit -m "feat: add search orchestrator with parallel Slack + Confluence search"
```

---

## Task 4: Wire Search into Claude Query

**Files:**
- Modify: `src/claude/query.js`

### What this does
Calls `gatherContext()` before every Claude API call. Appends the context block to the user message. Removes dead MCP code.

- [ ] **Step 1: Update `src/claude/query.js`**

Replace the entire file with:

```js
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';
import { gatherContext } from '../search/index.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Reduce timeout — no MCP round-trips anymore
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '45000', 10) || 45000;

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

/**
 * Searches Slack + Confluence, then calls Claude with grounded context.
 * Aborts automatically after TIMEOUT_MS (default 45s).
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithContext(userQuery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Gather real context before calling Claude
  let contextBlock = '';
  try {
    contextBlock = await gatherContext(userQuery);
  } catch (err) {
    console.warn('[query] Context gathering failed — proceeding without context:', err.message);
  }

  const userContent = `Issue: ${userQuery}${contextBlock}`;

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  };

  let fullText = '';

  try {
    const response = await anthropic.messages.create(requestParams, { signal: controller.signal });
    fullText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return parseClaudeResponse(fullText);
}
```

- [ ] **Step 2: Update `src/handlers/mention.js` — rename the function call**

In `mention.js`, find:
```js
result = await queryWithMcp(query + feedbackContext);
```

Replace with:
```js
result = await queryWithContext(query + feedbackContext);
```

Also update the import at the top:
```js
// Before:
import { queryWithMcp } from '../claude/query.js';
// After:
import { queryWithContext } from '../claude/query.js';
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/claude/query.js src/handlers/mention.js
git commit -m "feat: wire bot-side search context into Claude query"
```

---

## Task 5: Update System Prompt

**Files:**
- Modify: `src/claude/prompts.js`

### What this does
Removes the MCP search instructions. Tells Claude to use the `[CONTEXT]` block when present, and to rely on built-in knowledge when it's absent.

- [ ] **Step 1: Replace STEP 1 in the system prompt**

In `src/claude/prompts.js`, replace the STEP 1 block (lines 5–18) with:

```
STEP 1 — Use the pre-fetched context provided in the [CONTEXT] block below the issue (if present).

The context contains:
- Relevant Slack threads from #ask-integrations, #ask-leads-integration, #200ok-specialists, and #integrations-ts-specialists — real past resolutions from your team
- Relevant Confluence pages from the ServiceTitan wiki — setup guides and troubleshooting runbooks

If a [CONTEXT] block is present, use it to ground your answer. Reference specific threads and pages in slack_refs and atlassian_refs.
If no [CONTEXT] block is present, rely on the Common integration knowledge below and your training data.
Do NOT invent Slack threads, Confluence pages, or Jira tickets that were not provided to you.
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Start the bot and do a live test**

```bash
npm run dev
```

Send a DM to the bot in Slack: `Customer's Zapier integration isn't working — they say API access was never enabled.`

Expected: bot replies with a structured troubleshooting response grounded in real Slack/Confluence data (or clear built-in knowledge if no matches found). No hallucinated references.

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts.js
git commit -m "fix: update system prompt to use pre-fetched context instead of MCP"
```

---

## Done

All 5 tasks complete. The bot now:
- Searches real Slack channel history before every Claude call
- Searches real Confluence pages before every Claude call
- Injects grounded context into the Claude prompt
- Falls back gracefully if either search fails
- No longer hallucinates references
