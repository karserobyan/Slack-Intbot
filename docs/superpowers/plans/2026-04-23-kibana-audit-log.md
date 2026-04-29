# Kibana Audit Log Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audit log querying to IntegrationsBot — routing buttons choose between integration help and log requests, a modal collects tenant details, Claude drives Elasticsearch MCP searches, and results render as a change timeline with analysis.

**Architecture:** New `buildRoutingButtons()` and `buildAuditBlocks()` in `blocks.js`, new `src/slack/modal.js` for the audit modal, `queryAuditLog()` + `AUDIT_LOG_PROMPT` + `parseAuditResponse()` in the Claude layer, action/view handlers wired in `index.js`, mention/dm handlers restructured to post buttons for new queries.

**Tech Stack:** Slack Block Kit, Slack Bolt `app.action()` / `app.view()`, Anthropic MCP beta (`mcp-client-2025-04-04`), Elasticsearch MCP server at `https://es-mcp.st.dev/mcp`

---

## Files touched

| File | What changes |
|---|---|
| `src/slack/blocks.js` | Add `buildRoutingButtons()`, `buildAuditBlocks()`, `CHANGE_CIRCLE` map |
| `src/slack/modal.js` | New — `buildAuditLogModal()` |
| `src/claude/prompts.js` | Add `AUDIT_LOG_PROMPT`, `parseAuditResponse()` |
| `src/claude/query.js` | Add `queryAuditLog()` |
| `src/handlers/mention.js` | Post routing buttons for new queries; follow-ups unchanged |
| `src/handlers/dm.js` | Same routing split as mention.js |
| `src/index.js` | Add `app.action('integration_question')`, `app.action('log_request')`, `app.view('audit_log_submission')` |
| `.env.example` | Add `ES_MCP_URL`, `ES_MCP_TOKEN` |
| `test.js` | Tests for all new block/prompt functions |

---

## Task 1: `buildRoutingButtons()` — blocks.js

**Files:**
- Modify: `src/slack/blocks.js` (append after existing exports)
- Modify: `test.js` (append before line 856 `// ── Summary ──`)

- [ ] **Step 1: Write failing tests**

Add before line 856 (`// ── Summary ──`) in `test.js`:

```js
// ── Routing Buttons ──────────────────────────────────────────────────────────
import { buildRoutingButtons } from './src/slack/blocks.js';

const routingCtx = { query: 'Zapier not working', channelId: 'C123', threadTs: '111.222', userId: 'U456' };
const routingBlocks = buildRoutingButtons(routingCtx);

assert(routingBlocks.length === 2, 'buildRoutingButtons returns 2 blocks');
assert(routingBlocks[0].type === 'section', 'routing block 0 is section');
assert(routingBlocks[1].type === 'actions', 'routing block 1 is actions');

const btns = routingBlocks[1].elements;
assert(btns.length === 2, 'routing actions has 2 buttons');
assert(btns[0].action_id === 'integration_question', 'first button action_id is integration_question');
assert(btns[1].action_id === 'log_request', 'second button action_id is log_request');

const btnValue = JSON.parse(btns[0].value);
assert(btnValue.query === 'Zapier not working', 'button value encodes query');
assert(btnValue.channelId === 'C123', 'button value encodes channelId');
assert(btnValue.threadTs === '111.222', 'button value encodes threadTs');
assert(btnValue.userId === 'U456', 'button value encodes userId');

const longQuery = 'x'.repeat(2000);
const longBlocks = buildRoutingButtons({ query: longQuery, channelId: 'C1', threadTs: '1', userId: 'U1' });
const longValue = JSON.parse(longBlocks[1].elements[0].value);
assert(longValue.query.length <= 1800, 'button value truncates long queries to 1800 chars');
```

- [ ] **Step 2: Run tests to verify they fail**

```
node test.js 2>&1 | grep -E "(routing|❌)" | head -10
```
Expected: failures for `buildRoutingButtons`

- [ ] **Step 3: Implement `buildRoutingButtons` in `src/slack/blocks.js`**

Append at the end of `src/slack/blocks.js`:

```js
export function buildRoutingButtons({ query, channelId, threadTs, userId }) {
  const value = JSON.stringify({
    query:     (query ?? '').slice(0, 1800),
    channelId,
    threadTs,
    userId,
  });
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*What kind of help do you need?*' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔌 Integration Question', emoji: true },
          action_id: 'integration_question',
          value,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📋 Log Request', emoji: true },
          action_id: 'log_request',
          value,
        },
      ],
    },
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node test.js 2>&1 | grep -E "(routing|❌|passed)"
```
Expected: all routing assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add buildRoutingButtons to blocks.js"
```

---

## Task 2: `buildAuditLogModal()` — new src/slack/modal.js

**Files:**
- Create: `src/slack/modal.js`
- Modify: `test.js`

- [ ] **Step 1: Write failing tests**

Add after the routing buttons tests in `test.js` (before `// ── Summary ──`):

```js
// ── Audit Log Modal ───────────────────────────────────────────────────────────
import { buildAuditLogModal } from './src/slack/modal.js';

const modal = buildAuditLogModal({ channelId: 'C123', threadTs: '111.222' });

assert(modal.type === 'modal', 'buildAuditLogModal returns modal type');
assert(modal.callback_id === 'audit_log_submission', 'modal callback_id is audit_log_submission');

const meta = JSON.parse(modal.private_metadata);
assert(meta.channelId === 'C123', 'modal private_metadata encodes channelId');
assert(meta.threadTs === '111.222', 'modal private_metadata encodes threadTs');

const tenantBlock = modal.blocks.find(b => b.block_id === 'tenant_block');
assert(tenantBlock !== undefined, 'modal has tenant_block');
assert(tenantBlock.element.action_id === 'tenant_input', 'tenant_block has tenant_input action');

const questionBlock = modal.blocks.find(b => b.block_id === 'question_block');
assert(questionBlock !== undefined, 'modal has question_block');
assert(questionBlock.optional === true, 'question_block is optional');

const timeBlock = modal.blocks.find(b => b.block_id === 'time_range_block');
assert(timeBlock !== undefined, 'modal has time_range_block');
assert(timeBlock.element.initial_option.value === '14', 'time_range default is 14 days');

const options = timeBlock.element.options.map(o => o.value);
assert(options.includes('7'), 'time_range has 7 day option');
assert(options.includes('30'), 'time_range has 30 day option');
assert(options.includes('90'), 'time_range has 90 day option');
```

- [ ] **Step 2: Run tests to verify they fail**

```
node test.js 2>&1 | grep -E "(modal|❌)" | head -10
```
Expected: failures for `buildAuditLogModal`

- [ ] **Step 3: Create `src/slack/modal.js`**

```js
export function buildAuditLogModal({ channelId, threadTs }) {
  return {
    type: 'modal',
    callback_id: 'audit_log_submission',
    title: { type: 'plain_text', text: '📋 Log Request', emoji: true },
    submit: { type: 'plain_text', text: 'Search logs', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    private_metadata: JSON.stringify({ channelId, threadTs }),
    blocks: [
      {
        type: 'input',
        block_id: 'tenant_block',
        label: { type: 'plain_text', text: 'Tenant name', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: 'tenant_input',
          placeholder: { type: 'plain_text', text: 'e.g. Acme Corp' },
        },
      },
      {
        type: 'input',
        block_id: 'question_block',
        optional: true,
        label: { type: 'plain_text', text: 'What are you looking for?', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: 'question_input',
          placeholder: { type: 'plain_text', text: 'e.g. Zapier stopped working yesterday' },
        },
      },
      {
        type: 'input',
        block_id: 'time_range_block',
        optional: true,
        label: { type: 'plain_text', text: 'Time range', emoji: true },
        element: {
          type: 'static_select',
          action_id: 'time_range_select',
          initial_option: { text: { type: 'plain_text', text: 'Last 14 days', emoji: true }, value: '14' },
          options: [
            { text: { type: 'plain_text', text: 'Last 7 days',  emoji: true }, value: '7'  },
            { text: { type: 'plain_text', text: 'Last 14 days', emoji: true }, value: '14' },
            { text: { type: 'plain_text', text: 'Last 30 days', emoji: true }, value: '30' },
            { text: { type: 'plain_text', text: 'Last 90 days', emoji: true }, value: '90' },
          ],
        },
      },
    ],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node test.js 2>&1 | grep -E "(modal|❌|passed)"
```
Expected: all modal assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/slack/modal.js test.js
git commit -m "feat: add buildAuditLogModal"
```

---

## Task 3: `AUDIT_LOG_PROMPT` + `parseAuditResponse()` — prompts.js

**Files:**
- Modify: `src/claude/prompts.js` (append at end of file)
- Modify: `test.js`

- [ ] **Step 1: Write failing tests**

Add after audit modal tests in `test.js`:

```js
// ── parseAuditResponse ────────────────────────────────────────────────────────
import { parseAuditResponse } from './src/claude/prompts.js';

const validJson = `{"tenant":"Acme","time_range_days":14,"likely_cause":"API disabled","summary":"One change found.","changes":[{"timestamp":"2026-04-19T09:11:00Z","user":"Sarah","source":"Admin","field":"zapier_api_enabled","old_value":"true","new_value":"false","change_type":"disable"}],"confidence":"high"}`;

const parsed = parseAuditResponse(validJson);
assert(parsed !== null, 'parseAuditResponse returns object for valid JSON');
assert(parsed.tenant === 'Acme', 'parseAuditResponse extracts tenant');
assert(parsed.changes.length === 1, 'parseAuditResponse extracts changes array');
assert(parsed.changes[0].change_type === 'disable', 'parseAuditResponse extracts change_type');

const wrapped = `Here is the result:\n\`\`\`json\n${validJson}\n\`\`\``;
const parsedWrapped = parseAuditResponse(wrapped);
assert(parsedWrapped !== null, 'parseAuditResponse handles JSON wrapped in code block');
assert(parsedWrapped.tenant === 'Acme', 'parseAuditResponse extracts tenant from wrapped JSON');

const noJson = parseAuditResponse('No results found.');
assert(noJson === null, 'parseAuditResponse returns null for non-JSON text');

const emptyChanges = parseAuditResponse('{"tenant":"X","time_range_days":14,"likely_cause":null,"summary":"None.","changes":[],"confidence":"high"}');
assert(emptyChanges !== null, 'parseAuditResponse handles empty changes array');
assert(emptyChanges.changes.length === 0, 'parseAuditResponse preserves empty changes array');
```

- [ ] **Step 2: Run tests to verify they fail**

```
node test.js 2>&1 | grep -E "(parseAudit|❌)" | head -10
```
Expected: failures for `parseAuditResponse`

- [ ] **Step 3: Add `AUDIT_LOG_PROMPT` and `parseAuditResponse` to `src/claude/prompts.js`**

Append at the end of `src/claude/prompts.js` (after line 446):

```js
export const AUDIT_LOG_PROMPT = `You are IntegrationsBot in audit log mode. Your job is to search Elasticsearch for change history for a specific ServiceTitan tenant and return a structured analysis.

You have access to an Elasticsearch MCP server with these tools:
- list_indices — list available indices (find the audit/change log index)
- get_mappings — get field mappings to learn exact field names before querying
- search — run an Elasticsearch query DSL search
- esql — run an ES|QL pipe-based query

STEP 1 — Discover the right index:
Use list_indices to find indices related to audit logs, change logs, or activity history. Look for names containing "audit", "change", "activity", or "event".

STEP 2 — Get the schema:
Use get_mappings on the audit index to find exact field names for: tenant identifier, timestamp, user/actor, changed field name, old value, new value, source/tool used, reason.

STEP 3 — Search for changes:
Query for documents matching the tenant name within the time range (use @timestamp or equivalent). Sort by timestamp descending. Limit to 20 results.

STEP 4 — Return ONLY this JSON, nothing else:

{
  "tenant": "<tenant name as provided>",
  "time_range_days": <number>,
  "likely_cause": "<one sentence: the single most likely cause of the reported issue, or null if no specific issue was described>",
  "summary": "<2–3 sentences: what changed, when, and what it means in context of the question>",
  "changes": [
    {
      "timestamp": "<ISO 8601>",
      "user": "<who made the change>",
      "source": "<tool or interface — e.g. Admin Panel, API, System>",
      "field": "<field or setting that changed>",
      "old_value": "<previous value — omit key if not available>",
      "new_value": "<new value>",
      "reason": "<reason if logged — omit key if not available>",
      "change_type": "disable | enable | modify"
    }
  ],
  "integration": "<integration name if identifiable — omit key if unknown>",
  "confidence": "high | medium | low"
}

change_type rules:
- "disable": turns something off, removes access, sets boolean to false, reduces to zero
- "enable": turns something on, grants access, sets boolean to true, increases from zero
- "modify": any other change

If no changes are found:
{"tenant":"<name>","time_range_days":<n>,"likely_cause":null,"summary":"No changes found for <tenant> in the last <n> days.","changes":[],"confidence":"high"}`;

export function parseAuditResponse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node test.js 2>&1 | grep -E "(parseAudit|❌|passed)"
```
Expected: all parseAuditResponse assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/claude/prompts.js test.js
git commit -m "feat: add AUDIT_LOG_PROMPT and parseAuditResponse"
```

---

## Task 4: `buildAuditBlocks()` — blocks.js

**Files:**
- Modify: `src/slack/blocks.js`
- Modify: `test.js`

- [ ] **Step 1: Write failing tests**

Add after parseAuditResponse tests in `test.js`:

```js
// ── buildAuditBlocks ──────────────────────────────────────────────────────────
import { buildAuditBlocks } from './src/slack/blocks.js';

const auditResult = {
  tenant: 'Acme Corp',
  time_range_days: 14,
  likely_cause: 'Zapier API was disabled',
  summary: 'One change found. API was disabled on Apr 19.',
  changes: [
    { timestamp: '2026-04-19T09:11:00Z', user: 'Sarah Lee', source: 'Admin Panel', field: 'zapier_api_enabled', old_value: 'true', new_value: 'false', change_type: 'disable' },
    { timestamp: '2026-04-20T14:32:00Z', user: 'John Smith', source: 'API', field: 'webhook_url', new_value: 'https://hooks.zapier.com/new', change_type: 'modify' },
  ],
  integration: 'Zapier',
  confidence: 'high',
};

const auditBlocks = buildAuditBlocks(auditResult);

const headerBlock = auditBlocks.find(b => b.type === 'header');
assert(headerBlock !== undefined, 'buildAuditBlocks has header block');
assert(headerBlock.text.text.includes('Acme Corp'), 'header includes tenant name');
assert(headerBlock.text.text.includes('Audit Log'), 'header includes Audit Log');

const likelyCauseBlock = auditBlocks.find(b => b.text?.text?.includes('Likely cause'));
assert(likelyCauseBlock !== undefined, 'buildAuditBlocks renders likely_cause block');
assert(likelyCauseBlock.text.text.includes('Zapier API was disabled'), 'likely_cause block contains cause text');

const changeBlocks = auditBlocks.filter(b => b.type === 'section' && b.text?.text?.includes('Sarah Lee'));
assert(changeBlocks.length === 1, 'buildAuditBlocks renders one block per change');
assert(changeBlocks[0].text.text.startsWith('🔴'), 'disable change starts with 🔴');

const modifyBlock = auditBlocks.find(b => b.text?.text?.includes('John Smith'));
assert(modifyBlock !== undefined, 'modify change renders');
assert(modifyBlock.text.text.startsWith('🟡'), 'modify change starts with 🟡');

const actionsBlock = auditBlocks.find(b => b.type === 'actions');
assert(actionsBlock !== undefined, 'buildAuditBlocks has actions block');
const wrongBtn = actionsBlock.elements.find(e => e.action_id === 'wrong_answer_modal');
assert(wrongBtn !== undefined, 'audit blocks has Wrong Answer button');
const kibanaBtn = actionsBlock.elements.find(e => e.action_id === 'view_in_kibana');
assert(kibanaBtn !== undefined, 'audit blocks has View in Kibana button');
assert(kibanaBtn.url === 'https://kibana.st.dev/app/discover', 'Kibana button links to discover page');

const divider = auditBlocks[auditBlocks.length - 1];
assert(divider.type === 'divider', 'buildAuditBlocks ends with divider');

// Empty changes
const emptyResult = { tenant: 'Beta', time_range_days: 7, likely_cause: null, summary: 'No changes found.', changes: [], confidence: 'high' };
const emptyBlocks = buildAuditBlocks(emptyResult);
const emptyChangeSections = emptyBlocks.filter(b => b.type === 'section' && b.text?.text?.includes('🔴'));
assert(emptyChangeSections.length === 0, 'buildAuditBlocks renders no change rows for empty changes');
```

- [ ] **Step 2: Run tests to verify they fail**

```
node test.js 2>&1 | grep -E "(buildAudit|❌)" | head -15
```
Expected: failures for `buildAuditBlocks`

- [ ] **Step 3: Add `CHANGE_CIRCLE` and `buildAuditBlocks` to `src/slack/blocks.js`**

Append after `buildRoutingButtons` at the end of `src/slack/blocks.js`:

```js
const CHANGE_CIRCLE = {
  disable: '🔴',
  enable:  '🟢',
  modify:  '🟡',
};

export function buildAuditBlocks(data) {
  const blocks = [];
  const conf = CONFIDENCE_META[data.confidence] ?? CONFIDENCE_META.medium;
  const changes = data.changes ?? [];

  // 1. Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📋 ${data.tenant} — Audit Log`, emoji: true },
  });

  // 2. Context — N changes · date range · integration
  const integrationPart = data.integration ? ` · Integration: ${data.integration}` : '';
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${changes.length} changes · Last ${data.time_range_days} days${integrationPart}` }],
  });

  // 3. Likely cause
  if (data.likely_cause) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `⚠️ *Likely cause:* ${data.likely_cause}` },
    });
  }

  // 4. Change rows
  for (const change of changes) {
    const circle = CHANGE_CIRCLE[change.change_type] ?? '🟡';
    const ts = change.timestamp
      ? new Date(change.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    const source = change.source ? ` · via ${change.source}` : '';
    const oldNew = change.old_value && change.new_value
      ? `\`${change.field}\`  _${change.old_value}_ → *${change.new_value}*`
      : `\`${change.field}\` → *${change.new_value ?? 'updated'}*`;
    const reason = change.reason ? `\n_${change.reason}_` : '';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${circle} *${ts}* · ${change.user}${source}\n${oldNew}${reason}` },
    });
  }

  // 5. Summary
  if (data.summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: data.summary },
    });
  }

  // 6. Context footer
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${conf.icon} ${conf.label} confidence · Elasticsearch audit index` }],
  });

  // 7. Actions
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
        action_id: 'wrong_answer_modal',
        style: 'danger',
        value: JSON.stringify({
          query: `Audit log: ${data.tenant}`,
          issueTitle: `Audit log for ${data.tenant}`,
          integrationType: data.integration ?? '',
        }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔎 View in Kibana', emoji: true },
        action_id: 'view_in_kibana',
        url: 'https://kibana.st.dev/app/discover',
      },
    ],
  });

  blocks.push({ type: 'divider' });

  return blocks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node test.js 2>&1 | grep -E "(buildAudit|❌|passed)"
```
Expected: all buildAuditBlocks assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add buildAuditBlocks and CHANGE_CIRCLE to blocks.js"
```

---

## Task 5: `queryAuditLog()` — query.js

**Files:**
- Modify: `src/claude/query.js`

No unit tests — this function calls the live Anthropic API. It is integration-tested manually by running the bot. The error path (missing `ES_MCP_URL`) is tested implicitly via the view handler in Task 7.

- [ ] **Step 1: Add `queryAuditLog` to `src/claude/query.js`**

Add the import for `AUDIT_LOG_PROMPT` and `parseAuditResponse` at the top of `src/claude/query.js`:

```js
import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT_CSA, SYSTEM_PROMPT_SPECIALIST, parseClaudeResponse, AUDIT_LOG_PROMPT, parseAuditResponse } from './prompts.js';
```

Then append at the end of `src/claude/query.js`:

```js
/**
 * Queries Claude with Elasticsearch MCP to fetch and analyze audit logs for a tenant.
 * Claude drives its own ES searches — discovers the index, inspects mappings, then queries.
 *
 * @param {{ tenantName: string, question: string, timeRange: number }} params
 * @returns {Promise<object>} Parsed audit result
 */
export async function queryAuditLog({ tenantName, question, timeRange }) {
  if (!process.env.ES_MCP_URL) {
    throw new Error('Elasticsearch is not configured — ask your admin for ES_MCP_URL and ES_MCP_TOKEN.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const mcpServers = [{
    type: 'url',
    url: process.env.ES_MCP_URL,
    name: 'elasticsearch',
    ...(process.env.ES_MCP_TOKEN ? { authorization_token: process.env.ES_MCP_TOKEN } : {}),
  }];

  const userContent = `Tenant: ${tenantName}\nTime range: ${timeRange} days\nQuestion: ${question || 'Show recent changes'}`;

  const requestParams = {
    model: MODEL,
    max_tokens: 4096,
    system: AUDIT_LOG_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    mcp_servers: mcpServers,
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
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(TIMEOUT_MS / 1000)}s — try rephrasing or being more specific.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const result = parseAuditResponse(fullText);
  if (!result) throw new Error('Could not parse audit log response.');
  return result;
}
```

- [ ] **Step 2: Run tests to make sure nothing broke**

```
node test.js 2>&1 | grep -E "(❌|passed|failed)"
```
Expected: zero new failures

- [ ] **Step 3: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: add queryAuditLog to query.js"
```

---

## Task 6: Update mention.js + dm.js — routing buttons for new queries

**Files:**
- Modify: `src/handlers/mention.js`
- Modify: `src/handlers/dm.js`

- [ ] **Step 1: Update imports in `src/handlers/mention.js`**

Find line 5-13 (the blocks.js import):
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
} from '../slack/blocks.js';
```

Add `buildRoutingButtons` to the import:
```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildRoutingButtons,
} from '../slack/blocks.js';
```

- [ ] **Step 2: Update `registerMentionHandler` in `src/handlers/mention.js`**

Replace lines 455-483 (the entire `registerMentionHandler` function):

```js
export function registerMentionHandler(app) {
  const _inFlight = new Set();

  app.event('app_mention', async ({ event, client, logger }) => {
    if (_inFlight.has(event.ts)) {
      logger.warn(`[mention] Duplicate event ${event.ts} — skipping`);
      return;
    }
    _inFlight.add(event.ts);

    logger.info(`[mention] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);

    try {
      const threadTs = event.thread_ts ?? event.ts;

      if (!hasHistory(threadTs)) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          blocks: buildRoutingButtons({
            query:     event.text ?? '',
            channelId: event.channel,
            threadTs,
            userId:    event.user,
          }),
          text: 'What kind of help do you need?',
        });
      } else {
        await handleQuery({
          rawText:   event.text ?? '',
          channelId: event.channel,
          threadTs,
          client,
          userId:    event.user,
        });
      }
    } finally {
      setTimeout(() => _inFlight.delete(event.ts), 60_000);
    }
  });
}
```

- [ ] **Step 3: Update `registerDmHandler` in `src/handlers/dm.js`**

Add `buildRoutingButtons` to the import at the top of `src/handlers/dm.js`:
```js
import { handleQuery } from './mention.js';
import { buildRoutingButtons } from '../slack/blocks.js';
import { hasHistory } from '../slack/conversation.js';
```

Replace lines 10-39 (the entire `registerDmHandler` function):
```js
export function registerDmHandler(app) {
  const _inFlight = new Set();

  app.message(async ({ message, client, logger }) => {
    if (message.channel_type !== 'im') return;
    if (message.subtype === 'bot_message' || message.bot_id) return;

    if (_inFlight.has(message.ts)) {
      logger.warn(`[dm] Duplicate event ${message.ts} — skipping`);
      return;
    }
    _inFlight.add(message.ts);

    logger.info(`[dm] ${message.user}: ${message.text?.slice(0, 80)}`);

    try {
      const threadTs = message.thread_ts ?? message.ts;

      if (!hasHistory(threadTs)) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: threadTs,
          blocks: buildRoutingButtons({
            query:     message.text ?? '',
            channelId: message.channel,
            threadTs,
            userId:    message.user,
          }),
          text: 'What kind of help do you need?',
        });
      } else {
        await handleQuery({
          rawText:   message.text ?? '',
          channelId: message.channel,
          threadTs,
          client,
          userId:    message.user,
          isDm:      true,
        });
      }
    } finally {
      setTimeout(() => _inFlight.delete(message.ts), 60_000);
    }
  });
}
```

- [ ] **Step 4: Run tests to make sure nothing broke**

```
node test.js 2>&1 | grep -E "(❌|passed|failed)"
```
Expected: zero failures

- [ ] **Step 5: Commit**

```bash
git add src/handlers/mention.js src/handlers/dm.js
git commit -m "feat: post routing buttons for new queries in mention and dm handlers"
```

---

## Task 7: Action + view handlers — index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Update imports in `src/index.js`**

Replace line 5:
```js
import { buildFeedbackModal, buildResponseBlocks, buildSourcesModal } from './slack/blocks.js';
```
With:
```js
import { buildFeedbackModal, buildResponseBlocks, buildSourcesModal, buildThinkingBlocks, buildErrorBlocks, buildAuditBlocks } from './slack/blocks.js';
```

Add after line 8 (`import { queryWithContext } ...`):
```js
import { queryWithContext, queryAuditLog } from './claude/query.js';
import { buildAuditLogModal } from './slack/modal.js';
```

Replace line 8 (old import):
```js
import { queryWithContext } from './claude/query.js';
```
With:
```js
import { queryWithContext, queryAuditLog } from './claude/query.js';
```

And add on the next line:
```js
import { buildAuditLogModal } from './slack/modal.js';
```

Also add `handleQuery` import from mention.js — add after line 4:
```js
import { handleQuery } from './handlers/mention.js';
```

- [ ] **Step 2: Add `app.action('integration_question')` handler**

Add after line 41 (`registerDmHandler(app);`), before the `wrong_answer_modal` handler:

```js
// ── Routing: Integration Question button ─────────────────────────────────────
app.action('integration_question', async ({ ack, body, client, logger }) => {
  await ack();
  let context;
  try {
    context = JSON.parse(body.actions[0].value);
  } catch {
    logger.error('[routing] Failed to parse integration_question value');
    return;
  }
  await handleQuery({
    rawText:   context.query,
    channelId: context.channelId,
    threadTs:  context.threadTs,
    client,
    userId:    context.userId,
  });
});

// ── Routing: Log Request button — opens audit modal ───────────────────────────
app.action('log_request', async ({ ack, body, client, logger }) => {
  await ack();
  let context;
  try {
    context = JSON.parse(body.actions[0].value);
  } catch {
    logger.error('[routing] Failed to parse log_request value');
    return;
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildAuditLogModal({ channelId: context.channelId, threadTs: context.threadTs }),
  });
});
```

- [ ] **Step 3: Add `app.view('audit_log_submission')` handler**

Add immediately after the `log_request` action handler:

```js
// ── Audit log modal submission ────────────────────────────────────────────────
app.view('audit_log_submission', async ({ ack, body, view, client, logger }) => {
  await ack();

  let channelId, threadTs;
  try {
    ({ channelId, threadTs } = JSON.parse(view.private_metadata));
  } catch {
    logger.error('[audit] Failed to parse private_metadata');
    return;
  }

  const values      = view.state.values;
  const tenantName  = values.tenant_block.tenant_input.value ?? '';
  const question    = values.question_block.question_input.value ?? '';
  const timeRange   = parseInt(values.time_range_block.time_range_select.selected_option?.value ?? '14', 10);

  const thinkingMsg = await client.chat.postMessage({
    channel:   channelId,
    thread_ts: threadTs,
    blocks:    buildThinkingBlocks(`Audit logs for ${tenantName}`),
    text:      'Checking…',
  }).catch(() => null);

  const thinkingTs = thinkingMsg?.ts;

  try {
    const result = await queryAuditLog({ tenantName, question, timeRange });
    const blocks = buildAuditBlocks(result);
    const text   = `Audit log for ${tenantName}`;

    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text });
    }
  } catch (err) {
    logger.error('[audit] queryAuditLog failed:', err.message);
    const errText = (err.message.includes('not configured') || err.message.includes('timed out'))
      ? err.message
      : `Something went wrong fetching audit logs for ${tenantName}. Try again or check Kibana directly.`;

    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: buildErrorBlocks(tenantName), text: errText });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errText });
    }
  }
});
```

- [ ] **Step 4: Run tests to make sure nothing broke**

```
node test.js 2>&1 | grep -E "(❌|passed|failed)"
```
Expected: zero failures

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat: wire routing buttons and audit log modal submission in index.js"
```

---

## Task 8: Update `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add Kibana/Elasticsearch section to `.env.example`**

Append at the end of `.env.example`:

```bash

# ── Kibana / Elasticsearch (MCP) ─────────────────────────────────────────────
# MCP server URL for Elasticsearch (no Teleport required)
ES_MCP_URL=https://es-mcp.st.dev/mcp

# Bearer token / API key for the Elasticsearch MCP server
# Obtain from your ES admin or use your ST account token
ES_MCP_TOKEN=your-es-mcp-token-here
```

- [ ] **Step 2: Run tests one final time**

```
node test.js
```
Expected output ends with `X passed, 0 failed`

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add ES_MCP_URL and ES_MCP_TOKEN to .env.example"
```
