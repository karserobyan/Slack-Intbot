# MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bot-side keyword search layer (`src/search/`) with Anthropic MCP so Claude drives its own Confluence, Jira, and Slack searches.

**Architecture:** `queryWithContext` in `query.js` switches from `gatherContext()` + prompt injection to `anthropic.beta.messages.create` with `mcp_servers` config. Anthropic's infrastructure handles MCP round-trips. The `src/search/` folder is deleted. `queryChat` and all other modules are unchanged.

**Tech Stack:** `@anthropic-ai/sdk` v0.39.0 (MCP confirmed working), Atlassian MCP (`mcp.atlassian.com`), Slack MCP (`mcp.slack.com`), existing `dotenv`.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/claude/query.js` | Switch to MCP API call, remove gatherContext, bump timeout |
| Modify | `src/claude/prompts.js` | Rewrite SYSTEM_PROMPT for MCP tool usage |
| Modify | `src/slack/blocks.js` | Update thinking message text |
| Modify | `src/handlers/mention.js` | Update thinking placeholder fallback text |
| Modify | `test.js` | Remove search imports/tests, update thinking assertion |
| Delete | `src/search/slack-search.js` | No longer needed |
| Delete | `src/search/confluence-search.js` | No longer needed |
| Delete | `src/search/index.js` | No longer needed |

---

## Task 1: Update `test.js` — remove search tests

**Files:**
- Modify: `test.js`

- [ ] **Step 1: Remove the three search module imports from the top of `test.js`**

Remove lines 18–20:
```js
import { extractKeywords, scoreMessage } from './src/search/slack-search.js';
import { buildCql } from './src/search/confluence-search.js';
import { formatContext } from './src/search/index.js';
```

- [ ] **Step 2: Remove sections 8, 9, and 10 from `test.js`**

Remove the entire blocks for:
- `// ── 8. Slack Search Utilities` (lines ~244–254)
- `// ── 9. Confluence Search Utilities` (lines ~256–263)
- `// ── 10. Search Orchestrator` (lines ~265–283)

Note: the thinking assertion (`assert(thinkingBlocks[0].text.text.includes('Searching'), ...)`) stays unchanged here — it will be updated in Task 5 as part of the TDD cycle for that change.

- [ ] **Step 3: Run tests — confirm they PASS**

```bash
npm test
```

Expected: PASS — `test.js` no longer imports from search modules; the search files still exist on disk so nothing is broken. Section count drops by 3.

- [ ] **Step 4: Commit**

```bash
git add test.js
git commit -m "test: remove search module tests (search layer replaced by MCP in upcoming tasks)"
```

---

## Task 2: Delete `src/search/` folder

**Files:**
- Delete: `src/search/slack-search.js`
- Delete: `src/search/confluence-search.js`
- Delete: `src/search/index.js`

- [ ] **Step 1: Delete all three search files**

```bash
rm src/search/slack-search.js src/search/confluence-search.js src/search/index.js
rmdir src/search
```

- [ ] **Step 2: Run tests — confirm they still PASS**

```bash
npm test
```

Expected: PASS — `test.js` no longer imports the deleted modules. `query.js` still imports from `../search/index.js` but `test.js` does not import `query.js`, so the test suite is unaffected.

- [ ] **Step 3: Commit the deletions**

```bash
git add -u src/search/
git commit -m "refactor: delete src/search/ — bot-side search layer replaced by MCP"
```

Note: `git add -u src/search/` stages deletions of previously-tracked files even though the directory no longer exists on disk. `git add src/search/` would fail because the path is gone.

---

## Task 3: Rewrite `SYSTEM_PROMPT` in `src/claude/prompts.js`

**Files:**
- Modify: `src/claude/prompts.js`

- [ ] **Step 1: Replace `SYSTEM_PROMPT` with the MCP-aware version**

Replace the entire `SYSTEM_PROMPT` export (from the opening backtick to the closing backtick) with:

```js
export const SYSTEM_PROMPT = `You are IntegrationsBot — an internal assistant for ServiceTitan integrations support agents.

Your job: given a customer issue or agent question, search all available knowledge sources and produce a structured response that helps agents resolve the issue quickly.

STEP 1 — Search before answering.

You have access to search tools:
- atlassian: Search Confluence pages and Jira tickets from the ServiceTitan knowledge base
- slack: Search past Slack threads from #ask-integrations, #ask-leads-integration, #200ok-specialists, and #integrations-ts-specialists

Always search before answering. Use the atlassian tool to find relevant Confluence pages and Jira tickets. Use the slack tool to find how similar issues were resolved by your team. Make multiple searches with different queries if needed to find the best results.

A [TEAM KNOWLEDGE] block may appear below the issue — this contains curated team knowledge maintained by the integrations team. Treat it as authoritative when present.

HARD RULE — DO NOT INVENT REFERENCES: Never fabricate Slack threads, Confluence pages, or Jira tickets. Only populate slack_refs and atlassian_refs with sources you actually found via your search tools. If searches returned nothing useful, return empty arrays for both fields.

HARD RULE — ADMIT UNCERTAINTY: If your searches return no relevant results and the issue is not covered in the Common integration knowledge below, do not invent troubleshooting steps. Include a single agent_step with tag "escalate" saying you could not find specific information and recommend checking #ask-integrations or escalating to a specialist. Set customer_email to null in this case.

HARD RULE — ACCOUNTING EXCLUSION:
If the question involves ANY of: QuickBooks, Sage Intacct, NetSuite, Xero, Viewpoint Vista, accounts payable, accounts receivable, GL accounts, accounting integrations, chart of accounts, journal entries — set "is_accounting_topic": true and do NOT provide troubleshooting steps. Instead provide only a redirect message.

STEP 2 — Generate structured output as JSON.

For NON-accounting topics:
{
  "issue_title": "short title max 8 words",
  "integration_type": "specific integration name e.g. Zapier, Angi, Reserve with Google",
  "is_accounting_topic": false,
  "agent_steps": [
    {
      "num": 1,
      "title": "Step title",
      "detail": "Specific instruction with exact menu paths, e.g. Settings > Integrations > Marketing Integrations > Angi.",
      "tag": "action | backend | verify | escalate"
    }
  ],
  "customer_email": {
    "subject": "Re: [Issue description] — ServiceTitan Integrations Support",
    "body": "Full professional email body. Use \\n for line breaks. Warm, helpful tone. Sign off as:\\n\\nBest regards,\\nServiceTitan Integrations Support Team",
    "kb_links": [
      { "label": "Human-readable link description", "url": "https://help.servicetitan.com/..." }
    ]
  },
  "slack_refs": [
    {
      "channel": "channel-name without #",
      "author": "agent name if available",
      "issue_summary": "one-line summary of the similar issue found",
      "resolution": "how it was resolved",
      "was_resolved": true
    }
  ],
  "atlassian_refs": [
    {
      "type": "confluence | jira",
      "title": "page or ticket title",
      "summary": "brief summary of what this source contains",
      "url": "full URL",
      "status": "jira status if applicable",
      "assignee": "jira assignee if applicable"
    }
  ],
  "sources_used": ["slack", "confluence", "jira", "kb"]
}

For ACCOUNTING topics:
{
  "issue_title": "Accounting Integration Question",
  "integration_type": "accounting",
  "is_accounting_topic": true,
  "agent_steps": [],
  "customer_email": null,
  "slack_refs": [],
  "atlassian_refs": [],
  "sources_used": []
}

Tag guide for agent_steps:
- "action" — agent checks or configures something in the UI
- "backend" — requires admin/API action on the ServiceTitan backend
- "verify" — confirm the fix worked
- "escalate" — when to escalate and to whom

Common integration knowledge (use only when search returns nothing relevant):
- Zapier: Agent must enable Zapier API access on ST backend for the tenant. Customer self-serves the rest. KB: help.servicetitan.com/how-to/zapier
- Angi/Angi Leads: Check booking provider IDs, job type mapping under Settings > Integrations > Marketing Integrations > Angi. Often breaks after tenant migration.
- Reserve with Google (RwG): Check Actions Center, verify account matching status. Manual match may be needed by the RwG team. Multiple location setups need individual matching.
- ServiceChannel: Check attachment settings, verify API credentials for photo sync issues.
- Thumbtack: For redirect loop on account pairing — clear cache/cookies, try incognito, check if already connected.
- Procore: Check cost code mappings for job cost export failures.
- Chat-to-Text widget: Verify embed code placement, check SMS number setup, confirm widget is enabled in settings.

Reply ONLY with valid JSON. No markdown fences. No explanation text outside the JSON.`;
```

- [ ] **Step 2: Run tests — verify all tests still pass**

```bash
npm test
```

Expected: PASS — `parseClaudeResponse` tests work fine, and `test.js` doesn't import `query.js`, so the broken `query.js` import (`../search/index.js` now deleted) doesn't surface here.

- [ ] **Step 3: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: rewrite SYSTEM_PROMPT for MCP tool-driven search"
```

---

## Task 4: Rewrite `queryWithContext` in `src/claude/query.js`

**Files:**
- Modify: `src/claude/query.js`

- [ ] **Step 1: Replace the entire file with the MCP version**

```js
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, parseClaudeResponse } from './prompts.js';
import { getKnowledge } from '../slack/knowledge.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS ?? '90000', 10) || 90000;

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514';

/**
 * Builds the MCP servers array based on available tokens.
 * Slack MCP is omitted if SLACK_USER_TOKEN is missing or still a placeholder.
 *
 * @returns {Array} Array of MCP server config objects
 */
function buildMcpServers() {
  const servers = [];

  if (process.env.ATLASSIAN_MCP_TOKEN) {
    servers.push({
      type: 'url',
      url: 'https://mcp.atlassian.com/v1/sse',
      name: 'atlassian',
      authorization_token: process.env.ATLASSIAN_MCP_TOKEN,
    });
  }

  const slackToken = process.env.SLACK_USER_TOKEN;
  if (slackToken && slackToken !== 'xoxp-replace-me') {
    servers.push({
      type: 'url',
      url: 'https://mcp.slack.com/mcp',
      name: 'slack',
      authorization_token: slackToken,
    });
  }

  return servers;
}

/**
 * Calls Claude with MCP tools for Atlassian and Slack search.
 * Claude drives its own searches — no pre-fetching on our side.
 * Aborts automatically after TIMEOUT_MS.
 *
 * @param {string} userQuery - The agent's question or customer issue
 * @returns {Promise<object>} Parsed structured response
 */
export async function queryWithContext(userQuery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Inject team knowledge base if available
  let knowledgeBlock = '';
  try {
    const knowledge = await getKnowledge();
    if (knowledge) knowledgeBlock = `\n\n[TEAM KNOWLEDGE]\n${knowledge}\n[/TEAM KNOWLEDGE]`;
  } catch {
    // non-critical — proceed without it
  }

  const userContent = `Issue: ${userQuery}${knowledgeBlock}`;
  const mcpServers = buildMcpServers();

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
    betas: ['mcp-client-2025-04-04'],
  };

  let fullText = '';

  try {
    const response = await anthropic.beta.messages.create(requestParams, { signal: controller.signal });
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

/**
 * Conversational follow-up query — uses thread history, returns plain text.
 * Does NOT use MCP — relies on conversation history for context.
 * Aborts automatically after TIMEOUT_MS.
 *
 * @param {string} userQuery - The agent's follow-up message
 * @param {Array<{role: string, content: string}>} history - Prior messages in the thread
 * @returns {Promise<string>} Plain text response
 */
export async function queryChat(userQuery, history) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const messages = [...history, { role: 'user', content: userQuery }];

  const requestParams = {
    model: MODEL,
    max_tokens: 2048,
    system: CHAT_SYSTEM_PROMPT,
    messages,
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

  return fullText;
}
```

- [ ] **Step 2: Run tests — confirm they PASS**

```bash
npm test
```

Expected: All remaining tests pass. Search tests are gone. `query.js` no longer imports from deleted search modules. No import errors. The thinking assertion still checks for 'Searching' (unchanged) and still passes because `blocks.js` still says 'Searching' — that pair is updated together in Task 5.

- [ ] **Step 3: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: switch queryWithContext to Anthropic MCP — Atlassian + Slack search"
```

---

## Task 5: Update thinking message in `blocks.js` and `mention.js`

**Files:**
- Modify: `test.js`
- Modify: `src/slack/blocks.js` (line ~215)
- Modify: `src/handlers/mention.js` (line ~137)

- [ ] **Step 1: Update the thinking assertion in `test.js` (TDD red)**

Find (in section 3, Block Kit Builders):
```js
assert(thinkingBlocks[0].text.text.includes('Searching'), 'Thinking shows searching message');
```

Replace with:
```js
assert(thinkingBlocks[0].text.text.includes('Checking'), 'Thinking shows checking message');
```

- [ ] **Step 2: Run tests — confirm this one test FAILS**

```bash
npm test
```

Expected: One failure — `Thinking shows checking message` — because `blocks.js` still says 'Searching'. All other tests pass. This is the TDD red state.

- [ ] **Step 3: Update `buildThinkingBlocks` in `src/slack/blocks.js`**

Find:
```js
text: `*🔍 Searching knowledge sources…*\n\nLooking into: _"${query.slice(0, 120)}${query.length > 120 ? '…' : ''}"_\n\nSearching Slack channels, Confluence, Jira, and KB simultaneously — this usually takes 10–20 seconds.`,
```

Replace with:
```js
text: `*🔍 Checking knowledge sources…*\n\nLooking into: _"${query.slice(0, 120)}${query.length > 120 ? '…' : ''}"_\n\nChecking Confluence, Jira, and past Slack threads — this usually takes 20–40 seconds.`,
```

- [ ] **Step 4: Update the fallback text in `src/handlers/mention.js`**

Find:
```js
text: 'Searching knowledge sources…',
```

Replace with:
```js
text: 'Checking Confluence, Jira, and past Slack threads…',
```

- [ ] **Step 5: Run tests — confirm all pass**

```bash
npm test
```

Expected: All tests pass including the updated thinking assertion.

- [ ] **Step 6: Commit**

```bash
git add test.js src/slack/blocks.js src/handlers/mention.js
git commit -m "feat: update thinking message to reflect MCP search sources"
```

---

## Task 6: Live test

- [ ] **Step 1: Start the bot**

```bash
npm run dev
```

- [ ] **Step 2: Send a test query**

DM or mention the bot: `Customer's Zapier integration isn't working — they say API access was never enabled.`

Expected: Bot responds with troubleshooting steps. `atlassian_refs` should contain real Confluence or Jira results if Atlassian MCP is working. Response takes 20–40 seconds.

- [ ] **Step 3: Check logs for MCP activity**

In the terminal running `npm run dev`, look for Claude making tool calls (will appear in debug output if `LOG_LEVEL=debug`).

- [ ] **Step 4: Verify Slack MCP (once SLACK_USER_TOKEN is set)**

After `SLACK_USER_TOKEN` is updated in `.env` with a real `xoxp-` token, restart the bot and retest. `slack_refs` should now contain real past thread results.
