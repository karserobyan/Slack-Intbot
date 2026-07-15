# Shadow Claim-Level Nomination Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task with review gates. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PR 2 shadow-only claim-level nomination policy behind the existing bot. The policy should evaluate individual durable answer claims from the in-memory Answer Evidence Contract, explain why each claim is eligible or blocked, and persist only privacy-safe aggregate nomination-policy summaries. The current live whole-answer nomination workflow must remain unchanged.

**Architecture:** Keep Slack answering and live nomination behavior exactly as-is. `src/handlers/mention.js` already calls `recordQualityShadow` after Slack delivery and history append. PR 2 should extend the quality recorder internally: build the existing Answer Evidence Contract, optionally run a gated in-memory claim-level nomination policy, attach a sanitized count-only summary to the shadow contract, then persist through the existing bounded JSONL store. Policy failures must not prevent the base contract from recording when possible.

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

- `src/quality/nomination-policy.js`
  - New module for in-memory claim candidate construction, eligibility evaluation, allowlisted reason codes, and privacy-safe summary aggregation.

- `src/quality/shadow-recorder.js`
  - Gate and invoke the nomination policy after contract creation.
  - Isolate policy failures so base shadow contract recording can still proceed.
  - Do not change the public Slack answer path or current nomination workflow.

- `src/quality/shadow-store.js`
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
  } catch (err) {
    logger?.warn?.(`[quality] nomination policy failed: ${err.message}`);
    contract.quality.nominationPolicy = {
      version: 1,
      status: 'policy_failed',
      evaluated: false,
      candidateCount: 0,
      eligibleCount: 0,
      blockedCount: 0,
      blockerCounts: { policy_failed: 1 },
      eligibleReasonCounts: {},
      byClaimType: {},
      supportCounts: {},
    };
  }
}

await appendQualityShadowRecord(contract, { now });
```

If candidate policy fails, the base Answer Evidence Contract should still be written when shadow storage itself works. If shadow storage fails, the existing fail-open recorder behavior remains: Slack delivery and current nomination behavior are unchanged.

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
    eligible: false,
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
    eligibleCount: 1,
    blockedCount: 3,
    blockerCounts: {
      unsupported_claim: 1,
      tenant_specific_claim: 1,
      escalation_claim: 1,
    },
    eligibleReasonCounts: {
      specific_integration: 1,
      durable_claim_type: 1,
      direct_evidence: 1,
      safe_evidence: 1,
      supported_source_quality: 1,
      reusable_evidence: 1,
      non_tenant_specific: 1,
    },
    byClaimType: {
      action: 1,
      backend: 1,
      verify: 1,
      escalate: 1,
      step: 0,
    },
    supportCounts: {
      withResolvedEvidence: 3,
      withDirectEvidence: 2,
      withSafeDirectEvidence: 1,
      withSpecialistOnlyEvidence: 1,
      exclusivelySpecialistOnly: 1,
      withHighOrMediumQuality: 2,
      withHighOrMediumReuse: 2,
    },
  },
}
```

The persistent summary is aggregate/count-only. It must not persist candidate IDs, step IDs, evidence IDs from step mappings, claim text, step text, source text, source URLs, source titles, integration names, or free-form explanations.

## Reason Codes

### Blocker Reason Codes

```js
const BLOCKER_CODES = new Set([
  'low_confidence_answer',
  'missing_specific_integration',
  'unsupported_claim',
  'no_direct_evidence',
  'no_safe_direct_evidence',
  'weak_source_quality',
  'low_reuse_value',
  'tenant_specific_claim',
  'specialist_only_evidence',
  'escalation_claim',
  'answer_requires_escalation',
  'generic_placeholder',
  'empty_claim',
  'policy_failed',
]);
```

`policy_failed` is used only for the isolated failure summary when the policy module throws. It is not a normal candidate blocker.

### Eligible Reason Codes

```js
const ELIGIBLE_REASON_CODES = new Set([
  'specific_integration',
  'durable_claim_type',
  'direct_evidence',
  'safe_evidence',
  'supported_source_quality',
  'reusable_evidence',
  'non_tenant_specific',
]);
```

Unknown caller-supplied reason strings must never be persisted.

## Eligibility Policy

A candidate is eligible only when all required positive conditions pass and no blocker is present.

| Rule | Eligible reason | Blocker |
| --- | --- | --- |
| `contract.confidence !== 'low'` | none | `low_confidence_answer` |
| Specific integration is present and not `General`, `Unknown`, `Integration Issue`, or empty | `specific_integration` | `missing_specific_integration` |
| Claim type is `action`, `backend`, or `verify` | `durable_claim_type` | `escalation_claim` for `escalate`; `generic_placeholder` for fallback `step` candidates that lack a durable action tag; `empty_claim` for empty text |
| Candidate has at least one evidence ID resolving to retained evidence | none | `unsupported_claim` |
| At least one resolved evidence record has `directness === 'direct'` | `direct_evidence` | `no_direct_evidence` |
| At least one resolved evidence record has `directness === 'direct'` and `sensitivity === 'safe'` | `safe_evidence` | `no_safe_direct_evidence` |
| At least one resolved evidence record has `sourceQuality === 'high'` or `'medium'` | `supported_source_quality` | `weak_source_quality` |
| At least one resolved evidence record has `reuseValue === 'high'` or `'medium'` | `reusable_evidence` | `low_reuse_value` |
| Candidate is not tenant/customer/account/location-specific | `non_tenant_specific` | `tenant_specific_claim` |
| Candidate does not depend exclusively on specialist-only evidence | none | `specialist_only_evidence` |
| Answer does not require escalation | none | `answer_requires_escalation` |

Important nuance: specialist-only evidence does not automatically block a candidate if there is sufficient safe direct evidence. It blocks only when all resolved supporting evidence is specialist-only or there is no safe direct evidence.

For PR 2, `escalate` claims are always blocked with `escalation_claim`, even if they are operationally useful. Reusable escalation routing can be designed later with a separate policy.

## Candidate Construction

```js
import { makeQualityId, normalizeForQuality, sanitizePreview } from './privacy.js';

const GENERIC_STEP_TEXT = /\b(check|review|investigate|look into|try again|contact support|reach out)\b/i;
const TENANT_SPECIFIC_TEXT = /\b(tenant|customer|account|location)\s*#?\d+\b/i;

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

export function buildClaimCandidates(contract, { now = new Date() } = {}) {
  const steps = Array.isArray(contract?.sections?.steps) ? contract.sections.steps : [];
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
      evidenceIds: Array.isArray(step?.evidenceIds) ? [...new Set(step.evidenceIds)] : [],
      approximateMapping: contract?.quality?.approximateMapping === true,
      tenantSpecific: step?.tenantSpecific === true || TENANT_SPECIFIC_TEXT.test(text),
      genericPlaceholder: !text || GENERIC_STEP_TEXT.test(text) && text.length < 80,
      answerRequiresEscalation,
      eligibility: { eligible: false, reasons: [], blockers: [] },
      evidenceSummary: emptyEvidenceSummary(),
    };
  });
}
```

Implementation note: candidate IDs do not need to be stable across runs because PR 2 does not persist or display candidates. If later PRs need reviewer cards, they should introduce stable candidate hashes with a fresh privacy review.

## Evidence Resolution

Resolve evidence against the contract evidence in memory. The policy should mirror the shadow-store duplicate rule for consistency: first valid evidence record wins.

```js
function evidenceById(evidence = []) {
  const map = new Map();
  for (const item of evidence) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (!id || map.has(id)) continue;
    map.set(id, item);
  }
  return map;
}

function resolveCandidateEvidence(candidate, evidenceMap) {
  return [...new Set(candidate.evidenceIds)]
    .map((id) => evidenceMap.get(id))
    .filter(Boolean);
}
```

Dangling IDs and duplicate IDs within one candidate do not inflate support counts.

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
  'withResolvedEvidence',
  'withDirectEvidence',
  'withSafeDirectEvidence',
  'withSpecialistOnlyEvidence',
  'exclusivelySpecialistOnly',
  'withHighOrMediumQuality',
  'withHighOrMediumReuse',
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

function sanitizeNominationPolicySummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = safeEnum(value.status, NOMINATION_POLICY_STATUS, 'policy_failed');
  return {
    version: 1,
    status,
    evaluated: value.evaluated === true && status === 'evaluated',
    candidateCount: safeNonNegativeInt(value.candidateCount),
    eligibleCount: safeNonNegativeInt(value.eligibleCount),
    blockedCount: safeNonNegativeInt(value.blockedCount),
    blockerCounts: sanitizeCountMap(value.blockerCounts, NOMINATION_BLOCKER_CODES),
    eligibleReasonCounts: sanitizeCountMap(value.eligibleReasonCounts, NOMINATION_ELIGIBLE_REASON_CODES),
    byClaimType: sanitizeCountMap(value.byClaimType, CLAIM_TYPES),
    supportCounts: sanitizeCountMap(value.supportCounts, SUPPORT_COUNT_KEYS),
  };
}
```

After sanitizing, enforce summary invariants:

- `eligibleCount + blockedCount <= candidateCount`
- `candidateCount === sum(byClaimType)` when `byClaimType` is present
- reason/support maps contain only allowlisted keys
- all values are non-negative integers

If incoming values conflict, prefer recomputing the summary in `nomination-policy.js` before persistence. The store sanitizer is the last defensive boundary.

## Failure Isolation

`recordQualityShadow` currently has one `try/catch` around contract creation, shadow write, and audit write. PR 2 should preserve the outer fail-open behavior and add an inner policy boundary:

```js
try {
  const contract = buildAnswerEvidenceContract(...);

  if (isQualityNominationPolicyEnabled()) {
    try {
      const policyResult = evaluateContractNominationPolicy(contract);
      contract.quality.nominationPolicy = policyResult.summary;
    } catch (err) {
      logger?.warn?.(`[quality] nomination policy failed: ${err.message}`);
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
```

Do not add nomination-policy details to `appendQualityAuditEvent` in PR 2. Audit behavior should remain unchanged.

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
- Uses only `contract.sections.steps[]`.
- Maps `action`, `backend`, `verify`, `escalate`, and fallback `step` claim types.
- Preserves raw text and evidence IDs in memory only.
- Marks approximate mapping from `contract.quality.approximateMapping`.
- Marks tenant-specific claims from `step.tenantSpecific` or tenant/customer/account/location numeric text.
- Marks generic placeholders without persisting the text.

### Eligibility Tests

- Eligible: high-confidence, specific integration, `action` claim, direct safe evidence, high source quality, high reuse, non-tenant-specific.
- Eligible: specialist-only evidence present plus safe direct evidence still passes specialist blocker.
- Blocked: low-confidence answer.
- Blocked: missing or generic integration.
- Blocked: unsupported claim with no resolved retained evidence.
- Blocked: dangling evidence IDs.
- Blocked: no direct evidence.
- Blocked: direct evidence exists but none is safe.
- Blocked: weak source quality.
- Blocked: low reuse value.
- Blocked: tenant-specific claim.
- Blocked: exclusively specialist-only evidence.
- Blocked: `escalate` claim.
- Blocked: answer requires escalation.
- Blocked: generic placeholder.
- Blocked: empty claim.
- Duplicate evidence IDs inside one candidate do not inflate counts.
- Duplicate evidence records with conflicting dimensions use first-valid-record-wins.

### Summary Tests

- Summary candidate count equals candidates evaluated.
- Eligible and blocked counts add up to candidate count.
- `blockerCounts` includes only allowlisted blocker codes.
- `eligibleReasonCounts` includes only allowlisted eligible reason codes.
- `byClaimType` includes only controlled claim types.
- `supportCounts` correctly counts resolved/direct/safe-direct/specialist/reuse/source-quality support.
- Unknown/caller reason strings are dropped before persistence.

### Shadow Store Privacy Tests

- Persisted JSONL includes `quality.nominationPolicy` only when policy is enabled and recorder attached a summary.
- Persisted JSONL contains aggregate counts and controlled enum keys only.
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
- Policy module failure logs one bounded `[quality] nomination policy failed:` warning and still records the base shadow contract with a controlled `policy_failed` summary.
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
- non-escalation nomination-eligible case;
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
- eligible claim candidates;
- blocked claim candidates;
- candidate count per answer;
- answers with multiple eligible claims;
- old whole-answer nominations with zero eligible claim candidates;
- answers skipped by old trigger but containing eligible claim candidates;
- blocker distribution;
- eligible reason distribution;
- candidate distribution by answer confidence;
- candidate distribution by claim type;
- support distribution by direct evidence, safe direct evidence, specialist-only evidence, source quality, and reuse value;
- fail-open result;
- bypass result;
- privacy inspection result.

Interpretation rule: these counters are proxy metrics over approximate Phase 1 mappings. A high eligible rate or high direct support rate does not prove semantic correctness until a later answerer contract emits explicit evidence IDs per claim.

## Success Criteria

PR 2 is ready for final review when:

- `node test.js` passes with 0 failures.
- `git diff --check` is clean.
- No files outside the approved scope changed.
- No Slack UX, prompt, nomination, approval, audit, `knowledge.md`, or answer-path behavior changed.
- `QUALITY_NOMINATION_POLICY_ENABLED` is strict opt-in and disabled by default.
- Every normalized step receives an explainable in-memory eligible/blocked decision when policy is enabled.
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

### Task 1: Feature Flag And Policy Module Skeleton

**Files:**

- `src/quality/config.js`
- `src/quality/nomination-policy.js`
- `test.js`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Steps:**

- [ ] Add failing tests for `QUALITY_NOMINATION_POLICY_ENABLED` strict opt-in behavior.
- [ ] Add failing import tests for `src/quality/nomination-policy.js`.
- [ ] Implement `isQualityNominationPolicyEnabled()`.
- [ ] Create `src/quality/nomination-policy.js` with controlled enums, reason-code constants, `buildClaimCandidates`, and `emptyEvidenceSummary`.
- [ ] Add candidate-builder tests for claim type mapping, approximate mapping, tenant-specific detection, and generic placeholder detection.
- [ ] Run `node test.js`.
- [ ] Run `git diff --check`.
- [ ] Update execution log and stop for review.

### Task 2: Eligibility Evaluation And Summary Aggregation

**Files:**

- `src/quality/nomination-policy.js`
- `test.js`
- `docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

**Steps:**

- [ ] Add failing tests for each eligibility and blocker rule.
- [ ] Implement evidence resolution with first-valid-record-wins.
- [ ] Implement `evaluateNominationEligibility(candidate, contract)`.
- [ ] Implement `evaluateContractNominationPolicy(contract, options)`.
- [ ] Implement `summarizeNominationPolicy(policyResult)`.
- [ ] Add tests for duplicate evidence IDs, duplicate evidence records, dangling IDs, and summary invariants.
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

- [ ] Add tests for policy disabled, policy enabled, policy failure, and shadow-store failure.
- [ ] Import `isQualityNominationPolicyEnabled` and `evaluateContractNominationPolicy`.
- [ ] Run policy only after contract creation and only behind all quality flags.
- [ ] Catch policy errors separately, log one bounded warning, and attach a controlled `policy_failed` summary.
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
- [ ] Record visible-answer mismatches, nomination mismatches, candidate metrics, privacy inspection, warning/error counts, fail-open result, and bypass result.
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
- [ ] Feature flags are strict opt-in.
- [ ] Policy failures do not poison base quality recording.
- [ ] `node test.js` passes with 0 failures.
- [ ] `git diff --check` is clean.
- [ ] Controlled validation reports 0 visible-answer mismatches and 0 live nomination mismatches.
