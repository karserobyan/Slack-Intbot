# Privacy-Safe Step Coverage Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PR 1.1 count-only shadow metrics that measure how current answer steps map to evidence, without changing user-visible Slack behavior or persisting step/source/customer prose.

**Architecture:** Keep the trust boundary in `src/quality/shadow-store.js`: persistent JSONL records must derive `quality.stepCoverage` from `record.sections.steps` and sanitized evidence IDs, not trust caller-supplied count fields. `src/quality/evidence-contract.js` may expose a small pure helper if needed, but no new module is required unless duplication appears during implementation. The change remains shadow-only, fail-open through the existing recorder path, and does not affect Slack cards, prompts, nominations, approvals, `knowledge.md`, or any database.

**Tech Stack:** Node.js ESM, plain `assert` tests in `test.js`, file-backed JSONL shadow storage under `data/quality-shadow.jsonl`.

## Global Constraints

- PR 1.1 is shadow-only instrumentation.
- Do not change Slack card layout, answer text, buttons, action IDs, source chips, prompts, nominations, approval flow, or `knowledge.md`.
- Do not add a database or durable review store.
- Keep production disabled by default with `QUALITY_LAYER_ENABLED=false`.
- Persist only count metrics: `stepCount`, `mappedStepCount`, `directMappedStepCount`, `unsupportedStepCount`.
- Do not persist step titles, step details, step tags, diagnosis/customer/escalation prose, source titles, source snippets, raw queries, raw URLs, new free-form reason strings, prompts, request headers, or payloads.
- Do not trust caller-supplied count fields; derive or validate counts from actual contract steps and evidence records.
- Required invariants: `mappedStepCount + unsupportedStepCount === stepCount`, `directMappedStepCount <= mappedStepCount`, and all values are non-negative integers.
- Zero-step answers produce four zero values.
- Run `node test.js` before commit; it must report `744 passed, 0 failed` or the updated full-suite total with `0 failed`.

---

## Scope Check

This plan covers PR 1.1 only: privacy-safe step coverage instrumentation for existing shadow metadata. It does not start PR 2, does not create claim-level nomination policy, and does not change any live product behavior.

## File Map

### Modify

- `src/quality/shadow-store.js`
  - Add the count derivation at the persistence trust boundary.
  - Persist the derived object under `quality.stepCoverage`.
  - Ignore any caller-supplied `record.quality.stepCoverage` or similarly named count fields.

- `test.js`
  - Add targeted tests in the existing `quality shadow storage/audit` section.
  - Keep the tests close to current shadow persistence privacy tests.

- `docs/superpowers/specs/2026-07-09-answer-evidence-knowledge-quality-design.md`
  - Update the persistent shadow schema example and success-measurement section to include count-only step coverage metrics.

- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`
  - Record PR 1.1 implementation, verification, controlled rollout harness rerun result, and whether the instrumentation gap is closed.

### Do Not Modify

- `src/handlers/mention.js`
- `src/slack/blocks.js`
- `src/slack/nominations.js`
- `src/slack/review-actions.js`
- `src/slack/knowledge-writer.js`
- `src/claude/*` prompts or answerer code
- `knowledge.md`

## Interfaces

### Persisted Shape

```js
quality: {
  directAnswer: boolean,
  reusableKnowledge: boolean,
  nominationEligible: boolean,
  approximateMapping: boolean,
  reasons: string[],
  stepCoverage: {
    stepCount: number,
    mappedStepCount: number,
    directMappedStepCount: number,
    unsupportedStepCount: number,
  },
}
```

### Derivation Semantics

```js
function deriveStepCoverage(record) {
  const steps = Array.isArray(record?.sections?.steps) ? record.sections.steps : [];
  const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
  const evidenceById = new Map(
    evidence
      .filter((item) => typeof item?.id === 'string' && item.id)
      .map((item) => [item.id, item]),
  );

  let mappedStepCount = 0;
  let directMappedStepCount = 0;

  for (const step of steps) {
    const uniqueIds = [...new Set(Array.isArray(step?.evidenceIds) ? step.evidenceIds : [])];
    const resolved = uniqueIds
      .map((id) => evidenceById.get(id))
      .filter(Boolean);

    if (resolved.length === 0) continue;
    mappedStepCount += 1;
    if (resolved.some((item) => item.directness === 'direct')) {
      directMappedStepCount += 1;
    }
  }

  const stepCount = steps.length;
  const unsupportedStepCount = stepCount - mappedStepCount;

  return {
    stepCount,
    mappedStepCount,
    directMappedStepCount,
    unsupportedStepCount,
  };
}
```

Keep this helper private inside `shadow-store.js` unless another file genuinely needs it. If exported for tests, prefix with a test/internal name such as `_deriveStepCoverageForTest`, but prefer testing through `appendQualityShadowRecord` so the persistence boundary is exercised.

## Task 1: Persist Derived Step Coverage Counts

**Files:**

- Modify: `src/quality/shadow-store.js`
- Modify: `test.js`

**Interfaces:**

- Consumes: `record.sections.steps[]`, `record.sections.steps[].evidenceIds[]`, and `record.evidence[]`.
- Produces: `quality.stepCoverage` in persisted shadow JSONL records.

- [ ] **Step 1: Add failing tests for zero, mapped, partial, direct, dangling, duplicate, hostile, and privacy behavior**

Add these tests in `test.js` immediately after the existing sensitive shadow persistence assertions and before the failed-append test:

```js
const stepCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage.jsonl');
_setQualityShadowFileForTest(stepCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:00.000Z',
  answerId: 'ans_step_coverage',
  confidence: 'high',
  evidence: [
    { id: 'ev_direct', source: 'confluence', directness: 'direct', sourceQuality: 'high' },
    { id: 'ev_related', source: 'slack', directness: 'related', sourceQuality: 'medium' },
    { id: 'ev_background', source: 'kb', directness: 'background', sourceQuality: 'low' },
  ],
  sections: {
    steps: [
      { id: 'claim_1', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: ['ev_direct'] },
      { id: 'claim_2', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: ['ev_related', 'ev_related'] },
      { id: 'claim_3', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: ['ev_missing'] },
      { id: 'claim_4', title: 'Do not persist title', detail: 'Do not persist detail', evidenceIds: [] },
    ],
  },
  quality: {
    directAnswer: true,
    reusableKnowledge: true,
    nominationEligible: true,
    approximateMapping: true,
    reasons: ['shadow_mode'],
    stepCoverage: {
      stepCount: 999,
      mappedStepCount: 999,
      directMappedStepCount: 999,
      unsupportedStepCount: 999,
    },
  },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:00.000Z'),
});
const stepCoverageText = await readFile(stepCoverageFile, 'utf-8');
const stepCoverageRecord = JSON.parse(stepCoverageText.trim());
assert.deepEqual(stepCoverageRecord.quality.stepCoverage, {
  stepCount: 4,
  mappedStepCount: 2,
  directMappedStepCount: 1,
  unsupportedStepCount: 2,
}, 'quality shadow store derives step coverage from valid evidence mappings');
assert(stepCoverageRecord.quality.stepCoverage.mappedStepCount + stepCoverageRecord.quality.stepCoverage.unsupportedStepCount === stepCoverageRecord.quality.stepCoverage.stepCount, 'step coverage invariant mapped + unsupported equals total');
assert(stepCoverageRecord.quality.stepCoverage.directMappedStepCount <= stepCoverageRecord.quality.stepCoverage.mappedStepCount, 'step coverage invariant direct mapped is bounded by mapped');
assert(!stepCoverageText.includes('Do not persist title'), 'step coverage persistence omits step titles');
assert(!stepCoverageText.includes('Do not persist detail'), 'step coverage persistence omits step details');
assert(!stepCoverageText.includes('ev_missing'), 'step coverage persistence does not persist dangling evidence ids from steps');
assert(!stepCoverageText.includes('999'), 'step coverage persistence ignores hostile caller-supplied counts');

const zeroStepCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-zero.jsonl');
_setQualityShadowFileForTest(zeroStepCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:01.000Z',
  answerId: 'ans_zero_steps',
  evidence: [{ id: 'ev_direct', source: 'kb', directness: 'direct' }],
  sections: { steps: [] },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:01.000Z'),
});
const zeroStepCoverageRecord = JSON.parse((await readFile(zeroStepCoverageFile, 'utf-8')).trim());
assert.deepEqual(zeroStepCoverageRecord.quality.stepCoverage, {
  stepCount: 0,
  mappedStepCount: 0,
  directMappedStepCount: 0,
  unsupportedStepCount: 0,
}, 'zero-step answers persist zero step coverage counts');

const allMappedStepCoverageFile = join(qualityTempDir, 'quality-shadow-step-coverage-all-mapped.jsonl');
_setQualityShadowFileForTest(allMappedStepCoverageFile);
await appendQualityShadowRecord({
  createdAt: '2026-07-14T00:00:02.000Z',
  answerId: 'ans_all_mapped_steps',
  evidence: [
    { id: 'ev_direct', source: 'confluence', directness: 'direct' },
    { id: 'ev_background', source: 'kb', directness: 'background' },
  ],
  sections: {
    steps: [
      { id: 'claim_1', evidenceIds: ['ev_direct'] },
      { id: 'claim_2', evidenceIds: ['ev_background'] },
    ],
  },
  quality: { approximateMapping: true, reasons: ['shadow_mode'] },
}, {
  retention: { maxRecords: 3, maxAgeDays: 14, maxBytes: 20000 },
  now: new Date('2026-07-14T00:00:02.000Z'),
});
const allMappedStepCoverageRecord = JSON.parse((await readFile(allMappedStepCoverageFile, 'utf-8')).trim());
assert.deepEqual(allMappedStepCoverageRecord.quality.stepCoverage, {
  stepCount: 2,
  mappedStepCount: 2,
  directMappedStepCount: 1,
  unsupportedStepCount: 0,
}, 'all mapped steps count as mapped while only direct evidence counts as direct mapped');
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node test.js
```

Expected: fail in the `quality shadow storage/audit` section because `quality.stepCoverage` is not yet persisted.

- [ ] **Step 3: Implement private count derivation in `src/quality/shadow-store.js`**

Add this helper near the other private sanitizer helpers:

```js
const MAX_STEP_COVERAGE_COUNT = 1000;

function boundedCount(value) {
  return Math.min(Math.max(value, 0), MAX_STEP_COVERAGE_COUNT);
}

function deriveStepCoverage(record = {}) {
  const steps = Array.isArray(record.sections?.steps) ? record.sections.steps : [];
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  const evidenceById = new Map(
    evidence
      .filter((item) => typeof item?.id === 'string' && item.id)
      .map((item) => [item.id, item]),
  );

  let mappedStepCount = 0;
  let directMappedStepCount = 0;

  for (const step of steps) {
    const ids = Array.isArray(step?.evidenceIds) ? step.evidenceIds : [];
    const resolved = [...new Set(ids)]
      .map((id) => evidenceById.get(id))
      .filter(Boolean);

    if (resolved.length === 0) continue;
    mappedStepCount += 1;
    if (resolved.some((item) => item.directness === 'direct')) {
      directMappedStepCount += 1;
    }
  }

  const stepCount = boundedCount(steps.length);
  mappedStepCount = boundedCount(Math.min(mappedStepCount, stepCount));
  directMappedStepCount = boundedCount(Math.min(directMappedStepCount, mappedStepCount));
  const unsupportedStepCount = boundedCount(stepCount - mappedStepCount);

  return {
    stepCount,
    mappedStepCount,
    directMappedStepCount,
    unsupportedStepCount,
  };
}
```

Then update the persisted `quality` object in `sanitizeShadowRecord`:

```js
quality: {
  directAnswer: record.quality?.directAnswer === true,
  reusableKnowledge: record.quality?.reusableKnowledge === true,
  nominationEligible: record.quality?.nominationEligible === true,
  approximateMapping: record.quality?.approximateMapping === true,
  reasons: safeReasonCodes(record.quality?.reasons),
  stepCoverage: deriveStepCoverage(record),
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node test.js
```

Expected: all tests pass with `0 failed`.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/quality/shadow-store.js test.js
git commit -m "feat: add privacy-safe step coverage metrics"
```

## Task 2: Update Schema Docs And Execution Log

**Files:**

- Modify: `docs/superpowers/specs/2026-07-09-answer-evidence-knowledge-quality-design.md`
- Modify: `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Interfaces:**

- Consumes: persisted `quality.stepCoverage` object from Task 1.
- Produces: traceable docs that describe the count-only schema and validation result.

- [ ] **Step 1: Update the design spec persisted schema**

In `docs/superpowers/specs/2026-07-09-answer-evidence-knowledge-quality-design.md`, update the `data/quality-shadow.jsonl` storage description to explicitly allow `quality.stepCoverage` as count-only metadata:

```md
  - `quality.stepCoverage`
    - `stepCount`
    - `mappedStepCount`
    - `directMappedStepCount`
    - `unsupportedStepCount`
  - These are derived by the shadow serializer from `sections.steps[].evidenceIds` and `evidence[].id`.
  - Do not persist step text, step tags, dangling evidence IDs, or source prose for this metric.
```

Also update the success-measurement section so the previously missing step metrics are now measurable:

```md
- Step coverage counts:
  - total answer steps
  - steps with valid evidence mappings
  - steps with direct evidence mappings
  - unsupported steps
```

- [ ] **Step 2: Update the execution log**

Append a PR 1.1 entry to `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`:

```md
## 2026-07-14 - PR 1.1 Step Coverage Instrumentation

**Intent:** Close the PR 1 controlled-rollout instrumentation gap with count-only step coverage metrics.

**Action Taken:** Added serializer-derived `quality.stepCoverage` counts to shadow JSONL persistence. Counts are derived from valid `sections.steps[].evidenceIds` references to `evidence[].id`, ignore dangling/duplicate IDs, and ignore hostile caller-supplied count values. No Slack UX, prompt, nomination, approval, `knowledge.md`, or database behavior changed.

**Files Touched:**

- `src/quality/shadow-store.js`
- `test.js`
- `docs/superpowers/specs/2026-07-09-answer-evidence-knowledge-quality-design.md`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Verification:** Run `node test.js`; result: record the exact passed/failed count. Rerun the synthetic controlled-rollout harness; record total steps, mapped-step percentage, direct-mapped-step percentage, unsupported-step percentage, distribution by answer confidence when available, and whether visible answer or nomination behavior changed.

**Decision / Follow-up:** Keep PR 1.1 shadow-only. Do not start PR 2 until the PR 1.1 result is reviewed and approved.
```

- [ ] **Step 3: Run docs and test verification**

Run:

```bash
git diff --check
node test.js
```

Expected:

- `git diff --check` exits `0`.
- `node test.js` exits `0` with `0 failed`.

- [ ] **Step 4: Commit Task 2**

```bash
git add docs/superpowers/specs/2026-07-09-answer-evidence-knowledge-quality-design.md docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "docs: document step coverage shadow metrics"
```

## Task 3: Controlled Rollout Validation Rerun

**Files:**

- Modify: `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Interfaces:**

- Consumes: `quality.stepCoverage` in generated shadow JSONL records.
- Produces: rollout validation summary for PR 1.1.

- [ ] **Step 1: Rerun the synthetic controlled-rollout harness**

Use the same safe harness shape from the `2026-07-14 - Controlled Rollout Validation` execution-log entry:

- disabled baseline: `QUALITY_LAYER_ENABLED=false`, `QUALITY_LAYER_SHADOW_MODE=true`
- enabled shadow mode: `QUALITY_LAYER_ENABLED=true`, `QUALITY_LAYER_SHADOW_MODE=true`
- mocked Slack client
- mocked Anthropic/search responses
- real `handleQuery`
- real Block Kit rendering
- real current nomination conditions
- temp `data/quality-shadow.jsonl` and `data/quality-audit.jsonl`

The harness must additionally aggregate:

```js
const totals = records.reduce((acc, record) => {
  const coverage = record.quality?.stepCoverage ?? {};
  acc.stepCount += coverage.stepCount ?? 0;
  acc.mappedStepCount += coverage.mappedStepCount ?? 0;
  acc.directMappedStepCount += coverage.directMappedStepCount ?? 0;
  acc.unsupportedStepCount += coverage.unsupportedStepCount ?? 0;
  const confidence = record.confidence ?? 'unknown';
  acc.byConfidence[confidence] ??= { stepCount: 0, mappedStepCount: 0, directMappedStepCount: 0, unsupportedStepCount: 0 };
  acc.byConfidence[confidence].stepCount += coverage.stepCount ?? 0;
  acc.byConfidence[confidence].mappedStepCount += coverage.mappedStepCount ?? 0;
  acc.byConfidence[confidence].directMappedStepCount += coverage.directMappedStepCount ?? 0;
  acc.byConfidence[confidence].unsupportedStepCount += coverage.unsupportedStepCount ?? 0;
  return acc;
}, {
  stepCount: 0,
  mappedStepCount: 0,
  directMappedStepCount: 0,
  unsupportedStepCount: 0,
  byConfidence: {},
});
```

- [ ] **Step 2: Record validation result**

Append the exact result to the execution log:

```md
## 2026-07-14 - PR 1.1 Controlled Validation

**Intent:** Verify count-only step coverage metrics in shadow mode without changing user-visible behavior.

**Action Taken:** Reran the synthetic controlled-rollout harness with PR 1.1 step coverage metrics.

**Verification:** Record:

- number of questions
- visible answer mismatch count
- nomination mismatch count
- shadow record count
- audit record count
- warning/error count
- total steps
- mapped-step percentage
- direct-mapped-step percentage
- unsupported-step percentage
- distribution by answer confidence
- privacy inspection result
- bypass result with `QUALITY_LAYER_ENABLED=false`

**Decision / Follow-up:** State whether PR 1.1 is ready for review, needs fixes, or should be disabled/investigated.
```

- [ ] **Step 3: Final verification**

Run:

```bash
git diff --check
node test.js
git status --short --branch
```

Expected:

- `git diff --check` exits `0`.
- `node test.js` exits `0` with `0 failed`.
- status shows only intended tracked changes plus local untracked `AGENTS.md` if still present.

- [ ] **Step 4: Commit Task 3**

```bash
git add docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md
git commit -m "docs: record step coverage rollout validation"
```

## Self-Review Checklist

- Privacy: counts only; no step/source/customer prose is persisted.
- Trust boundary: `shadow-store.js` derives counts from actual contract fields and ignores hostile caller values.
- Invariants: tests cover `mapped + unsupported === total`, `direct <= mapped`, non-negative integers, and zero-step answers.
- Scope: no Slack UX, prompt, nomination, approval, `knowledge.md`, database, or PR 2 behavior changes.
- Rollout: production remains disabled by default; validation uses `QUALITY_LAYER_ENABLED=true` only in safe shadow mode.
