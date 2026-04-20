# Sources Button + Broadened Search Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 📎 Sources button that opens a modal grouped by source type, and guarantee every query searches Slack, Atlassian, and the ServiceTitan help KB — without adding response time.

**Architecture:** Google Custom Search runs in parallel with `getKnowledge()` before the Claude call (zero added latency). Claude's ref arrays are given explicit schemas so the modal can render reliably. The search strategy is updated to require one Slack + one Atlassian search per query before the stop-early rule applies.

**Tech Stack:** Node.js ESM, `@slack/bolt` v4, native `fetch` (Node 18+), Google Custom Search JSON API v1

---

## File Map

| File | Change |
|------|--------|
| `src/claude/kb-search.js` | **New** — `searchKnowledgeBase(query)` returns `{ text, refs }` or null |
| `src/claude/query.js` | Run KB search in parallel, inject `[KB RESULTS]`, attach `kb_refs` to result |
| `src/claude/prompts.js` | Lock ref schemas, add `kb_refs` field, update search strategy to mandatory 2-phase |
| `src/slack/blocks.js` | Add `buildSourcesModal()`, add Sources button to `buildResponseBlocks()` |
| `src/index.js` | Register `view_sources_modal` action handler, import `buildSourcesModal` |
| `test.js` | Update `sampleJson` schema, add tests for new functions |
| `.env.example` | Document `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_ID` |

---

## Task 1: Update ref schemas in prompts.js and sampleJson in test.js

**Files:**
- Modify: `src/claude/prompts.js`
- Modify: `test.js`

The current `slack_refs` and `atlassian_refs` have no defined shape — Claude returns inconsistent fields. Lock them down to what the modal needs, and add `kb_refs`. Also update `sampleJson` in test.js so all downstream tests use the correct shape.

- [ ] **Step 1: Update the `slack_refs`/`atlassian_refs`/`kb_refs` schema in `SYSTEM_PROMPT_CSA`**

In `src/claude/prompts.js`, find the CSA JSON schema block (the `"slack_refs": [...]` line inside the full structured JSON example):

```
  "slack_refs": [...],
  "atlassian_refs": [...],
  "sources_used": ["slack", "confluence", "jira", "kb"]
```

Replace with:

```
  "slack_refs": [
    { "url": "https://servicetitan.slack.com/archives/...", "channel": "#channel-name", "title": "Brief description of what this thread is about" }
  ],
  "atlassian_refs": [
    { "type": "confluence", "url": "https://...", "title": "Page title" },
    { "type": "jira", "url": "https://...", "title": "INT-1234 — ticket title" }
  ],
  "kb_refs": [
    { "url": "https://help.servicetitan.com/...", "title": "Article title", "snippet": "One-line excerpt from the article" }
  ],
  "sources_used": ["slack", "confluence", "jira", "kb"]
```

- [ ] **Step 2: Update the accounting topic shortcut in `SYSTEM_PROMPT_CSA`**

In `src/claude/prompts.js`, find the CSA accounting shortcut line:

```
For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "slack_refs": [], "atlassian_refs": [], "sources_used": [] }
```

Replace with:

```
For ACCOUNTING topics: { "issue_title": "Accounting Integration Question", "integration_type": "accounting", "is_accounting_topic": true, "agent_steps": [], "slack_refs": [], "atlassian_refs": [], "kb_refs": [], "sources_used": [] }
```

- [ ] **Step 3: Apply identical schema changes to `SYSTEM_PROMPT_SPECIALIST`**

Repeat Steps 1 and 2 for the Specialist prompt — it has the same `slack_refs`/`atlassian_refs` block and the same accounting shortcut line. The changes are identical.

- [ ] **Step 4: Update `sampleJson` in `test.js` to match the new schemas**

In `test.js`, find the `sampleJson` object (around line 61). Replace the `slack_refs` and `atlassian_refs` fields with:

```js
  slack_refs: [
    { url: 'https://servicetitan.slack.com/archives/C123/p456', channel: '#ask-integrations', title: 'Zapier API access not working after tenant migration' },
  ],
  atlassian_refs: [
    { type: 'confluence', url: 'https://company.atlassian.net/wiki/zapier', title: 'Zapier Integration Setup Guide' },
    { type: 'jira', url: 'https://company.atlassian.net/browse/INT-4821', title: 'INT-4821 — Zapier not connecting for tenant' },
  ],
  kb_refs: [
    { url: 'https://help.servicetitan.com/zapier-setup', title: 'Setting up Zapier with ServiceTitan', snippet: 'Enable API access in the ST admin portal before connecting Zapier.' },
  ],
```

- [ ] **Step 5: Run tests — all should still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: same pass count as before — no regressions. The schema changes in prompts.js are string edits; no logic changed.

- [ ] **Step 6: Commit**

```bash
git add src/claude/prompts.js test.js
git commit -m "refactor: lock down slack_refs/atlassian_refs schemas, add kb_refs field to both role prompts"
```

---

## Task 2: Add `buildSourcesModal` to `src/slack/blocks.js` (TDD)

**Files:**
- Modify: `test.js`
- Modify: `src/slack/blocks.js`

- [ ] **Step 1: Add `buildSourcesModal` to the import in `test.js`**

In `test.js`, find:

```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
} from './src/slack/blocks.js';
```

Replace with:

```js
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildSourcesModal,
} from './src/slack/blocks.js';
```

- [ ] **Step 2: Add failing tests for `buildSourcesModal` in `test.js`**

Add a new section after the `// ── 10. Help Blocks` section and before the `// ── Summary` block:

```js
// ── 11. Sources Modal ─────────────────────────────────────────────────────────
console.log('\n🔹 Sources Modal');

// Modal with all three source types
const fullRefsModal = buildSourcesModal({
  slack_refs: [
    { url: 'https://slack.com/1', channel: '#ask-integrations', title: 'Zapier API not working' },
  ],
  atlassian_refs: [
    { type: 'confluence', url: 'https://atlassian.net/wiki/1', title: 'Zapier Setup Guide' },
    { type: 'jira', url: 'https://atlassian.net/browse/INT-1', title: 'INT-1 — Zapier auth failure' },
  ],
  kb_refs: [
    { url: 'https://help.servicetitan.com/zapier', title: 'Zapier Setup', snippet: 'Enable API access first.' },
  ],
});
assert(fullRefsModal.type === 'modal', 'buildSourcesModal returns modal type');
assert(typeof fullRefsModal.title === 'object', 'modal has title');
assert(Array.isArray(fullRefsModal.blocks), 'modal has blocks array');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('💬 Slack')), 'modal has Slack section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('📄 Atlassian')), 'modal has Atlassian section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('📚 Knowledge Base')), 'modal has KB section');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('Zapier API not working')), 'slack ref title appears in modal');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('Zapier Setup Guide')), 'confluence ref title appears in modal');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('INT-1')), 'jira ref title appears in modal');
assert(fullRefsModal.blocks.some(b => b.text?.text?.includes('Zapier Setup')), 'kb ref title appears in modal');

// Modal with only Slack refs — Atlassian and KB sections should not appear
const slackOnlyModal = buildSourcesModal({
  slack_refs: [{ url: 'https://slack.com/2', channel: '#ks-integration', title: 'Thread about Angi' }],
  atlassian_refs: [],
  kb_refs: [],
});
assert(!slackOnlyModal.blocks.some(b => b.text?.text?.includes('📄 Atlassian')), 'Atlassian section hidden when no atlassian_refs');
assert(!slackOnlyModal.blocks.some(b => b.text?.text?.includes('📚 Knowledge Base')), 'KB section hidden when no kb_refs');

// Modal with no refs — shows fallback message
const emptyRefsModal = buildSourcesModal({ slack_refs: [], atlassian_refs: [], kb_refs: [] });
assert(emptyRefsModal.blocks.some(b => b.text?.text?.includes('No specific sources')), 'empty refs modal shows fallback message');

// Missing arrays default gracefully (no crash)
const noArgsModal = buildSourcesModal({});
assert(noArgsModal.type === 'modal', 'buildSourcesModal handles missing arrays without crash');
```

- [ ] **Step 3: Run tests — confirm new tests fail**

```bash
node test.js 2>&1 | grep -E "(Sources Modal|buildSourcesModal is not a function|❌)"
```

Expected: failures on all Sources Modal assertions (`buildSourcesModal is not a function`). All previously passing tests still green.

- [ ] **Step 4: Implement `buildSourcesModal` in `src/slack/blocks.js`**

Add before the final line of `src/slack/blocks.js`:

```js
/**
 * Builds the Sources modal shown when an agent clicks 📎 Sources.
 * Groups refs by type: Slack, Atlassian (Confluence + Jira), Knowledge Base.
 *
 * @param {object} data - { slack_refs, atlassian_refs, kb_refs }
 * @returns {object} Slack modal view payload
 */
export function buildSourcesModal({ slack_refs = [], atlassian_refs = [], kb_refs = [] } = {}) {
  const blocks = [];

  if (slack_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*💬 Slack (${slack_refs.length})*` },
    });
    for (const ref of slack_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• <${ref.url}|${ref.title}>\n  _${ref.channel}_` },
      });
    }
  }

  if (atlassian_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📄 Atlassian (${atlassian_refs.length})*` },
    });
    for (const ref of atlassian_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• <${ref.url}|${ref.title}>` },
      });
    }
  }

  if (kb_refs.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📚 Knowledge Base (${kb_refs.length})*` },
    });
    for (const ref of kb_refs) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `• <${ref.url}|${ref.title}>\n  _${ref.snippet}_` },
      });
    }
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: 'No specific sources were found for this answer.' },
    });
  }

  return {
    type: 'modal',
    callback_id: 'sources_view',
    title: { type: 'plain_text', text: '📎 Sources', emoji: true },
    close: { type: 'plain_text', text: 'Close', emoji: true },
    blocks,
  };
}
```

- [ ] **Step 5: Run tests — all should pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: all tests pass, count increases by the number of new assertions added.

- [ ] **Step 6: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add buildSourcesModal grouped by Slack / Atlassian / KB source type"
```

---

## Task 3: Add Sources button to `buildResponseBlocks` (TDD)

**Files:**
- Modify: `test.js`
- Modify: `src/slack/blocks.js`

- [ ] **Step 1: Add failing tests for the Sources button in `test.js`**

Add after the `// ── 11. Sources Modal` section (still before `// ── Summary`):

```js
// ── 12. Sources Button in buildResponseBlocks ─────────────────────────────────
console.log('\n🔹 Sources Button');

// Sources button appears when refs are present
const withRefsBlocks = buildResponseBlocks({
  ...sampleJson,
  slack_refs: [{ url: 'https://slack.com/1', channel: '#ask-integrations', title: 'Zapier thread' }],
  atlassian_refs: [],
  kb_refs: [],
});
const withRefsActions = withRefsBlocks.find(b => b.type === 'actions');
const sourcesBtn = withRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(sourcesBtn !== undefined, 'Sources button appears when refs present');
assert(sourcesBtn?.value?.length <= 2000, 'Sources button value within 2000 chars');

// Sources button hidden when all ref arrays are empty
const noRefsBlocks = buildResponseBlocks({
  ...sampleJson,
  slack_refs: [],
  atlassian_refs: [],
  kb_refs: [],
});
const noRefsActions = noRefsBlocks.find(b => b.type === 'actions');
const noSourcesBtn = noRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(noSourcesBtn === undefined, 'Sources button hidden when all ref arrays empty');

// Sources button hidden when ref fields are absent (legacy responses)
const legacyBlocks = buildResponseBlocks({ ...sampleJson });
// sampleJson has kb_refs from Task 1, so strip them for this test
const legacyNoRefsBlocks = buildResponseBlocks({
  issue_title: 'Test',
  agent_steps: [],
  confidence: 'high',
  sources_used: [],
});
const legacyActions = legacyNoRefsBlocks.find(b => b.type === 'actions');
const legacySourcesBtn = legacyActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(legacySourcesBtn === undefined, 'Sources button hidden when ref fields absent');

// Button value caps at 5 refs per type
const manyRefsBlocks = buildResponseBlocks({
  ...sampleJson,
  slack_refs: Array.from({ length: 10 }, (_, i) => ({ url: `https://slack.com/${i}`, channel: '#ch', title: `Thread ${i}` })),
  atlassian_refs: Array.from({ length: 10 }, (_, i) => ({ type: 'confluence', url: `https://atlassian.net/${i}`, title: `Page ${i}` })),
  kb_refs: Array.from({ length: 10 }, (_, i) => ({ url: `https://help.st.com/${i}`, title: `Article ${i}`, snippet: 'snippet' })),
});
const manyRefsActions = manyRefsBlocks.find(b => b.type === 'actions');
const manySourcesBtn = manyRefsActions?.elements?.find(e => e.action_id === 'view_sources_modal');
assert(manySourcesBtn !== undefined, 'Sources button present with many refs');
const parsedValue = JSON.parse(manySourcesBtn.value);
assert(parsedValue.slack_refs.length <= 5, 'slack_refs capped at 5 in button value');
assert(parsedValue.atlassian_refs.length <= 5, 'atlassian_refs capped at 5 in button value');
assert(parsedValue.kb_refs.length <= 5, 'kb_refs capped at 5 in button value');
assert(manySourcesBtn.value.length <= 2000, 'Capped button value within 2000 chars');
```

- [ ] **Step 2: Run tests — confirm new tests fail**

```bash
node test.js 2>&1 | grep -E "(Sources Button|❌)"
```

Expected: failures on the Sources button assertions. All previous tests still green.

- [ ] **Step 3: Update `buildResponseBlocks` in `src/slack/blocks.js`**

In `src/slack/blocks.js`, find the action elements block inside `buildResponseBlocks`:

```js
  const actionElements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
      action_id: 'wrong_answer_modal',
      style: 'danger',
      value: JSON.stringify({
        query: (data._originalQuery ?? '').slice(0, 400),
        issueTitle: (data.issue_title ?? '').slice(0, 100),
        integrationType: (data.integration_type ?? '').slice(0, 50),
      }),
    },
  ];
```

Replace with:

```js
  const actionElements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: '👎 Wrong Answer', emoji: true },
      action_id: 'wrong_answer_modal',
      style: 'danger',
      value: JSON.stringify({
        query: (data._originalQuery ?? '').slice(0, 400),
        issueTitle: (data.issue_title ?? '').slice(0, 100),
        integrationType: (data.integration_type ?? '').slice(0, 50),
      }),
    },
  ];

  const totalRefs = (data.slack_refs ?? []).length + (data.atlassian_refs ?? []).length + (data.kb_refs ?? []).length;
  if (totalRefs > 0) {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📎 Sources', emoji: true },
      action_id: 'view_sources_modal',
      value: JSON.stringify({
        slack_refs: (data.slack_refs ?? []).slice(0, 5),
        atlassian_refs: (data.atlassian_refs ?? []).slice(0, 5),
        kb_refs: (data.kb_refs ?? []).slice(0, 5),
      }),
    });
  }
```

- [ ] **Step 4: Run tests — all should pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/slack/blocks.js test.js
git commit -m "feat: add Sources button to response blocks, hidden when no refs"
```

---

## Task 4: Register `view_sources_modal` action handler in `src/index.js`

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add `buildSourcesModal` to the import in `src/index.js`**

In `src/index.js`, find:

```js
import { buildFeedbackModal, buildResponseBlocks } from './slack/blocks.js';
```

Replace with:

```js
import { buildFeedbackModal, buildResponseBlocks, buildSourcesModal } from './slack/blocks.js';
```

- [ ] **Step 2: Add the `view_sources_modal` action handler**

In `src/index.js`, find the existing `wrong_answer_modal` handler:

```js
// ── "Wrong Answer" button — opens feedback modal ─────────────────────────────
app.action('wrong_answer_modal', async ({ ack, body, client, action }) => {
```

Add the Sources handler **immediately before** it:

```js
// ── "Sources" button — opens sources modal ───────────────────────────────────
app.action('view_sources_modal', async ({ ack, body, client, action }) => {
  await ack();
  let refsData = { slack_refs: [], atlassian_refs: [], kb_refs: [] };
  try { refsData = JSON.parse(action.value); } catch { /* show empty modal on malformed value */ }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: buildSourcesModal(refsData),
  });
});

```

- [ ] **Step 3: Run tests — all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: same pass count as after Task 3. `src/index.js` changes are runtime-only and don't affect the test suite.

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: register view_sources_modal action handler"
```

---

## Task 5: Create `src/claude/kb-search.js` (TDD)

**Files:**
- Create: `src/claude/kb-search.js`
- Modify: `test.js`

- [ ] **Step 1: Add import and failing tests in `test.js`**

Add the import at the top of `test.js`, after the existing imports:

```js
import { searchKnowledgeBase } from './src/claude/kb-search.js';
```

Add a new test section after the `// ── 12. Sources Button` section (before `// ── Summary`):

```js
// ── 13. KB Search ────────────────────────────────────────────────────────────
console.log('\n🔹 KB Search');

// Returns null when env vars are missing (safe no-op)
const savedApiKey = process.env.GOOGLE_CSE_API_KEY;
const savedCseId = process.env.GOOGLE_CSE_ID;
delete process.env.GOOGLE_CSE_API_KEY;
delete process.env.GOOGLE_CSE_ID;
const nullResult = await searchKnowledgeBase('zapier api not working');
assert(nullResult === null, 'searchKnowledgeBase returns null when GOOGLE_CSE_API_KEY missing');

// Restore env vars (if they were set)
if (savedApiKey) process.env.GOOGLE_CSE_API_KEY = savedApiKey;
if (savedCseId) process.env.GOOGLE_CSE_ID = savedCseId;

// Returns null when only one env var is set
process.env.GOOGLE_CSE_API_KEY = 'test-key';
delete process.env.GOOGLE_CSE_ID;
const nullResult2 = await searchKnowledgeBase('zapier api not working');
assert(nullResult2 === null, 'searchKnowledgeBase returns null when GOOGLE_CSE_ID missing');

// Clean up
delete process.env.GOOGLE_CSE_API_KEY;
if (savedCseId) process.env.GOOGLE_CSE_ID = savedCseId;
```

- [ ] **Step 2: Run tests — confirm new tests fail**

```bash
node test.js 2>&1 | grep -E "(KB Search|searchKnowledgeBase|❌)"
```

Expected: failures on KB Search assertions (module not found). All previous tests still green.

- [ ] **Step 3: Create `src/claude/kb-search.js`**

```js
/**
 * Searches the ServiceTitan help KB using Google Custom Search API.
 *
 * Returns { text, refs } where:
 *   text — formatted string for injection into the Claude prompt as [KB RESULTS]
 *   refs — array of { url, title, snippet } for the Sources modal
 *
 * Returns null if env vars are missing, quota is exceeded, or the request fails.
 * Never throws — failures are silent degradation.
 */
export async function searchKnowledgeBase(query) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;

  if (!apiKey || !cseId) return null;

  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cseId)}&q=${encodeURIComponent(query)}&num=3`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[kb-search] Google CSE returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const items = data.items ?? [];
    if (items.length === 0) return null;

    const refs = items.map((item) => ({
      url: item.link,
      title: item.title,
      snippet: (item.snippet ?? '').replace(/\n/g, ' '),
    }));

    const text = refs
      .map((ref, i) => `${i + 1}. ${ref.title}\n   URL: ${ref.url}\n   ${ref.snippet}`)
      .join('\n\n');

    return { text, refs };
  } catch (err) {
    console.warn('[kb-search] Search failed:', err.message);
    return null;
  }
}
```

- [ ] **Step 4: Run tests — all should pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: all tests pass including the two new KB Search assertions.

- [ ] **Step 5: Commit**

```bash
git add src/claude/kb-search.js test.js
git commit -m "feat: add searchKnowledgeBase with Google Custom Search, graceful null on missing config"
```

---

## Task 6: Integrate KB search into `src/claude/query.js`

**Files:**
- Modify: `src/claude/query.js`

- [ ] **Step 1: Add `searchKnowledgeBase` import to `src/claude/query.js`**

In `src/claude/query.js`, find:

```js
import { getKnowledge } from '../slack/knowledge.js';
```

Replace with:

```js
import { getKnowledge } from '../slack/knowledge.js';
import { searchKnowledgeBase } from './kb-search.js';
```

- [ ] **Step 2: Run KB search in parallel with `getKnowledge()`**

In `src/claude/query.js`, inside `queryWithContext`, find:

```js
  // Inject team knowledge base if available
  let knowledgeBlock = '';
  try {
    const knowledge = await getKnowledge();
    if (knowledge) knowledgeBlock = `\n\n[TEAM KNOWLEDGE]\n${knowledge}\n[/TEAM KNOWLEDGE]`;
  } catch {
    // non-critical — proceed without it
  }

  const userContent = `Issue: ${userQuery}${knowledgeBlock}`;
```

Replace with:

```js
  // Run team knowledge and KB search in parallel — neither blocks the other
  const [knowledge, kbResult] = await Promise.all([
    getKnowledge().catch(() => null),
    searchKnowledgeBase(userQuery),
  ]);

  let userContent = `Issue: ${userQuery}`;
  if (knowledge) userContent += `\n\n[TEAM KNOWLEDGE]\n${knowledge}\n[/TEAM KNOWLEDGE]`;
  if (kbResult) userContent += `\n\n[KB RESULTS — ServiceTitan Help KB]\n${kbResult.text}\n[/KB RESULTS]`;
```

- [ ] **Step 3: Attach `kb_refs` to the parsed result**

In `src/claude/query.js`, inside `queryWithContext`, find:

```js
  return parseClaudeResponse(fullText);
```

Replace with:

```js
  const result = parseClaudeResponse(fullText);
  result.kb_refs = kbResult?.refs ?? [];
  return result;
```

- [ ] **Step 4: Run tests — all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: same pass count — `queryWithContext` is not exercised by the test suite directly, so no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/claude/query.js
git commit -m "feat: run Google KB search in parallel with team knowledge, inject results and attach kb_refs"
```

---

## Task 7: Update search strategy to mandatory 2-phase coverage in `src/claude/prompts.js`

**Files:**
- Modify: `src/claude/prompts.js`

Both `SYSTEM_PROMPT_CSA` and `SYSTEM_PROMPT_SPECIALIST` currently have a speed rule that lets Claude skip Search 2 if Search 1 returns a confident result. This means Atlassian or Slack can be silently skipped. Replace with a mandatory 2-phase strategy.

- [ ] **Step 1: Update the search strategy in `SYSTEM_PROMPT_CSA`**

In `src/claude/prompts.js`, inside `SYSTEM_PROMPT_CSA`, find the entire search strategy block — from `Search 1 — Integration anchor:` through `Speed rule: If Search 1 returns a confident, complete answer — skip Search 2. Two searches is the standard; three is the exception, not the default.`

Replace the full block with:

```
Search 1 — Slack: Search Slack for the exact integration or product name (e.g. "Zapier", "Angi Leads", "Reserve with Google"). Goal: find threads where agents have discussed this integration.

Search 2 — Atlassian: Search Confluence or Jira for the symptom, using the customer's own language — NOT technical terms. Think: how would the agent or customer describe this in writing? Use completely different keywords from Search 1. Goal: find docs or tickets about THIS specific problem.

MANDATORY RULE: Both Search 1 AND Search 2 must always run before you evaluate results or answer. Do not skip either, even if Search 1 looks promising. KB results are pre-injected above in [KB RESULTS] — no search needed for those.

Evaluate after Search 1 and Search 2: Do the combined results describe the same integration AND the same symptom? If yes — answer from those results. If results exist but cover a different issue or are only tangentially related, do NOT use them — proceed to Search 3.

Search 3 — Emergency pivot (only if Searches 1 and 2 returned nothing specifically matching):
- Try an alternate integration name or abbreviation (e.g. "RwG" for "Reserve with Google", "Angi Leads" vs "Angi")
- Search the error code or error message verbatim if the customer provided one
- Try the broader problem category (e.g. "leads integration" instead of "Carrier", "booking sync" instead of "Procore job cost")
- Switch tools: if Search 1 used Slack, try Confluence or Jira; if Search 2 used Atlassian, try a different Slack channel

If all three searches return nothing specifically matching this integration and symptom: escalate immediately — do not invent steps.

Speed rule: Search 3 is the exception, not the default. After Searches 1 and 2, if results are specific and sufficient — stop.
```

- [ ] **Step 2: Update the search strategy in `SYSTEM_PROMPT_SPECIALIST`**

Apply the same replacement to `SYSTEM_PROMPT_SPECIALIST`. The Specialist prompt has an abbreviated version of the same strategy — replace from `Search 1 — Integration anchor:` through `Speed rule: confident answer after Search 1 → skip Search 2. Two searches is the standard; three is the exception.` with:

```
Search 1 — Slack: Search Slack for the exact integration or product name. Goal: locate threads where specialists discussed this integration.

Search 2 — Atlassian: Search Confluence or Jira for the symptom in customer/agent language. Different keywords from Search 1. Evaluate: do combined results match THIS integration AND THIS symptom?

MANDATORY RULE: Both Search 1 and Search 2 must always run. Do not skip either. KB results are pre-injected in [KB RESULTS] — no search needed for those.

Evaluate after both: specific and sufficient results → answer. Otherwise proceed to Search 3.

Search 3 — Emergency pivot (only if 1 and 2 returned nothing specifically matching):
- Alternate name or abbreviation ("RwG", "QBO", "Angi Leads")
- Error code or message verbatim
- Broader problem category
- Switch tools (Slack ↔ Confluence/Jira)

If all three searches return nothing specific: escalate. Do not invent steps.

Speed rule: Search 3 is the exception. After Searches 1 and 2, if results are specific and sufficient — stop.
```

- [ ] **Step 3: Run tests — all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: same pass count — prompt text changes don't affect the test suite.

- [ ] **Step 4: Commit**

```bash
git add src/claude/prompts.js
git commit -m "feat: update search strategy to mandatory Slack + Atlassian coverage before stop-early rule"
```

---

## Task 8: Document new env vars in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add Google CSE variables to `.env.example`**

In `.env.example`, find the `# ── MCP Tokens` section:

```
# ── MCP Tokens ───────────────────────────────────────────────────────────────
```

Add a new section **immediately before** it:

```
# ── Google Custom Search (ServiceTitan KB) ───────────────────────────────────
# Used to search help.servicetitan.com for KB articles relevant to each query.
# Setup: https://developers.google.com/custom-search/v1/overview
#   1. Create a Google Cloud project and enable the Custom Search JSON API
#   2. Create a Custom Search Engine at https://programmablesearchengine.google.com/
#      — set "Search the entire web" OFF, add help.servicetitan.com as a site
#   3. Copy the Search Engine ID (cx) and an API key from your Cloud project
# Free tier: 100 queries/day. Without these vars the bot skips KB search silently.
GOOGLE_CSE_API_KEY=your-google-api-key-here
GOOGLE_CSE_ID=your-custom-search-engine-id-here

```

- [ ] **Step 2: Run tests — all still pass**

```bash
node test.js 2>&1 | tail -5
```

Expected: no change in pass count.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID to .env.example with setup instructions"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run the full test suite**

```bash
node test.js 2>&1
```

Expected: all tests pass, 0 failed.

- [ ] **Step 2: Verify Sources button only appears on responses with refs**

```bash
grep -n "view_sources_modal" src/slack/blocks.js src/index.js
```

Expected: exactly two matches — one in `buildResponseBlocks` (the button definition) and one in `src/index.js` (the action handler).

- [ ] **Step 3: Verify kb_refs is always set on queryWithContext results**

```bash
grep -n "kb_refs" src/claude/query.js
```

Expected: two matches — one where `kbResult?.refs` is assigned, one fallback `[]`.

- [ ] **Step 4: Verify both prompts have MANDATORY RULE**

```bash
grep -n "MANDATORY RULE" src/claude/prompts.js
```

Expected: exactly two matches — one in CSA prompt, one in Specialist prompt.

- [ ] **Step 5: Verify KB results block label**

```bash
grep -n "KB RESULTS" src/claude/query.js src/claude/prompts.js
```

Expected: one match in `query.js` (the injection) and no hard-coded reference needed in `prompts.js` (Claude sees the block in context).
