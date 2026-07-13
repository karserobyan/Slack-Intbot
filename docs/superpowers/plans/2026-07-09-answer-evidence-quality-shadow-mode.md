# Answer Evidence Quality Shadow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build PR 1 of the Answer Evidence + Knowledge Quality direction: a fail-open, shadow-mode-only quality layer that maps current answers to evidence contracts, scores sources, stores sanitized bounded metadata, and does not change user-visible Slack behavior.

**Architecture:** Add focused `src/quality/*` modules behind feature flags. The mention handler records shadow metadata after the existing answer has been delivered, using the current answer object and refs; if anything fails, answering and existing nomination behavior continue unchanged. No answerer prompt changes, no nomination replacement, no Slack card redesign, no database.

**Tech Stack:** Node.js ESM, Slack Bolt, plain `assert` tests in `test.js`, JSON/JSONL file storage under `data/`.

## Global Constraints

- First implementation PR is shadow-mode only.
- No user-visible Slack answer behavior changes.
- No answerer prompt changes unless strictly needed for metadata passthrough; this PR must not need prompt changes.
- No live nomination behavior replacement in PR 1.
- Quality layer must fail open for answering.
- `knowledge.md` remains the durable knowledge surface.
- Auto-answer stays local-only and out of product scope.
- `data/quality-shadow.jsonl` retention is fixed before PR 1: max 2,000 records, max 14 days, max 5 MB.
- Shadow metadata and audit payloads must not store full raw snippets, customer-sensitive text, secrets, PII, request headers, full model prompts, or large payloads.
- Use hashes, IDs, source titles, short sanitized previews, and reason codes.
- Run `node test.js`; it must pass with 0 failures before any PR is opened.

---

## Scope Check

The approved design spans multiple PRs. This implementation plan intentionally covers PR 1 only:

```text
PR 1: Shadow Contract And Source Scoring
```

Future PRs get separate implementation plans after PR 1 lands:

- PR 2: Shadow claim-level nomination policy.
- PR 3: Claim-level nomination review cards, preserving current append behavior.
- PR 4: Unified review candidate store.
- PR 5: Safe `knowledge.md` writes with dedupe and audit-aware behavior.
- PR 6: Answer UX redesign after quality metrics prove the contract is useful.

## File Map

### Create

- `src/quality/config.js`
  - Reads quality-layer feature flags and retention limits.

- `src/quality/privacy.js`
  - Owns sanitized previews, stable hashes, and ID generation helpers.

- `src/quality/source-scoring.js`
  - Converts existing refs into evidence records and scores source quality, directness, freshness, sensitivity, and reuse value.

- `src/quality/evidence-contract.js`
  - Maps the current answer object into the Answer Evidence Contract without requiring prompt changes.

- `src/quality/shadow-store.js`
  - Appends bounded sanitized shadow records to `data/quality-shadow.jsonl`.

- `src/quality/audit-log.js`
  - Appends sanitized quality audit events to `data/quality-audit.jsonl`.

- `src/quality/shadow-recorder.js`
  - Orchestrates contract building, shadow storage, and audit logging behind flags.

### Modify

- `src/handlers/mention.js`
  - Fire-and-catch shadow recording after the existing answer is sent and history is appended.
  - Do not change response blocks, text, or nomination conditions.

- `test.js`
  - Add tests for privacy helpers, source scoring, contract mapping, retention, audit safety, and fail-open recording.

- `.env.example`
  - Document PR 1 quality flags with safe defaults.

- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`
  - Add task-by-task execution entries during implementation.

## Current Answer Object Mapper

PR 1 must map the current answer object into the new contract. It must not require answerer prompt changes.

| Current field | Contract field | Mapping rule |
|---|---|---|
| `answer.issue_title` | `issueTitle` | String, default `'Integration Issue'` |
| `answer.integration_type` | `integrationType` | String, default `'General'` |
| `answer.confidence` | `confidence` | One of `high`, `medium`, `low`; default `medium` |
| `answer.customer_message` | `sections.customerMessage.text` | Sanitized in stored shadow output; empty section when missing |
| `answer.escalate_decision.should_escalate` | `sections.escalation.shouldEscalate` | Boolean, default `false` |
| `answer.escalate_decision.reason` | `sections.escalation.reason` | Sanitized preview in stored shadow output |
| `answer.escalate_decision.escalation_path` | `sections.escalation.escalationPath` | Sanitized preview in stored shadow output |
| `answer.channel_recommendation` | `sections.escalation.channelRecommendation` | Preserve channel/reason as short sanitized strings |
| `answer.findings_summary.diagnosis` | `sections.diagnosis.text` | Sanitized in stored shadow output |
| `answer.agent_steps[]` | `sections.steps[]` | One contract claim per current step |
| `answer.agent_steps[].num` | `sections.steps[].num` | Numeric order |
| `answer.agent_steps[].title` | `sections.steps[].title` | Sanitized preview in stored shadow output |
| `answer.agent_steps[].detail` | `sections.steps[].detail` | Sanitized preview in stored shadow output |
| `answer.agent_steps[].tag` | `sections.steps[].tag` | `action`, `backend`, `verify`, `escalate`, or `step` |
| `answer.slack_refs[]` | `evidence[]` | Evidence records with `source: 'slack'` |
| `answer.atlassian_refs[]` | `evidence[]` | Evidence records with `source: ref.type || 'atlassian'` |
| `answer.kb_refs[]` | `evidence[]` | Evidence records with `source: 'kb'` |
| `answer.sources_used[]` | `quality.sourcesUsed` | Sanitized source names |
| `query` argument | `queryHash`, `queryPreview` | Hash always; short sanitized preview only |
| `role` argument | `role` | `csa` or `specialist` |
| `threadTs`, `channelId` | `threadTs`, `channelId` | IDs only |

Phase 1 evidence mapping is approximate:

- `quality.approximateMapping` is always `true`.
- Diagnosis maps to all direct or related evidence IDs.
- Customer message maps to safe evidence IDs only.
- Each step maps to evidence IDs by keyword overlap with integration, issue title, step title, and step detail.
- A step with no evidence IDs still appears in the contract, but is not nomination eligible in later phases.

## Task 1: Quality Flags And Privacy Helpers

**Files:**

- Create: `src/quality/config.js`
- Create: `src/quality/privacy.js`
- Modify: `.env.example`
- Modify: `test.js`

**Interfaces:**

- Produces:
  - `isQualityLayerEnabled(): boolean`
  - `isQualityShadowMode(): boolean`
  - `getQualityShadowRetention(): { maxRecords: number, maxAgeDays: number, maxBytes: number }`
  - `sanitizePreview(value: unknown, max?: number): string`
  - `hashValue(value: unknown): string`
  - `makeQualityId(prefix: string, now?: Date): string`
  - `normalizeForQuality(value: unknown): string`

- Consumes: No project-local quality modules.

- [ ] **Step 1: Add failing imports and tests**

Add these imports near the other imports in `test.js`:

```js
import { isQualityLayerEnabled, isQualityShadowMode, getQualityShadowRetention } from './src/quality/config.js';
import { sanitizePreview, hashValue, makeQualityId, normalizeForQuality } from './src/quality/privacy.js';
```

Add this test section before the final summary block in `test.js`:

```js
// ── quality config/privacy ───────────────────────────────────────────────────
console.log('\n🔹 quality config/privacy');

const originalQualityEnv = {
  QUALITY_LAYER_ENABLED: process.env.QUALITY_LAYER_ENABLED,
  QUALITY_LAYER_SHADOW_MODE: process.env.QUALITY_LAYER_SHADOW_MODE,
  QUALITY_SHADOW_MAX_RECORDS: process.env.QUALITY_SHADOW_MAX_RECORDS,
  QUALITY_SHADOW_MAX_AGE_DAYS: process.env.QUALITY_SHADOW_MAX_AGE_DAYS,
  QUALITY_SHADOW_MAX_BYTES: process.env.QUALITY_SHADOW_MAX_BYTES,
};

delete process.env.QUALITY_LAYER_ENABLED;
delete process.env.QUALITY_LAYER_SHADOW_MODE;
delete process.env.QUALITY_SHADOW_MAX_RECORDS;
delete process.env.QUALITY_SHADOW_MAX_AGE_DAYS;
delete process.env.QUALITY_SHADOW_MAX_BYTES;

assert(isQualityLayerEnabled() === false, 'quality layer defaults disabled');
assert(isQualityShadowMode() === true, 'quality shadow mode defaults true');
assert.deepEqual(getQualityShadowRetention(), {
  maxRecords: 2000,
  maxAgeDays: 14,
  maxBytes: 5 * 1024 * 1024,
}, 'quality shadow retention defaults are fixed');

process.env.QUALITY_LAYER_ENABLED = 'true';
process.env.QUALITY_LAYER_SHADOW_MODE = 'false';
process.env.QUALITY_SHADOW_MAX_RECORDS = '3';
process.env.QUALITY_SHADOW_MAX_AGE_DAYS = '2';
process.env.QUALITY_SHADOW_MAX_BYTES = '1000';

assert(isQualityLayerEnabled() === true, 'QUALITY_LAYER_ENABLED=true enables quality layer');
assert(isQualityShadowMode() === false, 'QUALITY_LAYER_SHADOW_MODE=false disables shadow mode');
assert.deepEqual(getQualityShadowRetention(), {
  maxRecords: 3,
  maxAgeDays: 2,
  maxBytes: 1000,
}, 'quality shadow retention reads env overrides');

for (const [key, value] of Object.entries(originalQualityEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

assert(sanitizePreview('  hello\\nworld  ', 20) === 'hello world', 'sanitizePreview collapses whitespace');
assert(sanitizePreview('secret '.repeat(50), 30).length <= 30, 'sanitizePreview clamps long text');
assert(!sanitizePreview('xoxb-1234567890-secret').includes('xoxb-1234567890-secret'), 'sanitizePreview redacts Slack-like tokens');
assert(hashValue('same input') === hashValue('same input'), 'hashValue is stable');
assert(hashValue('same input') !== hashValue('different input'), 'hashValue changes with input');
assert(makeQualityId('ans', new Date('2026-07-09T00:00:00.000Z')).startsWith('ans_20260709T000000000Z_'), 'makeQualityId includes prefix and timestamp');
assert(normalizeForQuality(' Zapier API   Access! ') === 'zapier api access', 'normalizeForQuality lowercases and strips punctuation');
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
node test.js
```

Expected: FAIL because `src/quality/config.js` and `src/quality/privacy.js` do not exist.

- [ ] **Step 3: Create `src/quality/config.js`**

Add:

```js
function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return String(raw).toLowerCase() !== 'false';
}

function envPositiveInt(name, defaultValue) {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function isQualityLayerEnabled() {
  return envFlag('QUALITY_LAYER_ENABLED', false);
}

export function isQualityShadowMode() {
  return envFlag('QUALITY_LAYER_SHADOW_MODE', true);
}

export function getQualityShadowRetention() {
  return {
    maxRecords: envPositiveInt('QUALITY_SHADOW_MAX_RECORDS', 2000),
    maxAgeDays: envPositiveInt('QUALITY_SHADOW_MAX_AGE_DAYS', 14),
    maxBytes: envPositiveInt('QUALITY_SHADOW_MAX_BYTES', 5 * 1024 * 1024),
  };
}
```

- [ ] **Step 4: Create `src/quality/privacy.js`**

Add:

```js
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_RE = /\b(xox[baprs]-[A-Za-z0-9-]+|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function sanitizePreview(value, max = 160) {
  const clean = String(value ?? '')
    .replace(TOKEN_RE, '[redacted-token]')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function hashValue(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

export function makeQualityId(prefix, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${prefix}_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function normalizeForQuality(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 5: Document quality flags in `.env.example`**

Add near feature flag settings:

```text
# Answer Evidence + Knowledge Quality shadow layer.
# PR 1 is metadata-only: no Slack answer UX changes and no nomination replacement.
QUALITY_LAYER_ENABLED=false
QUALITY_LAYER_SHADOW_MODE=true
QUALITY_SHADOW_MAX_RECORDS=2000
QUALITY_SHADOW_MAX_AGE_DAYS=14
QUALITY_SHADOW_MAX_BYTES=5242880
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node test.js
```

Expected: PASS with 0 failures.

Commit:

```bash
git add src/quality/config.js src/quality/privacy.js .env.example test.js docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "feat: add quality shadow config"
```

## Task 2: Source Scoring

**Files:**

- Create: `src/quality/source-scoring.js`
- Modify: `test.js`

**Interfaces:**

- Consumes:
  - `sanitizePreview(value, max)` from `src/quality/privacy.js`
  - `hashValue(value)` from `src/quality/privacy.js`
  - `classifySourceRef(ref)` from `src/slack/source-policy.js`

- Produces:
  - `refToEvidence(ref, context): object`
  - `scoreEvidenceSource(evidence, context): object`
  - `scoreEvidenceSources(refGroups, context): Array<object>`

- [ ] **Step 1: Add failing source-scoring tests**

Add this import in `test.js`:

```js
import { refToEvidence, scoreEvidenceSource, scoreEvidenceSources } from './src/quality/source-scoring.js';
```

Add this test section after the quality config/privacy tests:

```js
// ── quality source scoring ───────────────────────────────────────────────────
console.log('\n🔹 quality source scoring');

const directConfluenceEvidence = refToEvidence({
  type: 'confluence',
  url: 'https://servicetitan.atlassian.net/wiki/spaces/INT/pages/1',
  title: 'Zapier API access setup',
  snippet: 'Enable Zapier API access for the tenant.',
}, {
  source: 'confluence',
  query: 'Zapier API access disabled',
  integrationType: 'Zapier',
  issueTitle: 'Zapier API access',
});

assert(directConfluenceEvidence.source === 'confluence', 'refToEvidence keeps confluence source');
assert(directConfluenceEvidence.title === 'Zapier API access setup', 'refToEvidence keeps sanitized source title');
assert(directConfluenceEvidence.snippetPreview.includes('Enable Zapier API access'), 'refToEvidence stores snippet preview only');
assert(directConfluenceEvidence.urlHash.startsWith('sha256:'), 'refToEvidence stores URL hash');

const directScore = scoreEvidenceSource(directConfluenceEvidence, {
  query: 'Zapier API access disabled',
  integrationType: 'Zapier',
  issueTitle: 'Zapier API access',
});
assert(directScore.sourceQuality === 'high', 'direct confluence source quality high');
assert(directScore.directness === 'direct', 'exact integration and symptom is direct');
assert(directScore.reuseValue === 'high', 'setup source has high reuse value');
assert(directScore.sensitivity === 'safe', 'safe confluence source is safe');

const tenantJiraEvidence = refToEvidence({
  type: 'jira',
  url: 'https://servicetitan.atlassian.net/browse/INT-123',
  title: 'INT-123 Tenant 12345 Zapier outage',
  snippet: 'Resolved for tenant 12345 only.',
}, {
  source: 'jira',
  query: 'Zapier outage tenant 12345',
  integrationType: 'Zapier',
  issueTitle: 'Zapier outage',
});
const tenantScore = scoreEvidenceSource(tenantJiraEvidence, {
  query: 'Zapier outage tenant 12345',
  integrationType: 'Zapier',
  issueTitle: 'Zapier outage',
});
assert(tenantScore.sourceQuality === 'high', 'tenant-specific resolved Jira can be high quality');
assert(tenantScore.reuseValue === 'low', 'tenant-specific Jira has low reuse value');

const sensitiveEvidence = refToEvidence({
  type: 'jira',
  url: 'https://servicetitan.atlassian.net/browse/SEC-1',
  title: 'Security incident backend-only token rotation',
}, {
  source: 'jira',
  query: 'token issue',
  integrationType: 'Zapier',
  issueTitle: 'Token issue',
});
const sensitiveScore = scoreEvidenceSource(sensitiveEvidence, {
  query: 'token issue',
  integrationType: 'Zapier',
  issueTitle: 'Token issue',
});
assert(sensitiveScore.sensitivity === 'specialist_only', 'source scoring preserves source-policy sensitivity');

const scoredSources = scoreEvidenceSources({
  slack_refs: [{ url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#ask-integrations', title: 'Zapier API access answer' }],
  atlassian_refs: [{ type: 'confluence', url: 'https://servicetitan.atlassian.net/wiki/x', title: 'Zapier API access' }],
  kb_refs: [{ url: 'https://help.servicetitan.com/docs/zapier', title: 'Zapier help article' }],
}, {
  query: 'Zapier API access',
  integrationType: 'Zapier',
  issueTitle: 'Zapier API access',
});
assert(scoredSources.length === 3, 'scoreEvidenceSources flattens all current ref groups');
assert(scoredSources.every(e => e.id.startsWith('ev_')), 'scoreEvidenceSources assigns evidence ids');
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
node test.js
```

Expected: FAIL because `src/quality/source-scoring.js` does not exist.

- [ ] **Step 3: Create `src/quality/source-scoring.js`**

Add:

```js
import { classifySourceRef } from '../slack/source-policy.js';
import { hashValue, normalizeForQuality, sanitizePreview } from './privacy.js';

const DIRECT_WORD_MIN = 2;

function includesToken(haystack, needle) {
  const h = normalizeForQuality(haystack);
  const n = normalizeForQuality(needle);
  return Boolean(n) && h.includes(n);
}

function tokenOverlap(a, b) {
  const left = new Set(normalizeForQuality(a).split(' ').filter(w => w.length > 2));
  const right = normalizeForQuality(b).split(' ').filter(w => w.length > 2);
  return right.filter(w => left.has(w)).length;
}

function inferDirectness(text, { query, integrationType, issueTitle }) {
  const integrationMatch = includesToken(text, integrationType);
  const issueMatch = includesToken(text, issueTitle) || tokenOverlap(text, query) >= DIRECT_WORD_MIN;
  if (integrationMatch && issueMatch) return 'direct';
  if (integrationMatch || issueMatch) return 'related';
  return 'background';
}

function inferSourceQuality(source, directness, text) {
  if (directness === 'direct' && ['confluence', 'jira', 'kb'].includes(source)) return 'high';
  if (directness === 'direct' && source === 'slack') return 'medium';
  if (directness === 'related') return 'medium';
  if (/\b(resolved|confirmed|fixed|enable|setup|configuration)\b/i.test(text)) return 'medium';
  return 'low';
}

function inferReuseValue(text, source, directness) {
  if (/\b(tenant|customer|account|location)\s*#?\d+\b/i.test(text)) return 'low';
  if (/\b(incident|outage|one-off|specific customer|this tenant only)\b/i.test(text)) return 'low';
  if (directness === 'direct' && /\b(setup|enable|mapping|configuration|verify|reconnect|access)\b/i.test(text)) return 'high';
  if (source === 'jira') return 'medium';
  return directness === 'background' ? 'low' : 'medium';
}

function inferFreshness(ref) {
  const raw = ref.timestamp ?? ref.date ?? ref.updated ?? ref.created;
  if (!raw) return 'unknown';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return 'unknown';
  const ageDays = (Date.now() - ts) / 86400000;
  return ageDays > 730 ? 'stale' : 'fresh';
}

export function refToEvidence(ref, { source, query, integrationType, issueTitle }, index = 0) {
  const classified = classifySourceRef(ref ?? {});
  const title = sanitizePreview(classified.title ?? classified.url ?? source, 120);
  const snippetPreview = sanitizePreview(classified.snippet ?? classified.text ?? '', 160);
  const text = [title, snippetPreview, classified.channel, classified.type].filter(Boolean).join(' ');
  const directness = inferDirectness(text, { query, integrationType, issueTitle });
  const sensitivity = classified.sensitive === true ? 'specialist_only' : 'safe';
  const sourceName = source || classified.type || 'unknown';
  return {
    id: `ev_${index + 1}`,
    source: sourceName,
    url: sanitizePreview(classified.url ?? '', 180),
    urlHash: hashValue(classified.url ?? ''),
    title,
    snippetPreview,
    channel: sanitizePreview(classified.channel ?? '', 80),
    sourceQuality: inferSourceQuality(sourceName, directness, text),
    directness,
    freshness: inferFreshness(classified),
    sensitivity,
    reuseValue: inferReuseValue(text, sourceName, directness),
    matchedIntegration: includesToken(text, integrationType),
    matchedSymptom: includesToken(text, issueTitle) || tokenOverlap(text, query) >= DIRECT_WORD_MIN,
    reasons: [],
  };
}

export function scoreEvidenceSource(evidence, context) {
  const text = [evidence.title, evidence.snippetPreview, evidence.channel, evidence.source].filter(Boolean).join(' ');
  const directness = inferDirectness(text, context);
  return {
    ...evidence,
    directness,
    sourceQuality: inferSourceQuality(evidence.source, directness, text),
    reuseValue: inferReuseValue(text, evidence.source, directness),
    sensitivity: evidence.sensitivity ?? 'safe',
    freshness: evidence.freshness ?? 'unknown',
    matchedIntegration: includesToken(text, context.integrationType),
    matchedSymptom: includesToken(text, context.issueTitle) || tokenOverlap(text, context.query) >= DIRECT_WORD_MIN,
    reasons: [
      ...(includesToken(text, context.integrationType) ? ['integration_match'] : []),
      ...(includesToken(text, context.issueTitle) ? ['symptom_match'] : []),
      ...(directness === 'direct' ? ['direct_match'] : []),
    ],
  };
}

export function scoreEvidenceSources(refGroups = {}, context = {}) {
  const refs = [
    ...(refGroups.slack_refs ?? []).map(ref => ({ ref, source: 'slack' })),
    ...(refGroups.atlassian_refs ?? []).map(ref => ({ ref, source: ref.type === 'jira' ? 'jira' : 'confluence' })),
    ...(refGroups.kb_refs ?? []).map(ref => ({ ref, source: 'kb' })),
  ];
  return refs.map(({ ref, source }, index) =>
    scoreEvidenceSource(refToEvidence(ref, { ...context, source }, index), context),
  );
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node test.js
```

Expected: PASS with 0 failures.

Commit:

```bash
git add src/quality/source-scoring.js test.js docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "feat: score quality evidence sources"
```

## Task 3: Answer Evidence Contract Builder

**Files:**

- Create: `src/quality/evidence-contract.js`
- Modify: `test.js`

**Interfaces:**

- Consumes:
  - `makeQualityId(prefix, now)` from `src/quality/privacy.js`
  - `hashValue(value)` from `src/quality/privacy.js`
  - `sanitizePreview(value, max)` from `src/quality/privacy.js`
  - `scoreEvidenceSources(refGroups, context)` from `src/quality/source-scoring.js`

- Produces:
  - `buildAnswerEvidenceContract(args): object`
  - `isValidAnswerEvidenceContract(contract): boolean`

- [ ] **Step 1: Add failing contract tests**

Add this import in `test.js`:

```js
import { buildAnswerEvidenceContract, isValidAnswerEvidenceContract } from './src/quality/evidence-contract.js';
```

Add this test section after source-scoring tests:

```js
// ── quality evidence contract ────────────────────────────────────────────────
console.log('\n🔹 quality evidence contract');

const contractAnswer = {
  issue_title: 'Zapier API Access',
  integration_type: 'Zapier',
  confidence: 'high',
  customer_message: 'Hi [Name], Zapier API access is disabled and we are enabling it.',
  escalate_decision: { should_escalate: false, reason: 'CSA can handle this.' },
  channel_recommendation: { channel: 'ks-integration', reason: 'Known setup issue.' },
  findings_summary: { diagnosis: 'Zapier API access is disabled.', actions: ['Enable access'] },
  agent_steps: [
    { num: 1, title: 'Enable API access', detail: 'Enable Zapier API access for the tenant.', tag: 'backend' },
    { num: 2, title: 'Verify reconnect', detail: 'Ask the customer to reconnect Zapier.', tag: 'verify' },
  ],
  slack_refs: [{ url: 'https://servicetitan.slack.com/archives/C1/p1', channel: '#ask-integrations', title: 'Zapier API access fix' }],
  atlassian_refs: [{ type: 'confluence', url: 'https://servicetitan.atlassian.net/wiki/x', title: 'Zapier API access setup' }],
  kb_refs: [{ url: 'https://help.servicetitan.com/docs/zapier', title: 'Zapier API access help', snippet: 'Enable access.' }],
  sources_used: ['slack', 'confluence', 'kb'],
};

const contract = buildAnswerEvidenceContract({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  now: new Date('2026-07-09T00:00:00.000Z'),
});

assert(isValidAnswerEvidenceContract(contract), 'contract validates');
assert(contract.version === 1, 'contract version is 1');
assert(contract.mode === 'shadow', 'contract mode is shadow');
assert(contract.quality.approximateMapping === true, 'phase 1 contract marks approximate mapping');
assert(contract.queryHash.startsWith('sha256:'), 'contract stores query hash');
assert(contract.queryPreview === 'Zapier API access disabled', 'contract stores short sanitized query preview');
assert(contract.issueTitle === 'Zapier API Access', 'contract maps issue title');
assert(contract.integrationType === 'Zapier', 'contract maps integration type');
assert(contract.sections.steps.length === 2, 'contract maps each agent step');
assert(contract.sections.steps[0].id.startsWith('claim_'), 'contract creates claim ids');
assert(contract.evidence.length === 3, 'contract maps all refs to evidence');
assert(contract.evidence.every(e => e.snippet === undefined), 'contract does not store raw snippet field');
assert(contract.evidence.some(e => e.snippetPreview), 'contract stores sanitized snippetPreview when present');
assert(contract.sections.diagnosis.evidenceIds.length > 0, 'diagnosis gets approximate evidence ids');
assert(contract.sections.customerMessage.evidenceIds.every(id => contract.evidence.find(e => e.id === id)?.sensitivity === 'safe'), 'customer message maps only safe evidence ids');

const sparseContract = buildAnswerEvidenceContract({
  answer: { issue_title: 'Unknown issue', agent_steps: [] },
  query: '',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  now: new Date('2026-07-09T00:00:00.000Z'),
});
assert(isValidAnswerEvidenceContract(sparseContract), 'sparse answer still produces valid contract');
assert(sparseContract.evidence.length === 0, 'sparse answer has empty evidence');
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
node test.js
```

Expected: FAIL because `src/quality/evidence-contract.js` does not exist.

- [ ] **Step 3: Create `src/quality/evidence-contract.js`**

Add:

```js
import { hashValue, makeQualityId, normalizeForQuality, sanitizePreview } from './privacy.js';
import { scoreEvidenceSources } from './source-scoring.js';

function safeConfidence(value) {
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium';
}

function keywordOverlapScore(text, evidence) {
  const claimWords = new Set(normalizeForQuality(text).split(' ').filter(w => w.length > 2));
  const evidenceWords = normalizeForQuality([evidence.title, evidence.snippetPreview, evidence.channel].join(' '))
    .split(' ')
    .filter(w => w.length > 2);
  return evidenceWords.filter(w => claimWords.has(w)).length;
}

function evidenceIdsForText(text, evidence, { safeOnly = false } = {}) {
  const scored = evidence
    .filter(e => !safeOnly || e.sensitivity === 'safe')
    .map(e => ({ id: e.id, score: keywordOverlapScore(text, e), direct: e.directness === 'direct' }))
    .filter(e => e.score > 0 || e.direct);
  scored.sort((a, b) => Number(b.direct) - Number(a.direct) || b.score - a.score);
  return scored.slice(0, 5).map(e => e.id);
}

function trustFromEvidence(ids, evidence) {
  if (ids.length === 0) return 'unsupported';
  if (ids.some(id => evidence.find(e => e.id === id)?.directness === 'direct')) return 'direct';
  return 'partial';
}

export function buildAnswerEvidenceContract({
  answer,
  query,
  role,
  channelId,
  threadTs,
  now = new Date(),
}) {
  const issueTitle = sanitizePreview(answer?.issue_title ?? 'Integration Issue', 140);
  const integrationType = sanitizePreview(answer?.integration_type ?? 'General', 80);
  const context = { query, integrationType, issueTitle };
  const evidence = scoreEvidenceSources({
    slack_refs: answer?.slack_refs ?? [],
    atlassian_refs: answer?.atlassian_refs ?? [],
    kb_refs: answer?.kb_refs ?? [],
  }, context);

  const diagnosisText = sanitizePreview(answer?.findings_summary?.diagnosis ?? '', 300);
  const diagnosisEvidenceIds = evidenceIdsForText(`${issueTitle} ${diagnosisText}`, evidence);
  const customerText = sanitizePreview(answer?.customer_message ?? '', 300);
  const customerEvidenceIds = evidenceIdsForText(`${issueTitle} ${customerText}`, evidence, { safeOnly: true });
  const escalationReason = sanitizePreview(answer?.escalate_decision?.reason ?? '', 220);
  const escalationEvidenceIds = evidenceIdsForText(`${issueTitle} ${escalationReason}`, evidence);

  const steps = (answer?.agent_steps ?? []).map((step, index) => {
    const text = `${step.title ?? ''} ${step.detail ?? ''}`;
    const evidenceIds = evidenceIdsForText(text, evidence);
    const tag = ['action', 'backend', 'verify', 'escalate'].includes(step.tag) ? step.tag : 'step';
    return {
      id: `claim_${index + 1}`,
      num: Number.isFinite(step.num) ? step.num : index + 1,
      title: sanitizePreview(step.title ?? tag, 120),
      detail: sanitizePreview(step.detail ?? '', 300),
      tag,
      evidenceIds,
      trust: trustFromEvidence(evidenceIds, evidence),
      reusable: false,
      tenantSpecific: /\b(tenant|customer|account|location)\s*#?\d+\b/i.test(`${step.title ?? ''} ${step.detail ?? ''}`),
      nominationEligible: false,
    };
  });

  const answerId = makeQualityId('ans', now);

  return {
    version: 1,
    answerId,
    createdAt: now.toISOString(),
    mode: 'shadow',
    queryHash: hashValue(query ?? ''),
    queryPreview: sanitizePreview(query ?? '', 120),
    role: role === 'specialist' ? 'specialist' : 'csa',
    channelId: sanitizePreview(channelId ?? '', 80),
    threadTs: sanitizePreview(threadTs ?? '', 80),
    issueTitle,
    integrationType,
    confidence: safeConfidence(answer?.confidence),
    confidenceReason: sanitizePreview(`current answer confidence: ${safeConfidence(answer?.confidence)}`, 120),
    sections: {
      diagnosis: {
        text: diagnosisText,
        evidenceIds: diagnosisEvidenceIds,
        trust: trustFromEvidence(diagnosisEvidenceIds, evidence),
      },
      customerMessage: {
        text: customerText,
        evidenceIds: customerEvidenceIds,
        trust: trustFromEvidence(customerEvidenceIds, evidence),
      },
      escalation: {
        shouldEscalate: answer?.escalate_decision?.should_escalate === true,
        reason: escalationReason,
        escalationPath: sanitizePreview(answer?.escalate_decision?.escalation_path ?? '', 120) || null,
        channelRecommendation: {
          channel: sanitizePreview(answer?.channel_recommendation?.channel ?? '', 80),
          reason: sanitizePreview(answer?.channel_recommendation?.reason ?? '', 160),
        },
        evidenceIds: escalationEvidenceIds,
        trust: trustFromEvidence(escalationEvidenceIds, evidence),
      },
      steps,
    },
    evidence,
    quality: {
      directAnswer: evidence.some(e => e.directness === 'direct'),
      reusableKnowledge: false,
      nominationEligible: false,
      approximateMapping: true,
      sourcesUsed: (answer?.sources_used ?? []).map(s => sanitizePreview(s, 40)).filter(Boolean),
      reasons: ['shadow_mode', 'approximate_mapping'],
    },
  };
}

export function isValidAnswerEvidenceContract(contract) {
  return contract?.version === 1 &&
    contract.mode === 'shadow' &&
    typeof contract.answerId === 'string' &&
    typeof contract.queryHash === 'string' &&
    Array.isArray(contract.evidence) &&
    Array.isArray(contract.sections?.steps) &&
    contract.quality?.approximateMapping === true;
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node test.js
```

Expected: PASS with 0 failures.

Commit:

```bash
git add src/quality/evidence-contract.js test.js docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "feat: build shadow answer evidence contracts"
```

## Task 4: Bounded Shadow Store And Audit Log

**Files:**

- Create: `src/quality/shadow-store.js`
- Create: `src/quality/audit-log.js`
- Modify: `test.js`

**Interfaces:**

- Consumes:
  - `getQualityShadowRetention()` from `src/quality/config.js`
  - `hashValue(value)` and `sanitizePreview(value, max)` from `src/quality/privacy.js`

- Produces:
  - `appendQualityShadowRecord(record, options?): Promise<object>`
  - `_setQualityShadowFileForTest(path): void`
  - `appendQualityAuditEvent(event, options?): Promise<object>`
  - `_setQualityAuditFileForTest(path): void`

- [ ] **Step 1: Add failing storage/audit tests**

Add this import block in `test.js`:

```js
import { appendQualityShadowRecord, _setQualityShadowFileForTest } from './src/quality/shadow-store.js';
import { appendQualityAuditEvent, _setQualityAuditFileForTest } from './src/quality/audit-log.js';
```

Add this test section after evidence contract tests:

```js
// ── quality shadow storage/audit ─────────────────────────────────────────────
console.log('\n🔹 quality shadow storage/audit');

const qualityTempDir = await mkdtemp(join(tmpdir(), 'intbot-quality-'));
const shadowFile = join(qualityTempDir, 'quality-shadow.jsonl');
const auditFile = join(qualityTempDir, 'quality-audit.jsonl');
_setQualityShadowFileForTest(shadowFile);
_setQualityAuditFileForTest(auditFile);

for (let i = 0; i < 5; i += 1) {
  await appendQualityShadowRecord({
    createdAt: new Date(Date.UTC(2026, 6, 9, 0, 0, i)).toISOString(),
    answerId: `ans_${i}`,
    queryPreview: `customer email user${i}@example.com token xoxb-secret-${i}`,
    evidence: [{ title: `Source ${i}`, snippetPreview: 'raw source body '.repeat(50) }],
  }, {
    retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
    now: new Date('2026-07-09T00:01:00.000Z'),
  });
}

const shadowLines = (await readFile(shadowFile, 'utf-8')).trim().split('\n');
assert(shadowLines.length === 3, 'quality shadow store enforces maxRecords retention');
const shadowJson = shadowLines.join('\n');
assert(!shadowJson.includes('user4@example.com'), 'quality shadow store redacts emails');
assert(!shadowJson.includes('xoxb-secret'), 'quality shadow store redacts Slack-like tokens');
assert(!shadowJson.includes('raw source body raw source body raw source body'), 'quality shadow store avoids large raw snippets');

await appendQualityAuditEvent({
  type: 'contract_created',
  actor: { type: 'bot', userId: 'U123', name: 'Bot User' },
  entity: { type: 'answer_contract', id: 'ans_1' },
  metadata: {
    query: 'Full customer query should become hash/preview only',
    integrationType: 'Zapier',
    reason: 'direct_source_match',
  },
}, { now: new Date('2026-07-09T00:00:00.000Z') });

const auditText = await readFile(auditFile, 'utf-8');
assert(auditText.includes('contract_created'), 'quality audit stores event type');
assert(auditText.includes('queryHash'), 'quality audit stores query hash');
assert(!auditText.includes('Full customer query should become hash/preview only'), 'quality audit does not store raw query');

await rm(qualityTempDir, { recursive: true, force: true });
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
node test.js
```

Expected: FAIL because storage/audit modules do not exist.

- [ ] **Step 3: Create `src/quality/shadow-store.js`**

Add:

```js
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getQualityShadowRetention } from './config.js';
import { hashValue, sanitizePreview } from './privacy.js';

let _shadowFile = join(process.cwd(), 'data', 'quality-shadow.jsonl');
let _writeQueue = Promise.resolve();

export function _setQualityShadowFileForTest(path) {
  _shadowFile = path;
  _writeQueue = Promise.resolve();
}

function sanitizeEvidence(evidence = []) {
  return evidence.slice(0, 10).map((e) => ({
    id: sanitizePreview(e.id, 40),
    source: sanitizePreview(e.source, 40),
    urlHash: e.urlHash ?? hashValue(e.url ?? ''),
    title: sanitizePreview(e.title, 120),
    snippetPreview: sanitizePreview(e.snippetPreview, 80),
    sourceQuality: e.sourceQuality,
    directness: e.directness,
    freshness: e.freshness,
    sensitivity: e.sensitivity,
    reuseValue: e.reuseValue,
    reasons: (e.reasons ?? []).slice(0, 8).map(r => sanitizePreview(r, 40)),
  }));
}

function sanitizeShadowRecord(record) {
  return {
    createdAt: record.createdAt ?? new Date().toISOString(),
    answerId: sanitizePreview(record.answerId, 80),
    queryHash: record.queryHash ?? hashValue(record.queryPreview ?? ''),
    queryPreview: sanitizePreview(record.queryPreview, 120),
    role: sanitizePreview(record.role, 20),
    channelId: sanitizePreview(record.channelId, 80),
    threadTs: sanitizePreview(record.threadTs, 80),
    issueTitle: sanitizePreview(record.issueTitle, 140),
    integrationType: sanitizePreview(record.integrationType, 80),
    confidence: record.confidence,
    evidence: sanitizeEvidence(record.evidence),
    quality: {
      directAnswer: record.quality?.directAnswer === true,
      reusableKnowledge: record.quality?.reusableKnowledge === true,
      nominationEligible: record.quality?.nominationEligible === true,
      approximateMapping: record.quality?.approximateMapping === true,
      reasons: (record.quality?.reasons ?? []).slice(0, 8).map(r => sanitizePreview(r, 40)),
    },
  };
}

async function readRecords(file) {
  try {
    const text = await readFile(file, 'utf-8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function pruneRecords(records, retention, now) {
  const cutoff = now.getTime() - retention.maxAgeDays * 86400000;
  const byAge = records.filter((record) => {
    const ts = Date.parse(record.createdAt ?? '');
    return Number.isFinite(ts) && ts >= cutoff;
  });
  return byAge.slice(-retention.maxRecords);
}

async function writeJsonlAtomic(file, records) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  await writeFile(tmp, body);
  await rename(tmp, file);
}

async function enforceByteLimit(file, retention, now) {
  try {
    const info = await stat(file);
    if (info.size <= retention.maxBytes) return;
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  let records = await readRecords(file);
  do {
    records = records.slice(Math.ceil(records.length / 4));
    await writeJsonlAtomic(file, pruneRecords(records, retention, now));
    const info = await stat(file);
    if (info.size <= retention.maxBytes || records.length <= 1) break;
  } while (records.length > 1);
}

export function appendQualityShadowRecord(record, { retention = getQualityShadowRetention(), now = new Date() } = {}) {
  const sanitized = sanitizeShadowRecord(record);
  _writeQueue = _writeQueue.then(async () => {
    const records = pruneRecords([...(await readRecords(_shadowFile)), sanitized], retention, now);
    await writeJsonlAtomic(_shadowFile, records);
    await enforceByteLimit(_shadowFile, retention, now);
    return sanitized;
  });
  return _writeQueue;
}
```

- [ ] **Step 4: Create `src/quality/audit-log.js`**

Add:

```js
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashValue, makeQualityId, sanitizePreview } from './privacy.js';

let _auditFile = join(process.cwd(), 'data', 'quality-audit.jsonl');
let _auditQueue = Promise.resolve();

export function _setQualityAuditFileForTest(path) {
  _auditFile = path;
  _auditQueue = Promise.resolve();
}

function sanitizeAuditEvent(event, now) {
  const query = event.metadata?.query ?? event.metadata?.queryPreview ?? '';
  return {
    id: event.id ?? makeQualityId('qa', now),
    timestamp: event.timestamp ?? now.toISOString(),
    type: sanitizePreview(event.type, 80),
    actor: {
      type: sanitizePreview(event.actor?.type ?? 'bot', 40),
      userId: sanitizePreview(event.actor?.userId ?? '', 80) || null,
      name: sanitizePreview(event.actor?.name ?? '', 80) || null,
    },
    entity: {
      type: sanitizePreview(event.entity?.type ?? '', 80),
      id: sanitizePreview(event.entity?.id ?? '', 120),
    },
    metadata: {
      queryHash: query ? hashValue(query) : event.metadata?.queryHash,
      queryPreview: query ? sanitizePreview(query, 80) : sanitizePreview(event.metadata?.queryPreview ?? '', 80),
      integrationType: sanitizePreview(event.metadata?.integrationType ?? '', 80),
      nominationEligible: event.metadata?.nominationEligible === true,
      approximateMapping: event.metadata?.approximateMapping === true,
      reason: sanitizePreview(event.metadata?.reason ?? '', 80),
      reasons: (event.metadata?.reasons ?? []).slice(0, 8).map(r => sanitizePreview(r, 40)),
    },
  };
}

export function appendQualityAuditEvent(event, { now = new Date() } = {}) {
  const sanitized = sanitizeAuditEvent(event, now);
  _auditQueue = _auditQueue.then(async () => {
    await mkdir(dirname(_auditFile), { recursive: true });
    await appendFile(_auditFile, `${JSON.stringify(sanitized)}\n`);
    return sanitized;
  });
  return _auditQueue;
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node test.js
```

Expected: PASS with 0 failures.

Commit:

```bash
git add src/quality/shadow-store.js src/quality/audit-log.js test.js docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "feat: store bounded quality shadow metadata"
```

## Task 5: Shadow Recorder And Mention Integration

**Files:**

- Create: `src/quality/shadow-recorder.js`
- Modify: `src/handlers/mention.js`
- Modify: `test.js`

**Interfaces:**

- Consumes:
  - `isQualityLayerEnabled()` from `src/quality/config.js`
  - `isQualityShadowMode()` from `src/quality/config.js`
  - `buildAnswerEvidenceContract(args)` from `src/quality/evidence-contract.js`
  - `appendQualityShadowRecord(record)` from `src/quality/shadow-store.js`
  - `appendQualityAuditEvent(event)` from `src/quality/audit-log.js`

- Produces:
  - `recordQualityShadow(args): Promise<{ status: string, contract?: object, error?: string }>`

- [ ] **Step 1: Add failing recorder tests**

Add this import in `test.js`:

```js
import { recordQualityShadow } from './src/quality/shadow-recorder.js';
```

Add this test section after storage/audit tests:

```js
// ── quality shadow recorder ──────────────────────────────────────────────────
console.log('\n🔹 quality shadow recorder');

const recorderTempDir = await mkdtemp(join(tmpdir(), 'intbot-quality-recorder-'));
_setQualityShadowFileForTest(join(recorderTempDir, 'shadow.jsonl'));
_setQualityAuditFileForTest(join(recorderTempDir, 'audit.jsonl'));

const oldQualityLayerEnabled = process.env.QUALITY_LAYER_ENABLED;
const oldQualityShadowMode = process.env.QUALITY_LAYER_SHADOW_MODE;

process.env.QUALITY_LAYER_ENABLED = 'false';
process.env.QUALITY_LAYER_SHADOW_MODE = 'true';
const disabledRecord = await recordQualityShadow({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  logger: console,
});
assert(disabledRecord.status === 'disabled', 'recordQualityShadow skips when quality layer disabled');

process.env.QUALITY_LAYER_ENABLED = 'true';
process.env.QUALITY_LAYER_SHADOW_MODE = 'true';
const recorded = await recordQualityShadow({
  answer: contractAnswer,
  query: 'Zapier API access disabled',
  role: 'csa',
  channelId: 'C123',
  threadTs: '1700000000.000',
  logger: console,
  now: new Date('2026-07-09T00:00:00.000Z'),
});
assert(recorded.status === 'recorded', 'recordQualityShadow records in shadow mode');
assert(recorded.contract?.quality?.approximateMapping === true, 'recordQualityShadow returns approximate contract');

process.env.QUALITY_LAYER_ENABLED = oldQualityLayerEnabled ?? '';
if (oldQualityLayerEnabled === undefined) delete process.env.QUALITY_LAYER_ENABLED;
process.env.QUALITY_LAYER_SHADOW_MODE = oldQualityShadowMode ?? '';
if (oldQualityShadowMode === undefined) delete process.env.QUALITY_LAYER_SHADOW_MODE;

await rm(recorderTempDir, { recursive: true, force: true });
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
node test.js
```

Expected: FAIL because `src/quality/shadow-recorder.js` does not exist.

- [ ] **Step 3: Create `src/quality/shadow-recorder.js`**

Add:

```js
import { isQualityLayerEnabled, isQualityShadowMode } from './config.js';
import { buildAnswerEvidenceContract } from './evidence-contract.js';
import { appendQualityAuditEvent } from './audit-log.js';
import { appendQualityShadowRecord } from './shadow-store.js';

export async function recordQualityShadow({
  answer,
  query,
  role,
  channelId,
  threadTs,
  logger = console,
  now = new Date(),
}) {
  if (!isQualityLayerEnabled()) return { status: 'disabled' };
  if (!isQualityShadowMode()) return { status: 'not_shadow_mode' };

  try {
    const contract = buildAnswerEvidenceContract({ answer, query, role, channelId, threadTs, now });
    await appendQualityShadowRecord(contract, { now });
    await appendQualityAuditEvent({
      type: 'contract_created',
      actor: { type: 'bot' },
      entity: { type: 'answer_contract', id: contract.answerId },
      metadata: {
        queryHash: contract.queryHash,
        queryPreview: contract.queryPreview,
        integrationType: contract.integrationType,
        nominationEligible: contract.quality.nominationEligible,
        approximateMapping: contract.quality.approximateMapping,
        reasons: contract.quality.reasons,
      },
    }, { now });
    return { status: 'recorded', contract };
  } catch (err) {
    logger?.warn?.(`[quality] shadow record failed: ${err.message}`);
    return { status: 'failed_open', error: err.message };
  }
}
```

- [ ] **Step 4: Wire the mention handler without changing Slack output**

In `src/handlers/mention.js`, add this import:

```js
import { recordQualityShadow } from '../quality/shadow-recorder.js';
```

In the new-pipeline branch, immediately after the `appendToHistory(threadTs, [...])` call and before the existing `const KNOWLEDGE_MIN_MS_PIPE = ...` nomination block, add:

```js
    recordQualityShadow({
      answer: pipelineResult,
      query,
      role,
      channelId,
      threadTs,
      logger: console,
    }).catch((err) => console.warn('[quality] shadow record failed:', err.message));
```

In the legacy branch, immediately after the `appendToHistory(threadTs, [...])` call and before the existing `const KNOWLEDGE_MIN_MS = ...` nomination block, add:

```js
  recordQualityShadow({
    answer: result,
    query,
    role,
    channelId,
    threadTs,
    logger: console,
  }).catch((err) => console.warn('[quality] shadow record failed:', err.message));
```

Do not modify any existing `buildResponseBlocks`, `chat.update`, `chat.postMessage`, cache, or nomination condition logic.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node test.js
```

Expected: PASS with 0 failures.

Commit:

```bash
git add src/quality/shadow-recorder.js src/handlers/mention.js test.js docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "feat: record quality shadow metadata"
```

## Task 6: PR 1 Verification And Documentation

**Files:**

- Modify: `docs/functionality-overview.md`
- Modify: `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Interfaces:**

- Consumes:
  - All modules created in Tasks 1-5.

- Produces:
  - A documented PR 1 shadow-mode behavior summary.

- [ ] **Step 1: Update functionality overview**

Add a short section to `docs/functionality-overview.md` under health/monitoring or knowledge lifecycle:

```md
### Answer Evidence quality shadow layer
- **What:** Optional shadow-mode metadata layer that maps current answers and refs into an internal evidence contract.
- **Default:** Disabled unless `QUALITY_LAYER_ENABLED=true`.
- **Safety:** Fail-open. If metadata recording fails, the Slack answer and existing nomination behavior continue unchanged.
- **Storage:** Sanitized bounded JSONL under `data/quality-shadow.jsonl`; no full raw snippets, secrets, PII, or large customer payloads.
- **Current limitation:** PR 1 evidence mappings are approximate; long-term answerer output may emit explicit evidence IDs.
```

- [ ] **Step 2: Update execution log**

Append an entry for each completed task with:

```md
## 2026-07-09 - PR 1 Shadow Mode Implementation

**Intent:** Implement the first low-risk slice of the Answer Evidence + Knowledge Quality layer.

**Action Taken:** Added quality flags, privacy helpers, source scoring, evidence contract mapping, bounded shadow storage, audit logging, and fail-open mention-handler recording behind feature flags.

**Files Touched:**

- `src/quality/config.js`
- `src/quality/privacy.js`
- `src/quality/source-scoring.js`
- `src/quality/evidence-contract.js`
- `src/quality/shadow-store.js`
- `src/quality/audit-log.js`
- `src/quality/shadow-recorder.js`
- `src/handlers/mention.js`
- `.env.example`
- `test.js`
- `docs/functionality-overview.md`

**Verification:** `node test.js` passed with 0 failures.

**Decision / Follow-up:** PR 1 remains shadow-mode only. PR 2 should add shadow claim-level nomination policy without replacing live nominations.
```

- [ ] **Step 3: Run final verification**

Run:

```bash
node test.js
git status --short --branch
```

Expected:

- `node test.js` reports 0 failures.
- `git status --short --branch` shows only intended PR 1 files modified and no unrelated tracked changes.

- [ ] **Step 4: Commit documentation**

Commit:

```bash
git add docs/functionality-overview.md docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "docs: document quality shadow mode"
```

## Rollout Steps For PR 1

1. Merge with `QUALITY_LAYER_ENABLED=false` in production.
2. Deploy with default disabled behavior.
3. Enable in a controlled environment:

```text
QUALITY_LAYER_ENABLED=true
QUALITY_LAYER_SHADOW_MODE=true
QUALITY_SHADOW_MAX_RECORDS=2000
QUALITY_SHADOW_MAX_AGE_DAYS=14
QUALITY_SHADOW_MAX_BYTES=5242880
```

4. Ask several normal questions in Slack.
5. Confirm answers look identical to pre-rollout behavior.
6. Confirm `data/quality-shadow.jsonl` contains sanitized metadata only.
7. Confirm `data/quality-audit.jsonl` contains `contract_created` events only.
8. Disable `QUALITY_LAYER_ENABLED` immediately if any unexpected quality-layer warning appears frequently.

## Rollback Steps For PR 1

1. Set:

```text
QUALITY_LAYER_ENABLED=false
```

2. Restart the app.
3. Leave `data/quality-shadow.jsonl` and `data/quality-audit.jsonl` on disk; they are not read by the answer path when the layer is disabled.
4. If needed, remove the data files manually after confirming no investigation needs them.

## Self-Review Checklist For Implementer

- [ ] No Slack answer card copy, layout, blocks, or buttons changed.
- [ ] No answerer prompt changes.
- [ ] No nomination replacement.
- [ ] Every quality-layer call is behind `QUALITY_LAYER_ENABLED`.
- [ ] Every quality-layer failure is fail-open for answering.
- [ ] Shadow records do not include full raw snippets, PII, secrets, request headers, full prompts, or large payloads.
- [ ] Retention policy is implemented before any PR 1 shadow write.
- [ ] `node test.js` passes with 0 failures.
