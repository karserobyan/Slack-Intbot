# Production Hardening Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the highest-risk production safety issues in IntegrationsBot before product roadmap work resumes.

**Architecture:** Keep the existing Bolt app shape intact and add narrow safety boundaries around moderation, persistence, Slack rendering, source sensitivity, and handler failure control. Avoid a broad `handleQuery` rewrite in Phase 1; make each fix independently testable in the existing `test.js` no-framework suite.

**Tech Stack:** Node.js ESM, `@slack/bolt`, `@anthropic-ai/sdk`, plain `assert` in `test.js`, Markdown docs under `docs/superpowers/`.

## Global Constraints

- Work must happen on a feature branch, not `main`.
- The initial branch for this effort is `codex/production-hardening-phase-1`.
- Existing uncommitted work must not be reverted or folded into unrelated commits.
- Each implementation task must run `node test.js`.
- Pull request creation waits until all tests pass with 0 failures.
- Product roadmap discussion resumes only after Phase 1 is clean.
- All meaningful work must be tracked in `docs/superpowers/execution-log/2026-07-06-production-hardening.md`.
- Auto-answer must remain disabled by default.
- Dependency advisory scanning through external registries remains out of scope unless the user explicitly approves dependency inventory disclosure.
- Commit commands list the files that belong to each task. If any listed file had pre-existing uncommitted changes before the task, stage only the task's hunks for that file with `git add -p` or equivalent, then verify with `git diff --cached --name-only` and `git diff --cached` before committing.

---

## File Structure

- Create `src/slack/moderation.js`: moderator allowlist parsing, authorization checks, and user-facing denial helper.
- Create `src/slack/review-actions.js`: testable feedback/nomination approve/reject action handlers used by `src/index.js`.
- Create `src/slack/mrkdwn.js`: Slack mrkdwn escaping and allowlisted Slack-link rendering.
- Create `src/slack/source-policy.js`: code-owned source sensitivity classification and role filtering.
- Modify `src/index.js`: delegate review actions to `review-actions.js`.
- Modify `src/slack/feedback.js`: propagate persistence failures and expose test storage reset hooks.
- Modify `src/slack/nominations.js`: preserve pending nominations until knowledge writes succeed and expose test storage reset hooks.
- Modify `src/slack/knowledge-writer.js`: expose a narrow test hook for simulating write failure.
- Modify `src/slack/blocks.js`: use safe rendering helpers and source filtering.
- Modify `src/handlers/mention.js`: add event-boundary catch and dependency injection for tests.
- Modify `src/handlers/auto-answer.js`: improve startup validation messages without changing default enablement.
- Modify `.env.example` and `README.md`: document moderation and auto-answer Slack setup.
- Modify `test.js`: add no-framework assertions for each Phase 1 behavior.
- Modify `docs/superpowers/execution-log/2026-07-06-production-hardening.md`: record each task's action and verification.

When adding imports to `test.js`, consolidate them with the existing top-level ESM imports. The file already imports `tmpdir` from `node:os`, `rm`, `readFile`, and `writeFile` from `node:fs/promises`, and `join` from `node:path`; extend those import lists instead of adding duplicate imports in the middle of the file.

---

### Task 1: Moderator Authorization And Review Action Boundary

**Files:**
- Create: `src/slack/moderation.js`
- Create: `src/slack/review-actions.js`
- Modify: `src/index.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `test.js`
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Consumes: Existing `approveFeedback`, `rejectFeedback`, `approveNomination`, `rejectNomination`.
- Produces:
  - `getModeratorIds(env?: object): Set<string>`
  - `isAuthorizedModerator(userId: string, env?: object): boolean`
  - `requireAuthorizedModerator(userId: string, env?: object): true`
  - `sendUnauthorizedResponse({ body, client, respond, logger, actionName }): Promise<void>`
  - `handleFeedbackReviewAction({ decision, feedbackId, body, client, respond, logger, env, deps }): Promise<object>`
  - `handleNominationReviewAction({ decision, nominationId, body, client, respond, logger, env, deps }): Promise<object>`

- [ ] **Step 1: Write failing moderation tests**

Add this section near the feedback/nomination tests in `test.js`:

```js
// ── Moderation authorization ─────────────────────────────────────────────────
console.log('\n🔹 Moderation authorization');

import {
  getModeratorIds,
  isAuthorizedModerator,
  requireAuthorizedModerator,
  sendUnauthorizedResponse,
} from './src/slack/moderation.js';
import {
  handleFeedbackReviewAction,
  handleNominationReviewAction,
} from './src/slack/review-actions.js';

const modEnv = { MODERATOR_USER_IDS: 'U1, U2 ,,U3' };
assert([...getModeratorIds(modEnv)].join(',') === 'U1,U2,U3', 'moderator IDs parse comma-separated env');
assert(isAuthorizedModerator('U2', modEnv) === true, 'configured moderator is authorized');
assert(isAuthorizedModerator('U4', modEnv) === false, 'unlisted user is not authorized');
assert(isAuthorizedModerator('U1', {}) === false, 'missing moderator list fails closed');

let unauthorizedThrown = false;
try { requireAuthorizedModerator('U4', modEnv); } catch (err) {
  unauthorizedThrown = err.code === 'not_authorized' && err.userId === 'U4';
}
assert(unauthorizedThrown, 'requireAuthorizedModerator throws tagged authorization error');

const denialCalls = [];
await sendUnauthorizedResponse({
  body: { user: { id: 'U4' }, channel: { id: 'C_REVIEW' } },
  client: { chat: { postEphemeral: async (payload) => { denialCalls.push(['ephemeral', payload]); } } },
  respond: async (payload) => { denialCalls.push(['respond', payload]); },
  logger: { warn: () => {} },
  actionName: 'approve_feedback',
});
assert(denialCalls.some(([kind]) => kind === 'respond'), 'unauthorized response prefers respond');
assert(JSON.stringify(denialCalls).includes('not authorized'), 'unauthorized response explains denial');

let approveFeedbackCalled = false;
const unauthorizedFeedbackResult = await handleFeedbackReviewAction({
  decision: 'approve',
  feedbackId: 'fb_1',
  body: { user: { id: 'U4', name: 'Nope' }, channel: { id: 'C_REVIEW' } },
  client: { chat: { postMessage: async () => ({}), update: async () => ({}) }, users: { info: async () => ({ user: { profile: {} } }) } },
  respond: async () => {},
  logger: { warn: () => {}, info: () => {} },
  env: modEnv,
  deps: {
    approveFeedback: async () => { approveFeedbackCalled = true; return null; },
    rejectFeedback: async () => { throw new Error('should not run'); },
  },
});
assert(unauthorizedFeedbackResult.status === 'unauthorized', 'unauthorized feedback action returns unauthorized');
assert(approveFeedbackCalled === false, 'unauthorized feedback approval does not mutate feedback');

let approveNominationCalled = false;
const unauthorizedNominationResult = await handleNominationReviewAction({
  decision: 'approve',
  nominationId: 'nom_1',
  body: { user: { id: 'U4', name: 'Nope' }, channel: { id: 'C_REVIEW' } },
  client: { chat: { update: async () => ({}) }, users: { info: async () => ({ user: { profile: {} } }) } },
  respond: async () => {},
  logger: { warn: () => {}, info: () => {} },
  env: modEnv,
  deps: {
    approveNomination: async () => { approveNominationCalled = true; return null; },
    rejectNomination: async () => { throw new Error('should not run'); },
  },
});
assert(unauthorizedNominationResult.status === 'unauthorized', 'unauthorized nomination action returns unauthorized');
assert(approveNominationCalled === false, 'unauthorized nomination approval does not mutate nominations');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node test.js
```

Expected: FAIL with module-not-found for `src/slack/moderation.js` or `src/slack/review-actions.js`.

- [ ] **Step 3: Create `src/slack/moderation.js`**

```js
export function getModeratorIds(env = process.env) {
  return new Set(
    String(env.MODERATOR_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isAuthorizedModerator(userId, env = process.env) {
  if (!userId) return false;
  return getModeratorIds(env).has(userId);
}

export function requireAuthorizedModerator(userId, env = process.env) {
  if (isAuthorizedModerator(userId, env)) return true;
  const err = new Error(`User ${userId ?? '(missing)'} is not authorized to review IntegrationsBot feedback.`);
  err.code = 'not_authorized';
  err.userId = userId ?? null;
  throw err;
}

export async function sendUnauthorizedResponse({ body, client, respond, logger, actionName }) {
  const userId = body?.user?.id;
  logger?.warn?.(`[moderation] unauthorized ${actionName} by ${userId ?? '(missing user)'}`);
  const text = 'You are not authorized to approve or reject IntegrationsBot review items.';

  if (respond) {
    try {
      await respond({ response_type: 'ephemeral', text });
      return;
    } catch (err) {
      logger?.warn?.(`[moderation] respond failed for unauthorized ${actionName}: ${err.message}`);
    }
  }

  const channel = body?.channel?.id;
  if (client?.chat?.postEphemeral && channel && userId) {
    await client.chat.postEphemeral({ channel, user: userId, text }).catch((err) => {
      logger?.warn?.(`[moderation] postEphemeral failed for unauthorized ${actionName}: ${err.message}`);
    });
  }
}
```

- [ ] **Step 4: Create `src/slack/review-actions.js`**

```js
import { approveFeedback, rejectFeedback } from './feedback.js';
import { approveNomination, rejectNomination } from './nominations.js';
import { isAuthorizedModerator, sendUnauthorizedResponse } from './moderation.js';

async function getReviewerName(client, body) {
  let reviewerName = body?.user?.name ?? body?.user?.id ?? 'Reviewer';
  try {
    const res = await client.users.info({ user: body.user.id });
    reviewerName = res.user?.profile?.display_name || res.user?.profile?.real_name || reviewerName;
  } catch {
    // Use Slack payload fallback.
  }
  return reviewerName;
}

async function denyIfUnauthorized({ body, client, respond, logger, actionName, env }) {
  if (isAuthorizedModerator(body?.user?.id, env)) return false;
  await sendUnauthorizedResponse({ body, client, respond, logger, actionName });
  return true;
}

export async function handleFeedbackReviewAction({
  decision,
  feedbackId,
  body,
  client,
  respond,
  logger,
  env = process.env,
  deps = { approveFeedback, rejectFeedback },
}) {
  const actionName = `${decision}_feedback`;
  if (await denyIfUnauthorized({ body, client, respond, logger, actionName, env })) {
    return { status: 'unauthorized' };
  }
  if (!feedbackId) return { status: 'bad_request' };

  const record = decision === 'approve'
    ? await deps.approveFeedback(feedbackId)
    : await deps.rejectFeedback(feedbackId);
  if (!record) return { status: 'not_found' };

  const reviewerName = await getReviewerName(client, body);
  const approved = decision === 'approve';
  const icon = approved ? '✅' : '❌';
  const verb = approved ? 'Approved' : 'Rejected';

  if (record.reviewMessageTs && record.reviewChannelId) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `${icon} ${verb} by ${reviewerName}`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `${icon} *${verb} by ${reviewerName}*\n_Feedback ID: ${record.id}_` },
      }],
    }).catch((err) => logger?.warn?.(`[feedback] Failed to update review card: ${err.message}`));
  }

  const dmText = approved
    ? `✅ Your feedback on *"${record.issueTitle}"* was approved and applied — thanks for helping improve the bot!`
    : `Your feedback on *"${record.issueTitle}"* was reviewed and not applied — thanks for flagging it.`;
  await client.chat.postMessage({ channel: record.agentId, text: dmText })
    .catch((err) => logger?.warn?.(`[feedback] Failed to DM agent after ${decision}: ${err.message}`));

  logger?.info?.(`[feedback] ${feedbackId} ${decision}d by ${reviewerName}`);
  return { status: decision === 'approve' ? 'approved' : 'rejected', record };
}

export async function handleNominationReviewAction({
  decision,
  nominationId,
  body,
  client,
  respond,
  logger,
  env = process.env,
  deps = { approveNomination, rejectNomination },
}) {
  const actionName = `${decision}_nomination`;
  if (await denyIfUnauthorized({ body, client, respond, logger, actionName, env })) {
    return { status: 'unauthorized' };
  }
  if (!nominationId) return { status: 'bad_request' };

  const reviewerName = await getReviewerName(client, body);
  const record = decision === 'approve'
    ? await deps.approveNomination(nominationId, client, reviewerName)
    : await deps.rejectNomination(nominationId, client, reviewerName);
  if (!record) return { status: 'not_found' };

  logger?.info?.(`[nominations] ${nominationId} ${decision}d by ${reviewerName}`);
  return { status: decision === 'approve' ? 'approved' : 'rejected', record };
}
```

- [ ] **Step 5: Wire `src/index.js` to review action helpers**

Add:

```js
import { handleFeedbackReviewAction, handleNominationReviewAction } from './slack/review-actions.js';
```

Replace the bodies of `approve_feedback`, `reject_feedback`, `approve_nomination`, and `reject_nomination` after `await ack()` with these forms:

```js
let payload = {};
try { payload = JSON.parse(action.value); } catch { return; }
try {
  await handleFeedbackReviewAction({
    decision: 'approve',
    feedbackId: payload.feedbackId,
    body,
    client,
    respond,
    logger: app.logger,
  });
} catch (err) {
  app.logger.error(`[feedback] approve_feedback failed: ${err.message}`);
  await respond?.({ response_type: 'ephemeral', text: 'Approval failed. The feedback was not changed.' }).catch(() => {});
}
```

Use `decision: 'reject'` for `reject_feedback`, and call `handleNominationReviewAction` with `nominationId: payload.nominationId` for nomination actions.

- [ ] **Step 6: Document `MODERATOR_USER_IDS`**

Add to `.env.example` near feedback review channel settings:

```dotenv
# Comma-separated Slack user IDs allowed to approve/reject feedback and knowledge nominations.
# If unset, approval/rejection actions fail closed.
MODERATOR_USER_IDS=
```

Add to `README.md` environment table:

```md
| `MODERATOR_USER_IDS` | Required for review actions | Comma-separated Slack user IDs allowed to approve/reject feedback and knowledge nominations. If unset, review actions fail closed. |
```

- [ ] **Step 7: Run tests**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 8: Update execution log**

Append:

```md
## 2026-07-06 — Task 1 Moderator Authorization Implemented

**Intent:** Prevent unauthorized users from approving or rejecting feedback and knowledge nominations.

**Action Taken:** Added moderator authorization helpers, testable review-action handlers, wired Slack action handlers through the guard, and documented `MODERATOR_USER_IDS`.

**Files Touched:**
- `src/slack/moderation.js`
- `src/slack/review-actions.js`
- `src/index.js`
- `.env.example`
- `README.md`
- `test.js`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** Continue to durable persistence semantics.
```

- [ ] **Step 9: Commit**

```bash
git add src/slack/moderation.js src/slack/review-actions.js src/index.js .env.example README.md test.js docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "fix: authorize review actions"
```

---

### Task 2: Durable Feedback Persistence

**Files:**
- Modify: `src/slack/feedback.js`
- Modify: `test.js`
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Consumes: Existing feedback records and `deleteCache`.
- Produces:
  - `saveFeedback(entry): Promise<object>` rejects on write failure.
  - `approveFeedback(id): Promise<object|null>` rejects on read/write failure.
  - `rejectFeedback(id): Promise<object|null>` rejects on write failure.
  - `_setFeedbackStorageForTest({ dir }): void`

- [ ] **Step 1: Write failing tests for feedback write propagation**

Add near feedback tests in `test.js`:

First update top-level imports:

```js
import { getRelevantFeedback, getAllFeedback, saveFeedback, approveFeedback, rejectFeedback, getPendingFeedback, _setFeedbackStorageForTest } from './src/slack/feedback.js';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
```

Then add the test body:

```js
// — feedback persistence failures —

const feedbackTempDir = await mkdtemp(join(tmpdir(), 'intbot-feedback-'));
_setFeedbackStorageForTest({ dir: feedbackTempDir });
await saveFeedback({
  query: 'Zapier broken',
  issueTitle: 'Zapier',
  integrationType: 'Zapier',
  feedbackType: 'wrong_answer',
  correction: 'Correct it',
  agentId: 'U_AGENT',
  agentName: 'Agent',
});
const pendingBeforeFailure = await getPendingFeedback();
assert(pendingBeforeFailure.length === 1, 'feedback test setup has one pending entry');

await rm(feedbackTempDir, { recursive: true, force: true });
let saveRejected = false;
try {
  await saveFeedback({
    query: 'RwG broken',
    issueTitle: 'RwG',
    integrationType: 'RwG',
    feedbackType: 'wrong_answer',
    correction: 'Correct it',
    agentId: 'U_AGENT',
    agentName: 'Agent',
  });
} catch {
  saveRejected = true;
}
assert(saveRejected, 'saveFeedback rejects when pending write fails');
_setFeedbackStorageForTest({ dir: join(process.cwd(), 'data') });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node test.js
```

Expected: FAIL with missing `_setFeedbackStorageForTest` or because `saveFeedback` still swallows write failure.

- [ ] **Step 3: Refactor feedback storage paths and queue**

In `src/slack/feedback.js`, change constants to mutable storage paths and add `enqueueWrite`:

```js
let FEEDBACK_DIR = join(process.cwd(), 'data');
let FEEDBACK_FILE = join(FEEDBACK_DIR, 'feedback.json');
let PENDING_FILE = join(FEEDBACK_DIR, 'feedback-pending.json');

function enqueueWrite(fn) {
  const job = _writeQueue.then(fn, fn);
  _writeQueue = job.catch(() => {});
  return job;
}

export function _setFeedbackStorageForTest({ dir }) {
  FEEDBACK_DIR = dir;
  FEEDBACK_FILE = join(FEEDBACK_DIR, 'feedback.json');
  PENDING_FILE = join(FEEDBACK_DIR, 'feedback-pending.json');
  _activeCache = null;
  _pendingCache = null;
  _writeQueue = Promise.resolve();
}
```

- [ ] **Step 4: Make feedback mutations reject on critical failures**

Replace `_writeQueue = _writeQueue.then(...).catch(...)` patterns in `saveFeedback`, `approveFeedback`, and `rejectFeedback` with:

```js
await enqueueWrite(async () => {
  const pending = await loadPending();
  pending.push(record);
  if (pending.length > MAX_PENDING) {
    pending.splice(0, pending.length - MAX_PENDING);
  }
  _pendingCache = pending;
  await persistPending(pending);
});
return record;
```

For `approveFeedback`, keep the existing active-first logic but let failures reject:

```js
await enqueueWrite(async () => {
  const pending = await loadPending();
  const idx = pending.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const record = pending[idx];
  const active = await loadActive();
  if (!active.some((e) => e.id === id)) {
    active.push(record);
    if (active.length > MAX_ACTIVE) active.splice(0, active.length - MAX_ACTIVE);
    _activeCache = active;
    await persistActive(active);
  }
  pending.splice(idx, 1);
  _pendingCache = pending;
  await persistPending(pending);
  approved = record;
  deleteCache(record.query);
});
return approved;
```

- [ ] **Step 5: Run tests**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 6: Update execution log**

Append:

```md
## 2026-07-06 — Task 2 Durable Feedback Persistence Implemented

**Intent:** Prevent feedback storage from reporting success after critical persistence failures.

**Action Taken:** Made feedback write operations propagate critical failures and added test storage isolation.

**Files Touched:**
- `src/slack/feedback.js`
- `test.js`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** Continue to nomination persistence semantics.
```

- [ ] **Step 7: Commit**

```bash
git add src/slack/feedback.js test.js docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "fix: propagate feedback persistence failures"
```

---

### Task 3: Durable Nomination Approval

**Files:**
- Modify: `src/slack/nominations.js`
- Modify: `src/slack/knowledge-writer.js`
- Modify: `test.js`
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Consumes: Existing nomination records and `appendBotResponse`.
- Produces:
  - `approveNomination(id, client, reviewerName): Promise<object|null>` only removes pending state after successful knowledge write.
  - `_setStoreForTest(path): void` remains available.
  - `_setKnowledgeWriterFailureForTest(shouldFail: boolean): void`

- [ ] **Step 1: Write failing nomination persistence test**

Add near nomination tests in `test.js`:

First update the existing top-level knowledge-writer import:

```js
import {
  appendKbArticle,
  appendBotResponse,
  hasKbUrl,
  hasIssueTitle,
  _setKnowledgeWriterFailureForTest,
} from './src/slack/knowledge-writer.js';
```

Then add the test body:

```js
// — nomination approval preserves pending state when knowledge write fails —

const nomFailFile = join(tmpdir(), `intbot-nominations-${Date.now()}.json`);
_setStoreForTest(nomFailFile);
const nomFailClient = { chat: { postMessage: async () => ({ ts: '222.333' }), update: async () => ({}) } };
const failingNomination = await nominateResponse(nomFailClient, {
  integration: 'Zapier',
  issueTitle: 'Write Failure Nomination',
  steps: ['Do the thing'],
  refs: ['Slack thread'],
});
_setKnowledgeWriterFailureForTest(true);
let nominationRejected = false;
try {
  await approveNomination(failingNomination.id, nomFailClient, 'Reviewer');
} catch {
  nominationRejected = true;
}
_setKnowledgeWriterFailureForTest(false);
assert(nominationRejected, 'approveNomination rejects when knowledge write fails');
const stillPending = await approveNomination(failingNomination.id, nomFailClient, 'Reviewer');
assert(stillPending?.id === failingNomination.id, 'nomination remains pending after failed knowledge write');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node test.js
```

Expected: FAIL with missing `_setKnowledgeWriterFailureForTest` or because pending state is deleted before failed write.

- [ ] **Step 3: Add knowledge-writer failure test hook**

In `src/slack/knowledge-writer.js`:

```js
let _failWritesForTest = false;

export function _setKnowledgeWriterFailureForTest(shouldFail) {
  _failWritesForTest = shouldFail;
}
```

At the top of both `appendKbArticle` and `appendBotResponse` queued write functions, add:

```js
if (_failWritesForTest) throw new Error('knowledge writer failure injected for test');
```

- [ ] **Step 4: Make `approveNomination` write before delete**

In `src/slack/nominations.js`, replace `approveNomination` with:

```js
export async function approveNomination(id, client, reviewerName = 'Moderator') {
  const pending = await loadPending();
  const record = pending.get(id);
  if (!record) return null;

  const written = await appendBotResponse(record.integration, record.issueTitle, record.steps, record.refs, DEFAULT_KB_FILE, client);
  if (!written) {
    throw new Error(`Knowledge write failed for nomination ${id}`);
  }

  pending.delete(id);
  await persistPending();

  if (record.reviewMessageTs && client) {
    await client.chat.update({
      channel: record.reviewChannelId,
      ts: record.reviewMessageTs,
      text: `✅ Approved by ${reviewerName}`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ *Approved by ${reviewerName}*\n_${record.id} — ${record.integration}: ${record.issueTitle}_` },
      }],
    }).catch((err) => console.warn('[nominations] Failed to update review card:', err.message));
  }

  return record;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 6: Update execution log**

Append:

```md
## 2026-07-06 — Task 3 Durable Nomination Approval Implemented

**Intent:** Prevent approved knowledge nominations from being lost when `knowledge.md` cannot be written.

**Action Taken:** Changed nomination approval to write knowledge before deleting pending state and added failure-injection coverage.

**Files Touched:**
- `src/slack/nominations.js`
- `src/slack/knowledge-writer.js`
- `test.js`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** Continue to Slack rendering safety.
```

- [ ] **Step 7: Commit**

```bash
git add src/slack/nominations.js src/slack/knowledge-writer.js test.js docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "fix: preserve nominations on knowledge write failure"
```

---

### Task 4: Slack Markdown And Link Safety

**Files:**
- Create: `src/slack/mrkdwn.js`
- Modify: `src/slack/blocks.js`
- Modify: `src/slack/feedback.js`
- Modify: `src/slack/nominations.js`
- Modify: `src/slack/modal.js`
- Modify: `test.js`
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Produces:
  - `escapeMrkdwn(value: unknown): string`
  - `safeSlackLink(url: string, label: string): string`

- [ ] **Step 1: Write failing mrkdwn tests**

Add near Block Kit tests in `test.js`:

```js
// ── Slack mrkdwn safety ──────────────────────────────────────────────────────
console.log('\n🔹 Slack mrkdwn safety');

import { escapeMrkdwn, safeSlackLink } from './src/slack/mrkdwn.js';

assert(escapeMrkdwn('A&B <@U123> <https://evil.test|click>') === 'A&amp;B &lt;@U123&gt; &lt;https://evil.test|click&gt;', 'escapeMrkdwn escapes Slack control chars');
assert(safeSlackLink('https://servicetitan.slack.com/archives/C123/p456', 'Safe <label>').includes('<https://servicetitan.slack.com/archives/C123/p456|Safe &lt;label&gt;'), 'safeSlackLink allows Slack host and escapes label');
assert(safeSlackLink('https://evil.test/x', 'Bad <label>') === 'Bad &lt;label&gt;', 'safeSlackLink rejects unknown hosts');
assert(safeSlackLink('not a url', 'Broken <label>') === 'Broken &lt;label&gt;', 'safeSlackLink rejects invalid URLs');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node test.js
```

Expected: FAIL with module-not-found for `src/slack/mrkdwn.js`.

- [ ] **Step 3: Create `src/slack/mrkdwn.js`**

```js
const ALLOWED_LINK_HOSTS = new Set([
  'servicetitan.slack.com',
  'servicetitan.atlassian.net',
  'help.servicetitan.com',
]);

export function escapeMrkdwn(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function safeSlackLink(url, label) {
  const safeLabel = escapeMrkdwn(label);
  try {
    const parsed = new URL(String(url ?? ''));
    if (!ALLOWED_LINK_HOSTS.has(parsed.hostname)) return safeLabel;
    return `<${parsed.href}|${safeLabel}>`;
  } catch {
    return safeLabel;
  }
}
```

- [ ] **Step 4: Use helpers in renderers**

In `src/slack/blocks.js`, import:

```js
import { escapeMrkdwn, safeSlackLink } from './mrkdwn.js';
```

Escape user/model fields while preserving intentional labels:

```js
text: { type: 'mrkdwn', text: `💬 _"${clamp(escapeMrkdwn(data.customer_message))}"_` },
```

Use safe links in `buildSourcesModal`:

```js
text: { type: 'mrkdwn', text: clamp(`• ${safeSlackLink(ref.url, ref.title)}\n  _${escapeMrkdwn(ref.channel)}_`) },
```

In `src/slack/modal.js`, import and apply:

```js
import { escapeMrkdwn } from './mrkdwn.js';

const safeText = text ? escapeMrkdwn(text) : '_No channel post text was generated._';
```

In review-card builders in `src/slack/feedback.js` and `src/slack/nominations.js`, escape `record.query`, `record.issueTitle`, `record.correction`, `record.integration`, and `record.proposedEntry` before inserting into `mrkdwn`.

- [ ] **Step 5: Add rendering regression tests**

Add:

```js
const unsafeSourcesModal = buildSourcesModal({
  slack_refs: [{ url: 'https://evil.test/x', title: '<@U123> click', channel: '<#C123>' }],
});
const unsafeSourcesText = JSON.stringify(unsafeSourcesModal);
assert(!unsafeSourcesText.includes('<https://evil.test'), 'unsafe source URL is not rendered as clickable Slack link');
assert(unsafeSourcesText.includes('&lt;@U123&gt;'), 'unsafe source title is escaped');
assert(unsafeSourcesText.includes('&lt;#C123&gt;'), 'unsafe source channel is escaped');
```

- [ ] **Step 6: Run tests**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 7: Update execution log**

Append:

```md
## 2026-07-06 — Task 4 Slack Rendering Safety Implemented

**Intent:** Prevent Slack mrkdwn/link injection in bot-rendered messages and modals.

**Action Taken:** Added mrkdwn escaping and safe-link helpers, then routed source modals, feedback cards, nomination cards, and copy modals through them.

**Files Touched:**
- `src/slack/mrkdwn.js`
- `src/slack/blocks.js`
- `src/slack/feedback.js`
- `src/slack/nominations.js`
- `src/slack/modal.js`
- `test.js`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** Continue to code-owned source sensitivity policy.
```

- [ ] **Step 8: Commit**

```bash
git add src/slack/mrkdwn.js src/slack/blocks.js src/slack/feedback.js src/slack/nominations.js src/slack/modal.js test.js docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "fix: escape slack markdown output"
```

---

### Task 5: Code-Owned Source Sensitivity Policy

**Files:**
- Create: `src/slack/source-policy.js`
- Modify: `src/slack/blocks.js`
- Modify: `test.js`
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Produces:
  - `classifySourceRef(ref: object): object`
  - `filterRefsForRole(refs: object[], role: 'csa'|'specialist'): object[]`

- [ ] **Step 1: Write failing source-policy tests**

Add:

```js
// ── Source sensitivity policy ────────────────────────────────────────────────
console.log('\n🔹 Source sensitivity policy');

import { classifySourceRef, filterRefsForRole } from './src/slack/source-policy.js';

const modelSensitive = classifySourceRef({ title: 'Normal', sensitive: true });
assert(modelSensitive.sensitive === true, 'source policy preserves model sensitive flag');
const backendSlack = classifySourceRef({ channel: '#backend-tools', title: 'Zapier fix' });
assert(backendSlack.sensitive === true, 'backend Slack channels are sensitive');
const incidentJira = classifySourceRef({ type: 'jira', title: 'INC-123 customer incident' });
assert(incidentJira.sensitive === true, 'incident-like Jira refs are sensitive');
const publicKb = classifySourceRef({ url: 'https://help.servicetitan.com/article', title: 'Public KB' });
assert(publicKb.sensitive !== true, 'KB host is not marked sensitive by default');
const csaRefs = filterRefsForRole([backendSlack, publicKb], 'csa');
assert(csaRefs.length === 1 && csaRefs[0].title === 'Public KB', 'CSA refs filter sensitive refs');
const specialistRefs = filterRefsForRole([backendSlack, publicKb], 'specialist');
assert(specialistRefs.length === 2, 'Specialists see sensitive refs');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node test.js
```

Expected: FAIL with module-not-found for `src/slack/source-policy.js`.

- [ ] **Step 3: Create `src/slack/source-policy.js`**

```js
const SENSITIVE_CHANNEL_RE = /^#?(backend|eng|engineering|incident|private|security|sec|ops|pricing|contract|legal)(-|_|$)/i;
const SENSITIVE_TEXT_RE = /\b(incident|outage|pii|ssn|contract|pricing|secret|token|backend-only|internal escalation)\b/i;

export function classifySourceRef(ref) {
  const next = { ...ref };
  if (next.sensitive === true) return next;

  const url = String(next.url ?? '');
  if (url.includes('help.servicetitan.com')) return next;

  const channel = String(next.channel ?? '');
  const title = String(next.title ?? '');
  const type = String(next.type ?? '');

  if (SENSITIVE_CHANNEL_RE.test(channel) || SENSITIVE_TEXT_RE.test(`${title} ${type}`)) {
    next.sensitive = true;
  }

  return next;
}

export function filterRefsForRole(refs = [], role = 'csa') {
  const classified = refs.map(classifySourceRef);
  if (role === 'specialist') return classified;
  return classified.filter((ref) => ref.sensitive !== true);
}
```

- [ ] **Step 4: Apply source policy in `buildResponseBlocks`**

In `src/slack/blocks.js`, import:

```js
import { classifySourceRef, filterRefsForRole } from './source-policy.js';
```

Replace current visibility logic with:

```js
const classifiedSlack = slackRefs.map(classifySourceRef);
const classifiedAtlassian = atlassianRefs.map(classifySourceRef);
const visibleSlack = filterRefsForRole(classifiedSlack, role);
const visibleAtlassian = filterRefsForRole(classifiedAtlassian, role);
const hiddenCount = (classifiedSlack.length - visibleSlack.length) + (classifiedAtlassian.length - visibleAtlassian.length);
```

- [ ] **Step 5: Add Block Kit sensitivity regression test**

Add:

```js
const codeSensitiveBlocks = buildResponseBlocks({
  issue_title: 'Sensitive Source',
  confidence: 'high',
  customer_message: 'Hi [Name], done.',
  agent_steps: [],
  slack_refs: [
    { url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#backend-tools', title: 'Backend fix' },
  ],
  atlassian_refs: [],
  kb_refs: [],
  sources_used: ['slack'],
}, { role: 'csa' });
const codeSensitiveText = JSON.stringify(codeSensitiveBlocks);
assert(codeSensitiveText.includes('specialist-only'), 'CSA response indicates hidden specialist-only refs');
assert(!codeSensitiveText.includes('Diagnosis + Sources'), 'CSA response does not expose sources button for sensitive-only refs');
```

- [ ] **Step 6: Run tests**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 7: Update execution log**

Append:

```md
## 2026-07-06 — Task 5 Source Sensitivity Policy Implemented

**Intent:** Stop relying only on model-provided sensitivity labels before rendering sources to CSAs.

**Action Taken:** Added source classification and role filtering, then applied it in response rendering.

**Files Touched:**
- `src/slack/source-policy.js`
- `src/slack/blocks.js`
- `test.js`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** Continue to Slack event-boundary failure handling.
```

- [ ] **Step 8: Commit**

```bash
git add src/slack/source-policy.js src/slack/blocks.js test.js docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "fix: enforce source sensitivity in code"
```

---

### Task 6: Mention Handler Event-Boundary Catch

**Files:**
- Modify: `src/handlers/mention.js`
- Modify: `test.js`
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Updates `registerMentionHandler(app, options?)` to accept:
  - `queryHandler?: Function`
  - `dedupeTtlMs?: number`

- [ ] **Step 1: Write failing event-boundary test**

Add:

```js
// ── mention handler event-boundary catch ─────────────────────────────────────
console.log('\n🔹 mention handler event-boundary catch');

import { registerMentionHandler } from './src/handlers/mention.js';

let mentionCallback;
const mentionPosts = [];
const mentionLogs = [];
registerMentionHandler({
  event: (_name, cb) => { mentionCallback = cb; },
}, {
  dedupeTtlMs: 0,
  queryHandler: async () => { throw new Error('forced handler failure'); },
});
await mentionCallback({
  event: { channel: 'C123', user: 'U123', ts: '123.456', text: '<@UBOT> Zapier broken' },
  body: { event_id: 'Ev123' },
  client: { chat: { postMessage: async (payload) => { mentionPosts.push(payload); } } },
  logger: { warn: (m) => mentionLogs.push(m), error: (m) => mentionLogs.push(m), info: () => {} },
});
assert(mentionPosts.length === 1, 'mention top-level catch posts fallback');
assert(mentionPosts[0].thread_ts === '123.456', 'mention fallback posts in the request thread');
assert(JSON.stringify(mentionLogs).includes('unhandled failure'), 'mention top-level catch logs failure');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node test.js
```

Expected: FAIL because `registerMentionHandler` does not accept test options and does not catch thrown query handler failures.

- [ ] **Step 3: Update `registerMentionHandler`**

Replace the function signature and handler body with:

```js
export function registerMentionHandler(app, { queryHandler = handleQuery, dedupeTtlMs = 60_000 } = {}) {
  const _inFlight = new Set();

  app.event('app_mention', async ({ event, body, client, logger }) => {
    if (event.channel_type === 'im' || event.channel.startsWith('D')) return;
    const eventKey = body?.event_id ?? event.ts;
    if (_inFlight.has(eventKey)) {
      logger.warn(`[mention] Duplicate event ${eventKey} — skipping`);
      return;
    }
    _inFlight.add(eventKey);

    logger.info(`[mention] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);

    try {
      await queryHandler({
        rawText: event.text ?? '',
        channelId: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        client,
        userId: event.user,
      });
    } catch (err) {
      logger.error?.(`[mention] unhandled failure event=${eventKey} channel=${event.channel} ts=${event.ts} user=${event.user}: ${err.message}`);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: 'I hit an internal error handling this request. Please retry or escalate manually.',
      }).catch((postErr) => {
        logger.error?.(`[mention] failed to post fallback for event=${eventKey}: ${postErr.message}`);
      });
    } finally {
      setTimeout(() => _inFlight.delete(eventKey), dedupeTtlMs);
    }
  });
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 5: Update execution log**

Append:

```md
## 2026-07-06 — Task 6 Mention Event Boundary Catch Implemented

**Intent:** Ensure unexpected mention handling failures are logged and visible instead of bubbling to Bolt.

**Action Taken:** Added a top-level catch around mention query handling and dependency injection for focused tests.

**Files Touched:**
- `src/handlers/mention.js`
- `test.js`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** Continue to auto-answer configuration validation and docs.
```

- [ ] **Step 6: Commit**

```bash
git add src/handlers/mention.js test.js docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "fix: catch mention handler boundary failures"
```

---

### Task 7: Auto-Answer Configuration Documentation And Validation

**Files:**
- Modify: `src/handlers/auto-answer.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `test.js`
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Keeps `AUTO_ANSWER_ENABLED=false` as default.
- Updates `verifyChannelAccess(client, channelId, logger)` to provide clearer scope/event guidance.

- [ ] **Step 1: Write failing auto-answer validation/doc tests**

Add:

```js
// — auto-answer docs/config expectations —
const readmeText = await readFile('README.md', 'utf-8');
const envExampleText = await readFile('.env.example', 'utf-8');
assert(readmeText.includes('message.channels'), 'README documents message.channels for auto-answer');
assert(readmeText.includes('channels:read'), 'README documents channels:read for auto-answer');
assert(readmeText.includes('channels:history'), 'README documents channels:history for auto-answer');
assert(envExampleText.includes('AUTO_ANSWER_ENABLED=false'), '.env.example keeps auto-answer disabled by default');

const missingScopeLog = makeLogger();
await verifyChannelAccess(
  { conversations: { info: async () => { const e = new Error('missing_scope'); e.data = { error: 'missing_scope', needed: 'channels:read' }; throw e; } } },
  'C_SRC',
  missingScopeLog,
);
assert(missingScopeLog.warns.some((m) => m.includes('message.channels')), 'auto-answer missing-scope warning mentions message.channels event setup');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node test.js
```

Expected: FAIL because README or warning text does not mention the full auto-answer event setup.

- [ ] **Step 3: Improve `verifyChannelAccess` warning**

In `src/handlers/auto-answer.js`, update the `missing_scope` branch:

```js
log.warn?.(`[auto-answer] Missing Slack scope for source channel ${channelId}: needs "${err.data?.needed ?? 'channels:read'}". Add channels:read + channels:history to the bot token, subscribe to the message.channels event, reinstall the app, and invite the bot to the source channel.`);
```

Update the `channel_not_found` branch:

```js
log.warn?.(`[auto-answer] Source channel ${channelId} not found — AUTO_ANSWER_SOURCE_CHANNEL must be a channel ID (e.g. C0123ABCD), not a name. For private channels, the bot must be invited and may need groups:read/groups:history if private-channel support is added later.`);
```

- [ ] **Step 4: Update docs**

In `.env.example`, expand the auto-answer comments:

```dotenv
# Required Slack app setup when AUTO_ANSWER_ENABLED=true:
# - Bot scopes: channels:read, channels:history, chat:write
# - Event subscription: message.channels
# - Bot must be invited to AUTO_ANSWER_SOURCE_CHANNEL and AUTO_ANSWER_TARGET_CHANNEL.
```

In `README.md`, add under Slack app setup:

```md
**Additional setup for auto-answer channel watcher:**
- Bot scopes: `channels:read`, `channels:history`, `chat:write`
- Event subscription: `message.channels`
- `AUTO_ANSWER_SOURCE_CHANNEL` and `AUTO_ANSWER_TARGET_CHANNEL` must be Slack channel IDs, not names
- The bot must be a member of both channels
- Auto-answer remains off unless `AUTO_ANSWER_ENABLED=true`
```

- [ ] **Step 5: Run tests**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 6: Update execution log**

Append:

```md
## 2026-07-06 — Task 7 Auto-Answer Configuration Documented

**Intent:** Prevent silent auto-answer deployment failures caused by missing Slack scopes, events, or channel membership.

**Action Taken:** Clarified required auto-answer Slack scopes, event subscriptions, channel ID requirements, and startup warnings.

**Files Touched:**
- `src/handlers/auto-answer.js`
- `.env.example`
- `README.md`
- `test.js`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** Run final Phase 1 verification.
```

- [ ] **Step 7: Commit**

```bash
git add src/handlers/auto-answer.js .env.example README.md test.js docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "docs: clarify auto-answer slack setup"
```

---

### Task 8: Final Phase 1 Verification

**Files:**
- Modify: `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Interfaces:**
- Consumes all previous tasks.
- Produces final verification entry and readiness for branch finishing.

- [ ] **Step 1: Run full test suite**

Run:

```bash
node test.js
```

Expected: PASS, 0 failures.

- [ ] **Step 2: Inspect working tree**

Run:

```bash
git status --short --branch
```

Expected: Only intended Phase 1 changes are present. Pre-existing uncommitted auto-answer changes must be identified separately if still present.

- [ ] **Step 3: Update execution log**

Append:

```md
## 2026-07-06 — Phase 1 Final Verification

**Intent:** Confirm production-hardening Phase 1 is ready for review.

**Action Taken:** Ran the full test suite and inspected the working tree.

**Files Touched:**
- `docs/superpowers/execution-log/2026-07-06-production-hardening.md`

**Verification:** `node test.js` passed with 0 failures. `git status --short --branch` reviewed for intended changes only.

**Decision / Follow-up:** Use `superpowers:finishing-a-development-branch` before PR creation.
```

- [ ] **Step 4: Commit final log entry**

```bash
git add docs/superpowers/execution-log/2026-07-06-production-hardening.md
git commit -m "docs: record phase 1 verification"
```

- [ ] **Step 5: Finish branch**

Use `superpowers:finishing-a-development-branch`.

Required verification before PR:

```bash
node test.js
```

Expected: PASS, 0 failures.

---

## Self-Review Notes

- Spec coverage: All in-scope items map to Tasks 1 through 8.
- Placeholder scan: No `TBD`, `TODO`, `fill in`, or "implement later" steps are intentionally present.
- Type consistency: Moderator, review action, mrkdwn, source-policy, feedback, nomination, and mention-handler function names are defined before they are consumed.
- Scope check: Product roadmap, Redis migration, Slack search replacement, broad architecture split, and external dependency advisory scanning remain out of scope.
