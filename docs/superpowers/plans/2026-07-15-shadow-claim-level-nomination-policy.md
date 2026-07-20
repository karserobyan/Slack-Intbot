# Shadow Claim-Level Nomination Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task with review gates. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PR 2 shadow-only claim-level nomination policy behind the existing bot. The policy should evaluate individual durable answer claims from the in-memory Answer Evidence Contract, explain why each claim is pre-duplicate policy-eligible or blocked, and persist only privacy-safe aggregate nomination-policy summaries. The current live whole-answer nomination workflow must remain unchanged.

**Architecture:** Keep Slack answering and live nomination behavior exactly as-is. `src/handlers/mention.js` already calls `recordQualityShadow` after Slack delivery and history append. PR 2 should extend the quality recorder internally: build the existing Answer Evidence Contract, normalize the same bounded evidence and step populations used by shadow persistence, optionally run a gated in-memory claim-level nomination policy, attach a sanitized count-only summary to the shadow contract, then persist through the existing bounded JSONL store. Policy failures must not prevent the base contract from recording when possible.

**Tech Stack:** Node.js ESM, plain `assert` tests in `test.js`, file-backed JSONL shadow storage under `data/quality-shadow.jsonl`, no database.

## Global Constraints

- PR 2 is shadow-only.
- Do not change Slack cards, Block Kit layout, answer text, buttons, action IDs, source chips, or prompts.
- Do not change current live nomination trigger conditions.
- Do not create new live nomination review cards.
- Do not modify approve/reject handlers or approval flow.
- Do not write to `knowledge.md`, change write behavior, or add safe-write behavior in this PR.
- Do not add a database, review store, queue, or migration.
- Do not promote auto-answer into product scope.
- Keep production disabled by default.
- Candidate claim text, integration labels, evidence IDs, source step IDs, and step-to-evidence mappings may exist in memory only.
- Candidate policy eligibility is pre-duplicate only. PR 2 does not produce final nomination eligibility because duplicate detection is explicitly deferred.
- Persistent JSONL must not contain claim text, step titles/details/tags, step IDs, step-to-evidence mappings, raw queries, source titles/snippets/URLs, integration names, customer/person names, tenant/account/location text, emails, phone numbers, tokens, secrets, prompts, request headers, payloads, or free-form policy explanations.
- Persistent reason codes must be allowlisted and stable.
- Existing retention and privacy boundaries in `src/quality/shadow-store.js` remain in force.

---

## Current Implementation Observations

- `src/handlers/mention.js` calls `recordQualityShadow` after Slack answer delivery and `appendToHistory` in both the new-pipeline and legacy branches. This insertion point is correct and should not be changed for PR 2.
- Current live nominations are whole-answer nominations triggered in `src/handlers/mention.js` by elapsed time, presence of Slack or Atlassian refs, no escalation, and at least one agent step. The legacy branch also skips clarifying questions. PR 2 must not refactor these checks merely to make comparison easier.
- `src/quality/evidence-contract.js` already builds approximate Phase 1 claim steps under `contract.sections.steps[]`. Each step has in-memory `id`, `title`, `detail`, `tag`, `evidenceIds`, `trust`, `tenantSpecific`, and `nominationEligible`.
- `src/quality/shadow-store.js` already sanitizes persisted evidence once, limits evidence to ten retained records, derives count-only `quality.stepCoverage`, and ignores caller-supplied step coverage.
- `src/quality/source-scoring.js` already separates `sourceQuality`, `directness`, `freshness`, `sensitivity`, and `reuseValue`.
- `src/slack/nominations.js` and `src/slack/knowledge-writer.js` are live review/write surfaces. PR 2 must not modify them.
- Existing knowledge duplicate detection in `src/slack/knowledge-writer.js` is issue-title-within-integration-section based (`hasIssueTitle`). It is not claim-level and should not be reused as claim duplicate detection.

## Scope Check

This plan covers only PR 2 shadow claim-level nomination policy. It does not start PR 3 claim-level live nominations, PR 4 unified review store, or PR 5 `knowledge.md` write safety.

## File Map

### Modify

- `src/quality/config.js`
  - Add strict opt-in `isQualityNominationPolicyEnabled()` using explicit `"true"` only, case-insensitive.

- `src/quality/shadow-normalization.js`
  - New shared pure helper module for valid controlled evidence normalization, first-valid-record-wins evidence lookup, and bounded normalized step population.
  - Used by both `src/quality/shadow-store.js` and `src/quality/nomination-policy.js` so policy evaluation and persistence do not drift.

- `src/quality/nomination-policy.js`
  - New module for in-memory claim candidate construction, eligibility evaluation, allowlisted reason codes, and privacy-safe summary aggregation.

- `src/quality/shadow-recorder.js`
  - Gate and invoke the nomination policy after contract creation.
  - Isolate policy failures so base shadow contract recording can still proceed.
  - Do not change the public Slack answer path or current nomination workflow.

- `src/quality/shadow-store.js`
  - Replace private duplicated evidence/step normalization with the shared helper where behavior overlaps.
  - Sanitize and persist `quality.nominationPolicy` aggregate summary only.
  - Clamp statuses, claim types, and reason codes to controlled enums.
  - Do not persist per-step mappings or raw candidate fields.

- `test.js`
  - Add focused tests for the flag, policy module, recorder failure isolation, persistence privacy, and controlled summary semantics.

- `.env.example`
  - Document `QUALITY_NOMINATION_POLICY_ENABLED=false` as disabled by default.

- `docs/superpowers/specs/2026-07-09-answer-evidence-knowledge-quality-design.md`
  - Update the PR 2 shadow nomination policy schema and measurement section after implementation.

- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`
  - Record each PR 2 task, verification result, controlled validation result, and final review state.

### Do Not Modify

- `src/handlers/mention.js`
- `src/slack/blocks.js`
- `src/slack/nominations.js`
- `src/slack/review-actions.js`
- `src/slack/feedback.js`
- `src/slack/knowledge-writer.js`
- `src/slack/knowledge.js`
- `src/claude/*` prompts or answerer behavior
- `data/knowledge.md` or `knowledge.md`
- `src/quality/audit-log.js`, unless a test reveals an unavoidable import-only issue. The intended PR 2 design leaves audit payload behavior unchanged.

## Feature Flags

PR 2 adds one strict opt-in flag:

```js
export function isQualityNominationPolicyEnabled() {
  return envStrictTrue('QUALITY_NOMINATION_POLICY_ENABLED');
}
```

Expected behavior:

- unset -> disabled
- empty -> disabled
- `"false"` -> disabled
- `"0"` -> disabled
- `"off"` -> disabled
- typo/random value -> disabled
- `"true"` -> enabled
- `"TRUE"` -> enabled

The policy can run only when all are true:

```text
QUALITY_LAYER_ENABLED=true
QUALITY_LAYER_SHADOW_MODE=true
QUALITY_NOMINATION_POLICY_ENABLED=true
```

Production remains disabled by default:

```text
QUALITY_LAYER_ENABLED=false
QUALITY_NOMINATION_POLICY_ENABLED=false
```

## Target Lifecycle

```text
current answer object
  -> buildAnswerEvidenceContract(answer)
  -> if QUALITY_NOMINATION_POLICY_ENABLED=true:
       normalizeQualityEvidence(contract.evidence)
       normalizeQualitySteps(contract.sections.steps)
       buildClaimCandidates(contract)
       evaluateNominationEligibility(candidate, contract)
       summarizeNominationPolicy(policyResult)
     else:
       omit nominationPolicy summary
  -> appendQualityShadowRecord(contractWithOptionalSummary)
  -> appendQualityAuditEvent(contract_created) unchanged
  -> existing live nomination workflow unchanged
```

Nested failure isolation:

```js
const contract = buildAnswerEvidenceContract(...);

if (isQualityNominationPolicyEnabled()) {
  try {
    const policyResult = evaluateContractNominationPolicy(contract);
    contract.quality.nominationPolicy = summarizeNominationPolicy(policyResult);
  } catch {
    logger?.warn?.('[quality] nomination policy failed');
    contract.quality.nominationPolicy = {
      version: 1,
      status: 'policy_failed',
      evaluated: false,
      candidateCount: 0,
      preDuplicateEligibleCount: 0,
      blockedCount: 0,
      duplicateCheck: 'deferred',
      blockerCounts: {},
      eligibleReasonCounts: {},
      byClaimType: {},
      supportCounts: {},
    };
  }
}

await appendQualityShadowRecord(contract, { now });
```

If candidate policy fails, the base Answer Evidence Contract should still be written when shadow storage itself works. If shadow storage fails, the existing fail-open recorder behavior remains: Slack delivery and current nomination behavior are unchanged.

For tests, `recordQualityShadow` should accept an optional internal dependency such as `nominationPolicyEvaluator = evaluateContractNominationPolicy`. Production code uses the default evaluator. Tests can inject a throwing evaluator whose error contains a privacy canary and prove the canary appears neither in logs nor persisted JSONL.

## In-Memory Schemas

### `ClaimCandidate`

This object is in memory only. It must not be persisted as-is.

```js
{
  version: 1,
  candidateId: 'qc_20260715_abcd12',
  answerId: 'ans_...',
  sourceStepId: 'claim_1',
  claimOrdinal: 1,
  claimType: 'action',
  text: 'Enable payments in Marketplace settings before reconnecting.',
  integrationType: 'ServiceTitan Payments',
  evidenceIds: ['ev_1'],
  approximateMapping: true,
  tenantSpecific: false,
  genericPlaceholder: false,
  answerRequiresEscalation: false,
  eligibility: {
    preDuplicateEligible: false,
    reasons: [],
    blockers: [],
  },
  evidenceSummary: {
    resolvedCount: 1,
    directCount: 1,
    safeDirectCount: 1,
    specialistOnlyCount: 0,
    exclusivelySpecialistOnly: false,
    highOrMediumQualityCount: 1,
    highOrMediumReuseCount: 1,
    qualifyingEvidenceCount: 1,
    freshQualifyingEvidenceCount: 1,
    unknownFreshnessQualifyingEvidenceCount: 0,
    staleOtherwiseQualifyingEvidenceCount: 0,
  },
}
```

Allowed `claimType` values:

```js
const CLAIM_TYPES = new Set(['action', 'backend', 'verify', 'escalate', 'step']);
```

Candidate extraction source:

- Use `contract.sections.steps[]` only for PR 2.
- Map `step.tag` into `claimType`.
- Keep `step.title`, `step.detail`, `step.id`, `contract.integrationType`, and `step.evidenceIds` in memory only.
- Treat `contract.quality.approximateMapping === true` as a policy context flag.
- Do not use diagnosis/customer-message/escalation prose as standalone nomination candidates in PR 2.

### `NominationPolicyResult`

This object is returned in memory for tests and validation harnesses.

```js
{
  version: 1,
  answerId: 'ans_...',
  status: 'evaluated',
  approximateMapping: true,
  candidates: [ClaimCandidate],
  summary: NominationPolicySummary,
}
```

### Persisted `NominationPolicySummary`

This is the only PR 2 nomination-policy payload persisted in `data/quality-shadow.jsonl`.

```js
quality: {
  directAnswer: true,
  reusableKnowledge: false,
  nominationEligible: false,
  approximateMapping: true,
  reasons: ['shadow_mode', 'approximate_mapping'],
  stepCoverage: {
    stepCount: 4,
    mappedStepCount: 3,
    directMappedStepCount: 2,
    unsupportedStepCount: 1,
  },
  nominationPolicy: {
    version: 1,
    status: 'evaluated',
    evaluated: true,
    candidateCount: 4,
    preDuplicateEligibleCount: 1,
    blockedCount: 3,
    duplicateCheck: 'deferred',
    blockerCounts: {
      unsupported_claim: 1,
      tenant_specific_claim: 1,
      escalation_claim: 1,
    },
    eligibleReasonCounts: {
      specific_integration: 1,
      durable_claim_type: 1,
      concrete_claim: 1,
      non_tenant_specific: 1,
      cohesive_qualifying_evidence: 1,
    },
    byClaimType: {
      action: 1,
      backend: 1,
      verify: 1,
      escalate: 1,
    },
    supportCounts: {
      resolvedCount: 3,
      directCount: 2,
      safeDirectCount: 1,
      specialistOnlyCount: 1,
      exclusivelySpecialistOnly: 1,
      highOrMediumQualityCount: 2,
      highOrMediumReuseCount: 2,
      qualifyingEvidenceCount: 1,
      freshQualifyingEvidenceCount: 1,
      unknownFreshnessQualifyingEvidenceCount: 0,
      staleOtherwiseQualifyingEvidenceCount: 0,
    },
  },
}
```

The persistent summary is aggregate/count-only. `supportCounts.qualifyingEvidenceCount` is a candidate count: the number of candidates with at least one single cohesive qualifying evidence record, so it remains `<= candidateCount`. The in-memory candidate may count individual qualifying evidence records, but the persistent summary must not store per-candidate or per-evidence detail. It must not persist candidate IDs, step IDs, evidence IDs from step mappings, claim text, step text, source text, source URLs, source titles, integration names, or free-form explanations.

## Reason Codes

### Blocker Reason Codes

```js
const BLOCKER_CODES = new Set([
  'low_confidence_answer',
  'missing_specific_integration',
  'unsupported_claim',
  'no_direct_evidence',
  'no_safe_direct_evidence',
  'stale_evidence',
  'weak_source_quality',
  'low_reuse_value',
  'no_cohesive_qualifying_evidence',
  'tenant_specific_claim',
  'specialist_only_evidence',
  'escalation_claim',
  'answer_requires_escalation',
  'non_durable_claim_type',
  'generic_placeholder',
  'empty_claim',
]);
```

`policy_failed` is a controlled `status` value for the isolated failure summary when the policy module throws. It is not a normal candidate blocker and must not appear in `blockerCounts`.

### Eligible Reason Codes

```js
const ELIGIBLE_REASON_CODES = new Set([
  'specific_integration',
  'durable_claim_type',
  'concrete_claim',
  'non_tenant_specific',
  'cohesive_qualifying_evidence',
]);
```

Unknown caller-supplied reason strings must never be persisted.

## Eligibility Policy

A candidate is pre-duplicate policy-eligible only when all required positive conditions pass and no blocker is present. This is not final nomination eligibility because duplicate detection is deferred in PR 2.

The most important rule is cohesive qualifying evidence. A candidate must have at least one single resolved evidence record that simultaneously has:

```js
{
  directness: 'direct',
  sensitivity: 'safe',
  sourceQuality: 'high' || 'medium',
  reuseValue: 'high' || 'medium',
  freshness: 'fresh' || 'unknown',
}
```

Do not let unrelated evidence records combine to satisfy these dimensions. For example, one safe direct Slack source and a different high-quality Confluence source do not make a candidate policy-eligible unless at least one of those records itself has all required dimensions.

| Rule | Eligible reason | Blocker |
| --- | --- | --- |
| `contract.confidence !== 'low'` | none | `low_confidence_answer` |
| Specific integration is present and not `General`, `Unknown`, `Integration Issue`, or empty | `specific_integration` | `missing_specific_integration` |
| Claim type is `action`, `backend`, or `verify` | `durable_claim_type` | `escalation_claim` for `escalate`; `non_durable_claim_type` for fallback `step`; `empty_claim` for empty text |
| Candidate has at least one evidence ID resolving to retained evidence | none | `unsupported_claim` |
| Claim text is specific and not a vague placeholder | `concrete_claim` | `generic_placeholder` |
| At least one resolved evidence record has `directness === 'direct'` | none | `no_direct_evidence` |
| At least one resolved evidence record has `directness === 'direct'` and `sensitivity === 'safe'` | none | `no_safe_direct_evidence` |
| At least one direct-safe evidence record has `sourceQuality === 'high'` or `'medium'` | none | `weak_source_quality` |
| At least one direct-safe evidence record has `reuseValue === 'high'` or `'medium'` | none | `low_reuse_value` |
| At least one single direct-safe high/medium-quality high/medium-reuse evidence record has `freshness === 'fresh'` or `'unknown'` | `cohesive_qualifying_evidence` | `no_cohesive_qualifying_evidence`; `stale_evidence` when all otherwise qualifying evidence is stale |
| Candidate is not tenant/customer/account/location-specific | `non_tenant_specific` | `tenant_specific_claim` |
| Candidate does not depend exclusively on specialist-only evidence | none | `specialist_only_evidence` |
| Answer does not require escalation | none | `answer_requires_escalation` |

Important nuance: specialist-only evidence does not automatically block a candidate if there is sufficient safe direct evidence. It blocks only when all resolved supporting evidence is specialist-only or there is no safe direct evidence.

For PR 2, `escalate` claims are always blocked with `escalation_claim`, even if they are operationally useful. Reusable escalation routing can be designed later with a separate policy.

Evidence blocker precedence:

1. If no evidence IDs resolve to retained normalized evidence, add `unsupported_claim` and do not add directness, freshness, quality, or reuse blockers for that candidate.
2. If evidence resolves but none is direct, add `no_direct_evidence` and do not add freshness, quality, or reuse blockers.
3. If direct evidence exists but none is safe direct evidence, add `no_safe_direct_evidence` and do not add freshness, quality, or reuse blockers.
4. From the direct-safe evidence population, evaluate source quality and reuse value.
5. From direct-safe evidence that has high/medium source quality and high/medium reuse value, evaluate freshness. If that otherwise qualifying population exists but every record is stale, add `stale_evidence`.
6. `eligibleReasonCounts` includes reasons from pre-duplicate policy-eligible candidates only. `blockerCounts` includes blockers from blocked candidates only.

## Shared Normalization Boundary

Create `src/quality/shadow-normalization.js` so nomination policy and shadow persistence use the same bounded evidence and step populations.

Primary exports:

```js
export const MAX_PERSISTED_EVIDENCE_RECORDS = 10;
export const MAX_STEP_COVERAGE_COUNT = 1000;

export function normalizeQualityEvidence(evidence = []);
export function evidenceByIdFirstWins(persistedEvidence = []);
export function normalizeQualitySteps(steps = []);
export function isSafeNonNegativeInt(value, max = 1000);
export function sanitizeCountMap(value, allowedKeys, maxValue = 1000);
```

Evidence normalization requirements:

- Accept only evidence items with valid controlled IDs matching `/^ev_[a-z0-9_-]+$/i`.
- Clamp `source`, `sourceQuality`, `directness`, `freshness`, `sensitivity`, and `reuseValue` to the same controlled enums currently enforced by `src/quality/shadow-store.js`.
- Hash URL values through the already-approved hash behavior; do not expose raw URLs.
- Keep only allowlisted hostnames and reason codes.
- Apply the ten-record evidence bound before policy evaluation.
- Do not deduplicate the persisted evidence array itself unless shadow persistence also changes; use `evidenceByIdFirstWins` for resolution semantics.

Step normalization requirements:

- Accept only object-like step entries.
- Skip `null`, primitives, arrays, and malformed entries.
- Sanitize evidence IDs with the same ID validation used for evidence.
- Preserve enough in-memory fields for policy construction: `id`, `num`, `title`, `detail`, `tag`, `evidenceIds`, and `tenantSpecific`.
- Apply `MAX_STEP_COVERAGE_COUNT` before candidate construction and before step coverage calculation.
- Candidate count must match the valid bounded step population.

## Candidate Construction

```js
import { makeQualityId, normalizeForQuality, sanitizePreview } from './privacy.js';
import { normalizeQualitySteps } from './shadow-normalization.js';

const EXACT_GENERIC_TEXT = new Set([
  'investigate further',
  'try again',
  'look into it',
  'check it',
  'review it',
]);
const GENERIC_STEP_TEXT = /\b(contact support|reach out|ask someone|follow up later)\b/i;
const TENANT_SPECIFIC_TEXT = /\b(this tenant|this customer|tenant-specific|customer-specific|tenant\s*#?\d+|customer\s*#?\d+|account\s*#?\d+|location\s*#?\d+)\b/i;

function normalizeIntegrationType(value) {
  return normalizeForQuality(value);
}

function hasSpecificIntegration(value) {
  const normalized = normalizeIntegrationType(value);
  return Boolean(normalized) &&
    !['general', 'unknown', 'integration issue', 'integration'].includes(normalized);
}

function candidateTextFromStep(step) {
  return sanitizePreview(`${step?.title ?? ''} ${step?.detail ?? ''}`.trim(), 500);
}

function isGenericPlaceholder(text) {
  const normalized = normalizeForQuality(text);
  if (!normalized) return true;
  if (EXACT_GENERIC_TEXT.has(normalized)) return true;
  return GENERIC_STEP_TEXT.test(text) && normalized.split(' ').length <= 5;
}

export function buildClaimCandidates(contract, { now = new Date() } = {}) {
  const steps = normalizeQualitySteps(contract?.sections?.steps);
  const answerRequiresEscalation = contract?.sections?.escalation?.shouldEscalate === true;

  return steps.map((step, index) => {
    const text = candidateTextFromStep(step);
    const claimType = CLAIM_TYPES.has(step?.tag) ? step.tag : 'step';

    return {
      version: 1,
      candidateId: makeQualityId('qc', now),
      answerId: contract.answerId,
      sourceStepId: typeof step?.id === 'string' ? step.id : `claim_${index + 1}`,
      claimOrdinal: index + 1,
      claimType,
      text,
      integrationType: contract.integrationType,
      evidenceIds: [...new Set(step.evidenceIds)],
      approximateMapping: contract?.quality?.approximateMapping === true,
      tenantSpecific: step?.tenantSpecific === true || TENANT_SPECIFIC_TEXT.test(text),
      genericPlaceholder: isGenericPlaceholder(text),
      answerRequiresEscalation,
      eligibility: { preDuplicateEligible: false, reasons: [], blockers: [] },
      evidenceSummary: emptyEvidenceSummary(),
    };
  });
}
```

Implementation note: candidate IDs do not need to be stable across runs because PR 2 does not persist or display candidates. If later PRs need reviewer cards, they should introduce stable candidate hashes with a fresh privacy review.

Generic-placeholder classification must distinguish vague work from concrete diagnostic actions:

- `Investigate further` is generic.
- `Try again` is generic.
- `Check the OAuth mapping in Settings` is not generic.
- `Review the webhook subscription status` is not generic.

Tenant-specific classification must catch explicit tenant/customer/account/location specificity:

- `this tenant`
- `this customer`
- `tenant-specific`
- `customer-specific`
- numbered `tenant`, `customer`, `account`, or `location` references

It must not mark generic customer instructions such as `ask the customer to reconnect` as tenant-specific.

## Evidence Resolution

Resolve evidence against the bounded normalized evidence population. The policy should use the same pure helper as shadow persistence so it evaluates valid controlled evidence IDs, clamped directness/quality/freshness/sensitivity/reuse enums, the ten-record evidence bound, and first-valid-record-wins duplicate handling.

```js
import {
  evidenceByIdFirstWins,
  normalizeQualityEvidence,
} from './shadow-normalization.js';

function normalizedEvidenceContext(contract) {
  const evidence = normalizeQualityEvidence(contract?.evidence);
  return {
    evidence,
    evidenceById: evidenceByIdFirstWins(evidence),
  };
}

function resolveCandidateEvidence(candidate, evidenceById) {
  return [...new Set(candidate.evidenceIds)]
    .map((id) => evidenceById.get(id))
    .filter(Boolean);
}
```

Dangling IDs and duplicate IDs within one candidate do not inflate support counts. Evidence dropped by ID validation, enum normalization, or the evidence persistence limit does not count as resolved.

## Duplicate Detection Decision

PR 2 should defer duplicate detection.

Reason:

- The current safe helper, `hasIssueTitle(integration, title)`, deduplicates whole approved entries by issue title inside an integration section.
- PR 2 candidates are claim-level and may be only one reusable step from an answer.
- Reusing issue-title dedupe would create false duplicate decisions for unrelated claims under the same answer title.
- Fuzzy or semantic duplicate detection would require a new claim normalization strategy and likely source text/knowledge text handling, which is outside the approved shadow-only scope.

PR 2 should not add a duplicate blocker at runtime. Duplicate detection belongs in a later PR before live claim cards or safe knowledge writes.

## Privacy Boundary

Persistent `quality.nominationPolicy` may store:

- booleans and controlled statuses;
- aggregate counts;
- allowlisted blocker reason counts;
- allowlisted eligible reason counts;
- claim type counts using controlled enum keys;
- support counts based on evidence dimensions;
- no per-candidate raw payloads.

Persistent `quality.nominationPolicy` must not store:

- candidate IDs;
- step IDs;
- step ordinals if they could be combined with candidate decisions;
- evidence IDs from step mappings;
- claim text;
- step titles, details, or tags beyond aggregate `byClaimType` counts;
- integration labels or names;
- source titles, snippets, raw URLs, channels, or raw hostnames beyond already-approved evidence hostnames;
- raw query/customer text;
- diagnosis/customer-message/escalation prose;
- names, emails, phone numbers, tenant/account/location text;
- prompts, request headers, or payloads;
- unknown reason strings or policy exception messages.

## Storage Changes

`src/quality/shadow-store.js` should sanitize nomination-policy summaries at the persistence boundary. It must not trust caller-supplied summary shape blindly.

```js
const NOMINATION_POLICY_STATUS = new Set(['evaluated', 'policy_failed']);
const CLAIM_TYPES = new Set(['action', 'backend', 'verify', 'escalate', 'step']);
const NOMINATION_BLOCKER_CODES = new Set([...]);
const NOMINATION_ELIGIBLE_REASON_CODES = new Set([...]);
const SUPPORT_COUNT_KEYS = new Set([
  'resolvedCount',
  'directCount',
  'safeDirectCount',
  'specialistOnlyCount',
  'exclusivelySpecialistOnly',
  'highOrMediumQualityCount',
  'highOrMediumReuseCount',
  'qualifyingEvidenceCount',
  'freshQualifyingEvidenceCount',
  'unknownFreshnessQualifyingEvidenceCount',
  'staleOtherwiseQualifyingEvidenceCount',
]);

function safeNonNegativeInt(value, max = 1000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, max);
}

function sanitizeCountMap(value, allowedKeys, maxValue = 1000) {
  const out = {};
  for (const key of allowedKeys) {
    const count = safeNonNegativeInt(value?.[key], maxValue);
    if (count > 0) out[key] = count;
  }
  return out;
}

function sumCounts(value = {}) {
  return Object.values(value).reduce((sum, count) => sum + safeNonNegativeInt(count), 0);
}

function allCountsAtMost(value = {}, max) {
  return Object.values(value).every((count) => safeNonNegativeInt(count) <= max);
}

function isCanonicalEvaluatedSummary(summary) {
  return summary.status === 'evaluated' &&
    summary.evaluated === true &&
    summary.duplicateCheck === 'deferred' &&
    summary.preDuplicateEligibleCount + summary.blockedCount === summary.candidateCount &&
    sumCounts(summary.byClaimType) === summary.candidateCount &&
    allCountsAtMost(summary.supportCounts, summary.candidateCount);
}

function sanitizeNominationPolicySummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = safeEnum(value.status, NOMINATION_POLICY_STATUS, 'policy_failed');
  if (status === 'policy_failed') return failedNominationPolicySummary();

  const summary = {
    version: 1,
    status: 'evaluated',
    evaluated: true,
    duplicateCheck: 'deferred',
    candidateCount: safeNonNegativeInt(value.candidateCount),
    preDuplicateEligibleCount: safeNonNegativeInt(value.preDuplicateEligibleCount),
    blockedCount: safeNonNegativeInt(value.blockedCount),
    blockerCounts: sanitizeCountMap(value.blockerCounts, NOMINATION_BLOCKER_CODES),
    eligibleReasonCounts: sanitizeCountMap(value.eligibleReasonCounts, NOMINATION_ELIGIBLE_REASON_CODES),
    byClaimType: sanitizeCountMap(value.byClaimType, CLAIM_TYPES),
    supportCounts: sanitizeCountMap(value.supportCounts, SUPPORT_COUNT_KEYS),
  };
  return isCanonicalEvaluatedSummary(summary) ? summary : failedNominationPolicySummary();
}

function failedNominationPolicySummary() {
  return {
    version: 1,
    status: 'policy_failed',
    evaluated: false,
    duplicateCheck: 'deferred',
    candidateCount: 0,
    preDuplicateEligibleCount: 0,
    blockedCount: 0,
    blockerCounts: {},
    eligibleReasonCounts: {},
    byClaimType: {},
    supportCounts: {},
  };
}
```

After sanitizing, enforce summary invariants:

- for `status: 'evaluated'`, `preDuplicateEligibleCount + blockedCount === candidateCount`
- for `status: 'evaluated'`, `candidateCount === sum(byClaimType)`
- for `status: 'evaluated'`, every `supportCounts` value is `<= candidateCount`
- reason/support maps contain only allowlisted keys
- all values are non-negative integers
- `eligibleReasonCounts` includes reasons from pre-duplicate policy-eligible candidates only
- `blockerCounts` includes blockers from blocked candidates only
- for `status: 'policy_failed'`, `evaluated` is `false`, all candidate counts are zero, maps are empty, and the status itself represents the failure

Malformed or inconsistent incoming summaries must not be silently repaired. Convert them to `failedNominationPolicySummary()` or omit `quality.nominationPolicy`; prefer the controlled failure summary when the policy flag was enabled and a summary object was supplied.

## Failure Isolation

`recordQualityShadow` currently has one `try/catch` around contract creation, shadow write, and audit write. PR 2 should preserve the outer fail-open behavior and add an inner policy boundary. Add an optional internal evaluator dependency for tests without changing production callers:

```js
export async function recordQualityShadow({
  answer,
  query,
  role,
  channelId,
  threadTs,
  logger = console,
  now = new Date(),
  nominationPolicyEvaluator = evaluateContractNominationPolicy,
}) {
  try {
    const contract = buildAnswerEvidenceContract(...);

    if (isQualityNominationPolicyEnabled()) {
      try {
        const policyResult = nominationPolicyEvaluator(contract);
        contract.quality.nominationPolicy = policyResult.summary;
      } catch {
        logger?.warn?.('[quality] nomination policy failed');
        contract.quality.nominationPolicy = failedNominationPolicySummary();
      }
    }

    await appendQualityShadowRecord(contract, { now });
    await appendQualityAuditEvent(...);
    return { status: 'recorded', contract };
  } catch (err) {
    logger?.warn?.(`[quality] shadow record failed: ${err.message}`);
    return { status: 'failed_open', error: err.message };
  }
}
```

Do not add nomination-policy details to `appendQualityAuditEvent` in PR 2. Audit behavior should remain unchanged.

The inner nomination-policy catch must not log raw `err.message`, return it, or persist it. The test-injected evaluator should throw an error containing a privacy canary, and tests must prove that canary appears neither in captured logs nor in shadow/audit JSONL.

## Test Plan

Add targeted tests in `test.js`. Keep each group close to the existing quality tests.

### Flag Tests

- `QUALITY_NOMINATION_POLICY_ENABLED` unset disables.
- Empty disables.
- `"false"`, `"0"`, `"off"`, typo disables.
- `"true"` and `"TRUE"` enable.
- Existing `QUALITY_LAYER_ENABLED` strict opt-in tests remain green.

### Candidate Builder Tests

- Builds one candidate per normalized step.
- Candidate count matches the valid bounded step population from `normalizeQualitySteps`.
- Malformed step entries are skipped and do not inflate candidate count.
- Uses only `contract.sections.steps[]`.
- Maps `action`, `backend`, `verify`, `escalate`, and fallback `step` claim types.
- Preserves raw text and evidence IDs in memory only.
- Marks approximate mapping from `contract.quality.approximateMapping`.
- Marks tenant-specific claims from `step.tenantSpecific`, explicit `this tenant` / `this customer` phrases, `tenant-specific` / `customer-specific`, or numbered tenant/customer/account/location references.
- Does not mark `ask the customer to reconnect` as tenant-specific.
- Marks `Investigate further` and `Try again` as generic placeholders.
- Does not mark `Check the OAuth mapping in Settings` or `Review the webhook subscription status` as generic placeholders.

### Eligibility Tests

- Pre-duplicate policy-eligible: high-confidence, specific integration, `action` claim, one single cohesive evidence record with directness `direct`, sensitivity `safe`, high/medium source quality, high/medium reuse, freshness `fresh` or `unknown`, and non-tenant-specific text.
- Pre-duplicate policy-eligible: specialist-only evidence present plus a separate cohesive safe direct evidence record still passes specialist blocker.
- Blocked: unrelated sources cannot combine into eligibility, such as one safe direct low-quality source plus one high-quality background source.
- Blocked: all otherwise qualifying evidence is stale, with `stale_evidence`.
- Blocked: low-confidence answer.
- Blocked: missing or generic integration.
- Blocked: unsupported claim with no resolved retained evidence.
- Blocked: dangling evidence IDs.
- Blocked: no direct evidence.
- Blocked: direct evidence exists but none is safe.
- Blocked: weak source quality evaluated only after resolved direct-safe evidence exists.
- Blocked: low reuse value evaluated only after resolved direct-safe evidence exists.
- Blocked: tenant-specific claim.
- Blocked: exclusively specialist-only evidence.
- Blocked: `escalate` claim.
- Blocked: fallback `step` claim with `non_durable_claim_type`.
- Blocked: answer requires escalation.
- Blocked: generic placeholder.
- Blocked: empty claim.
- Duplicate evidence IDs inside one candidate do not inflate counts.
- Duplicate evidence records with conflicting dimensions use first-valid-record-wins.
- Evidence dropped by ID validation or the ten-record evidence bound does not count as resolved.
- Evidence blocker precedence avoids adding weak-quality or low-reuse blockers when there is no resolved evidence.

### Summary Tests

- Summary candidate count equals candidates evaluated.
- Pre-duplicate eligible and blocked counts add up exactly to candidate count.
- `blockerCounts` includes only allowlisted blocker codes.
- `eligibleReasonCounts` includes only allowlisted eligible reason codes.
- `byClaimType` includes only controlled claim types.
- `candidateCount` equals the sum of `byClaimType`.
- Every `supportCounts` value is `<= candidateCount`.
- `supportCounts` correctly counts resolved/direct/safe-direct/specialist/reuse/source-quality support and cohesive qualifying evidence support.
- `eligibleReasonCounts` includes reasons from pre-duplicate policy-eligible candidates only.
- `blockerCounts` includes blockers from blocked candidates only.
- Unknown/caller reason strings are dropped before persistence.
- Malformed or inconsistent caller-supplied summaries canonicalize to `status: 'policy_failed'` with zero counts and empty maps.

### Shadow Store Privacy Tests

- Persisted JSONL includes `quality.nominationPolicy` only when policy is enabled and recorder attached a summary.
- Persisted JSONL contains aggregate counts and controlled enum keys only.
- Persisted JSONL contains `duplicateCheck: 'deferred'`.
- Persisted JSONL does not include claim text.
- Does not include step titles/details/tags.
- Does not include candidate IDs, step IDs, or evidence IDs from step mappings.
- Does not include raw query text.
- Does not include source title, snippet, URL, or channel text.
- Does not include integration names.
- Does not include sample person/customer name.
- Does not include sample email.
- Does not include sample phone number.
- Does not include sample tenant/account/location text.
- Does not include sample Slack-like token.
- Does not include prompts, request headers, or payload-shaped text.
- Hostile caller-supplied summary fields are clamped or dropped.

### Recorder Integration Tests

- With `QUALITY_NOMINATION_POLICY_ENABLED=false`, the recorder persists the same base quality record shape as PR 1.1 and omits `quality.nominationPolicy`.
- With all quality flags enabled, the recorder records a nomination-policy summary after contract creation.
- Policy module failure logs one bounded `[quality] nomination policy failed` warning and still records the base shadow contract with a controlled `policy_failed` summary.
- A test-injected policy evaluator throws an error containing a privacy canary, and the canary appears neither in captured logs nor persisted shadow/audit JSONL.
- Shadow-store failure still returns `failed_open` and does not block Slack delivery in the existing mention integration test.
- Audit event payload remains unchanged.
- No test changes should require touching `src/handlers/mention.js`.

## Controlled Rollout Validation Plan

After implementation and final task review, rerun the same local synthetic Slack harness used for PR 1 and PR 1.1:

- mocked Slack client;
- mocked Anthropic and search responses;
- real `handleQuery` new-pipeline path;
- real Block Kit rendering;
- real current nomination conditions;
- real shadow and audit writers;
- temporary shadow/audit JSONL files;
- no live Slack workspace;
- no customer data;
- no live production services.

Run the same 10 synthetic cases:

- strong Confluence + KB match;
- Slack-only evidence;
- mixed Slack/Atlassian/KB evidence;
- specialist-sensitive Jira in CSA view;
- weak or low-confidence evidence;
- no useful refs;
- escalation case;
- non-escalation case that is eligible under the current live whole-answer nomination trigger;
- privacy canary;
- KB-only evidence.

### Disabled Baseline

```text
QUALITY_LAYER_ENABLED=false
QUALITY_LAYER_SHADOW_MODE=true
QUALITY_NOMINATION_POLICY_ENABLED=true
```

Expected:

- all answers deliver;
- no shadow records;
- no audit records;
- current live nominations unchanged.

### Quality Enabled, Policy Disabled

```text
QUALITY_LAYER_ENABLED=true
QUALITY_LAYER_SHADOW_MODE=true
QUALITY_NOMINATION_POLICY_ENABLED=false
```

Expected:

- answers match disabled baseline;
- nominations match disabled baseline;
- PR 1.1 shadow records exist;
- `quality.nominationPolicy` omitted.

### Quality Enabled, Policy Enabled

```text
QUALITY_LAYER_ENABLED=true
QUALITY_LAYER_SHADOW_MODE=true
QUALITY_NOMINATION_POLICY_ENABLED=true
```

Expected:

- answers match disabled baseline;
- cards, text, steps, buttons, action IDs, and source chips unchanged;
- current live nomination count and conditions unchanged;
- `quality.nominationPolicy` aggregate summaries created;
- no frequent `[quality]` warnings.

Report these metrics:

- total synthetic cases;
- visible-answer mismatches;
- nomination mismatches;
- current live whole-answer nominations;
- total claim candidates;
- pre-duplicate policy-eligible claim candidates;
- blocked claim candidates;
- candidate count per answer;
- answers with multiple pre-duplicate policy-eligible claims;
- old whole-answer nominations with zero pre-duplicate policy-eligible claim candidates;
- answers skipped by old trigger but containing pre-duplicate policy-eligible claim candidates;
- blocker distribution;
- pre-duplicate eligible reason distribution;
- candidate distribution by answer confidence;
- candidate distribution by claim type;
- support distribution by direct evidence, safe direct evidence, specialist-only evidence, source quality, and reuse value;
- fail-open result;
- bypass result;
- privacy inspection result.

Interpretation rule: these counters are proxy metrics over approximate Phase 1 mappings and pre-duplicate policy eligibility. A high pre-duplicate eligible rate or high direct support rate does not prove semantic correctness until a later answerer contract emits explicit evidence IDs per claim, and it does not mean candidates are ready to drive live nominations until duplicate detection is added.

## Success Criteria

PR 2 is ready for final review when:

- `node test.js` passes with 0 failures.
- `git diff --check` is clean.
- No files outside the approved scope changed.
- No Slack UX, prompt, nomination, approval, audit, `knowledge.md`, or answer-path behavior changed.
- `QUALITY_NOMINATION_POLICY_ENABLED` is strict opt-in and disabled by default.
- Every normalized step receives an explainable in-memory pre-duplicate policy-eligible or blocked decision when policy is enabled.
- Persistent JSONL stores only aggregate/count nomination-policy summaries.
- Policy failures are isolated from base shadow contract recording where possible.
- Shadow-store failures remain fail-open.
- Controlled validation shows 0 visible-answer mismatches and 0 live nomination mismatches.

## Rollback Plan

- To disable PR 2 policy only:

```text
QUALITY_NOMINATION_POLICY_ENABLED=false
```

- To disable the whole quality layer:

```text
QUALITY_LAYER_ENABLED=false
```

No migration is required because PR 2 adds only optional shadow JSONL summary fields. Existing PR 1.1 records without `quality.nominationPolicy` remain valid.

## Task Sequence

### Task 1: Feature Flag, Shared Normalization, And Policy Module Skeleton

**Files:**

- `src/quality/config.js`
- `src/quality/shadow-normalization.js`
- `src/quality/shadow-store.js`
- `src/quality/nomination-policy.js`
- `test.js`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Steps:**

- [ ] Add failing tests for `QUALITY_NOMINATION_POLICY_ENABLED` strict opt-in behavior.
- [ ] Add failing tests for shared evidence normalization: valid IDs retained, invalid IDs dropped, enums clamped, evidence bound applied before evaluation, duplicate evidence resolution first-valid-record-wins.
- [ ] Add failing tests for shared step normalization: malformed entries skipped, evidence IDs sanitized, step bound applied before candidate construction, and candidate count matches valid bounded step population.
- [ ] Add failing import tests for `src/quality/nomination-policy.js`.
- [ ] Implement `isQualityNominationPolicyEnabled()`.
- [ ] Create `src/quality/shadow-normalization.js` with `normalizeQualityEvidence`, `evidenceByIdFirstWins`, `normalizeQualitySteps`, `isSafeNonNegativeInt`, and `sanitizeCountMap`.
- [ ] Update `src/quality/shadow-store.js` to use the shared helper for overlapping evidence/step normalization while preserving current persisted shape.
- [ ] Create `src/quality/nomination-policy.js` with controlled enums, reason-code constants, `buildClaimCandidates`, and `emptyEvidenceSummary`.
- [ ] Add candidate-builder tests for claim type mapping, approximate mapping, tenant-specific detection, concrete-vs-generic placeholder detection, and malformed-step skipping.
- [ ] Run `node test.js`.
- [ ] Run `git diff --check`.
- [ ] Update execution log and stop for review.

### Task 2: Eligibility Evaluation And Summary Aggregation

**Files:**

- `src/quality/nomination-policy.js`
- `test.js`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Steps:**

- [ ] Add failing tests for each eligibility and blocker rule, including cohesive qualifying evidence, unrelated sources not combining into eligibility, stale-only otherwise qualifying evidence, and evidence blocker precedence.
- [ ] Implement evidence resolution with first-valid-record-wins.
- [ ] Implement `evaluateNominationEligibility(candidate, contract)`.
- [ ] Implement `evaluateContractNominationPolicy(contract, options)`.
- [ ] Implement `summarizeNominationPolicy(policyResult)`.
- [ ] Add tests for duplicate evidence IDs, duplicate evidence records, dangling IDs, pre-duplicate eligibility semantics, and summary invariants.
- [ ] Run `node test.js`.
- [ ] Run `git diff --check`.
- [ ] Update execution log and stop for review.

### Task 3: Shadow Store Sanitization

**Files:**

- `src/quality/shadow-store.js`
- `test.js`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Steps:**

- [ ] Add failing persistence tests for `quality.nominationPolicy`.
- [ ] Add hostile payload tests proving raw candidate fields and unknown reason strings do not persist.
- [ ] Add sanitizer for nomination-policy summary counts and enum keys.
- [ ] Enforce non-negative integer counts and summary invariants defensively.
- [ ] Canonicalize malformed or inconsistent summaries to `status: 'policy_failed'` with zero counts and empty maps.
- [ ] Persist `duplicateCheck: 'deferred'` for evaluated and failure summaries.
- [ ] Verify existing step coverage and privacy tests remain green.
- [ ] Run `node test.js`.
- [ ] Run `git diff --check`.
- [ ] Update execution log and stop for review.

### Task 4: Recorder Integration With Nested Fail-Open

**Files:**

- `src/quality/shadow-recorder.js`
- `test.js`
- `.env.example`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Steps:**

- [ ] Add tests for policy disabled, policy enabled, policy failure, privacy-safe failure logging, and shadow-store failure.
- [ ] Import `isQualityNominationPolicyEnabled` and `evaluateContractNominationPolicy`.
- [ ] Run policy only after contract creation and only behind all quality flags.
- [ ] Add the internal `nominationPolicyEvaluator` dependency with the production evaluator as default.
- [ ] Catch policy errors separately, log one bounded `[quality] nomination policy failed` warning without raw error text, and attach a controlled `policy_failed` summary.
- [ ] Add the privacy-canary throw test proving the raw thrown message appears neither in logs nor persisted JSONL.
- [ ] Keep audit event metadata unchanged.
- [ ] Document the new env flag in `.env.example`.
- [ ] Run `node test.js`.
- [ ] Run `git diff --check`.
- [ ] Update execution log and stop for review.

### Task 5: Docs And Controlled Validation

**Files:**

- `docs/superpowers/specs/2026-07-09-answer-evidence-knowledge-quality-design.md`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Steps:**

- [ ] Update the design spec with the implemented PR 2 schema, privacy boundary, feature flag, and success metrics.
- [ ] Rerun the controlled 10-case synthetic Slack validation harness.
- [ ] Record disabled baseline, quality-enabled policy-disabled, and quality-enabled policy-enabled results.
- [ ] Record visible-answer mismatches, nomination mismatches, pre-duplicate candidate metrics, privacy inspection, warning/error counts, fail-open result, and bypass result.
- [ ] Run `node test.js`.
- [ ] Run `git diff --check`.
- [ ] Run `git status --short --branch`.
- [ ] Commit docs/validation after review and stop for final whole-branch review.

## Final Whole-Branch Review Checklist

- [ ] Diff contains only intended PR 2 scope.
- [ ] No `src/handlers/mention.js` changes.
- [ ] No Slack card/text/source-chip/button/action changes.
- [ ] No answerer prompt changes.
- [ ] No live nomination condition changes.
- [ ] No approval-flow changes.
- [ ] No `knowledge.md` behavior changes.
- [ ] No audit payload behavior changes.
- [ ] No database or durable review store.
- [ ] Persistent policy metadata is aggregate/count-only.
- [ ] Policy evaluation uses the same shared bounded normalized evidence/step populations as shadow persistence.
- [ ] Pre-duplicate policy eligibility requires cohesive qualifying evidence from one single resolved evidence record.
- [ ] `duplicateCheck: 'deferred'` is persisted and no PR 2 output is described as final nomination eligibility.
- [ ] Feature flags are strict opt-in.
- [ ] Policy failures do not poison base quality recording.
- [ ] Policy failure logs do not include raw exception messages.
- [ ] `node test.js` passes with 0 failures.
- [ ] `git diff --check` is clean.
- [ ] Controlled validation reports 0 visible-answer mismatches and 0 live nomination mismatches.
