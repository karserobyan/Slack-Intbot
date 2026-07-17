# Answer Evidence And Knowledge Quality Design

## Purpose

This design makes IntegrationsBot better at understanding why an answer is trustworthy before changing how the answer looks to users. The app already answers Slack mentions and DMs successfully. The next product direction is to add an Answer Evidence + Knowledge Quality layer behind the existing bot so search evidence, answer structure, source trust, reviewer feedback, nominations, and approved knowledge updates become one lifecycle.

The first implementation phase must be shadow-mode only. It must not change user-visible Slack answer behavior, must not rewrite the pipeline, and must not promote auto-answer into product scope.

## Product Principle

Preserve the working bot while making the learning loop smarter.

The lifecycle we are designing for is:

```text
search evidence
  -> answer structure
  -> source trust
  -> reviewer feedback
  -> claim-level nomination
  -> approved knowledge.md update
```

The weak approach is to save whole answers as knowledge. A good answer may contain one durable reusable claim, two one-off tenant details, and one escalation instruction. The system must nominate durable claims, not full responses.

## Traceability Requirement

All implementation work that follows this spec should be tracked in a separate execution log:

`docs/superpowers/execution-log/2026-07-09-answer-evidence-knowledge-quality.md`

Each entry should include:

- **Intent:** What was being changed or investigated.
- **Action Taken:** What changed, or what command/check was run.
- **Files Touched:** Exact files, or `None`.
- **Verification:** Test command/result, review result, or why verification was deferred.
- **Decision / Follow-up:** Any tradeoff accepted, rollout decision, or next action.

Specs describe intended behavior. The execution log records what actually happened.

## Branch And Workflow Constraints

- Work must happen on a feature branch, not `main`.
- The requested repo convention is `feature/<short-name>`, but local branch creation for `feature/answer-evidence-quality` failed because the sandbox could not create that namespace under `.git/refs/heads`.
- This design branch uses `codex/answer-evidence-quality`, matching the Codex app default branch prefix.
- Implementation PRs should be small and staged. The first PR must be shadow-mode only.
- Existing user changes, including local instruction artifacts such as `AGENTS.md`, must not be reverted or folded into unrelated commits.
- `node test.js` must pass before implementation PRs are opened.

## In Scope

1. **Answer Evidence Contract**
   - Create a stable internal object that links answer sections and steps to evidence records.
   - Phase 1 may infer these mappings from the current answer object and refs.
   - Phase 1 mappings are approximate and must be treated as shadow metadata.
   - Long-term, the answerer should emit evidence IDs directly for each claim and step.

2. **Source Scoring**
   - Score source quality, directness, freshness, sensitivity, and reuse value independently.
   - Preserve the distinction between trustworthy and reusable. A tenant-specific Jira ticket can be trustworthy but not reusable.

3. **Claim-Level Nominations**
   - Nominate durable reusable claims, not whole answers.
   - Preserve current nomination flow while making candidate creation smarter over time.

4. **Unified Knowledge Review Lifecycle**
   - Feedback and nominations should share one review lifecycle while preserving event type.
   - Supported event types: `nomination`, `correction`, `stale_knowledge_report`, `duplicate_report`, `reviewer_edit`.

5. **Safe knowledge.md Maintenance**
   - Keep `knowledge.md` as the durable knowledge surface for now.
   - Add safer append behavior, dedupe, audit logging, reviewer identity, and pending-state preservation when writes fail.

6. **Success Measurement Before UX Redesign**
   - Collect enough shadow-mode signal to decide whether the contract is useful before redesigning Slack answer cards.

## Out Of Scope

- Full rewrite of the answering pipeline.
- User-visible Slack answer-card redesign in the first PR.
- Database introduction or Redis migration.
- Promoting auto-answer into product scope.
- Replacing `knowledge.md` as the durable knowledge store.
- Replacing existing feedback and nomination buttons in the first PR.
- Making answering depend on the quality layer during shadow mode.

## Final Architecture

The target architecture adds a narrow quality layer between the pipeline result and downstream learning workflows.

```text
src/claude/pipeline.js
  returns current answer object + search refs
        |
        v
src/quality/evidence-contract.js
  normalizeAnswerEvidence()
        |
        v
src/quality/source-scoring.js
  scoreEvidenceSources()
        |
        v
src/quality/nomination-policy.js
  buildClaimCandidates()
        |
        +--> existing Slack rendering stays unchanged initially
        |
        +--> src/quality/knowledge-review.js
             creates review candidates for nominations and feedback
        |
        +--> src/quality/audit-log.js
             records shadow metadata, reviewer decisions, and knowledge writes
```

### Fail-Open Requirement

The quality layer must be fail-open for answering.

If normalization, scoring, candidate creation, storage, or audit logging fails:

1. Log a bounded error with stable context.
2. Return the existing answer to Slack exactly as the bot does today.
3. Skip smarter nomination and quality metadata for that request.
4. Never block, degrade, or alter the user-visible answer.

## New Modules

### `src/quality/evidence-contract.js`

Owns conversion from the current answer object into an internal contract.

Primary exports:

```js
export function buildAnswerEvidenceContract({
  answer,
  query,
  role,
  threadTs,
  channelId,
  searchResults,
  now = new Date(),
});

export function isValidAnswerEvidenceContract(contract);
```

Phase 1 inference is approximate:

- Diagnosis maps to all visible refs unless stronger evidence IDs exist.
- Steps map to refs by basic integration/symptom keyword overlap.
- Customer message maps to diagnosis and safe action steps.
- Escalation maps to confidence, channel recommendation, and source sensitivity.

Long-term answerer behavior:

- The answerer should emit stable evidence IDs for `findings_summary`, `agent_steps`, `customer_message`, and escalation reason.
- The contract builder should then validate model-supplied IDs instead of inferring links.

### `src/quality/source-scoring.js`

Owns source classification and scoring. This should not replace `src/slack/source-policy.js`; it should build on it. `source-policy.js` remains the CSA/specialist rendering safety boundary.

Primary exports:

```js
export function scoreEvidenceSource(source, { query, integrationType, now = new Date() });
export function scoreEvidenceSources(sources, context);
```

### `src/quality/nomination-policy.js`

Owns claim-level nomination eligibility.

Primary exports:

```js
export function buildClaimCandidates(contract);
export function evaluateNominationEligibility(claim, contract);
```

### `src/quality/knowledge-review.js`

Owns unified review candidates for nominations and feedback corrections.

Primary exports:

```js
export async function createReviewCandidate(candidate);
export async function approveReviewCandidate(id, reviewer);
export async function rejectReviewCandidate(id, reviewer, reason);
export async function markReviewCandidateNeedsEdit(id, reviewer, reason);
```

### `src/quality/audit-log.js`

Owns append-only audit events.

Primary exports:

```js
export async function appendQualityAuditEvent(event);
export async function readRecentQualityAuditEvents(limit);
```

## Files Likely Affected

### First PR: Shadow Mode Only

- `src/handlers/mention.js`
  - Call the quality layer after the pipeline result is available and before current nomination logic.
  - Wrap all quality calls in `try/catch`.
  - Do not change Slack rendering.

- `src/claude/pipeline.js`
  - Optionally expose enough search-result metadata for contract building if not already available at the call site.
  - Do not change model prompts in PR 1 unless strictly needed for metadata passthrough.

- `src/quality/evidence-contract.js`
  - New module.

- `src/quality/source-scoring.js`
  - New module.

- `src/quality/nomination-policy.js`
  - New module.

- `src/quality/audit-log.js`
  - New module.

- `test.js`
  - Add no-framework `assert` tests for contract creation, scoring, nomination policy, and fail-open behavior.

### Later PRs

- `src/slack/nominations.js`
  - Route nomination creation through claim candidates.
  - Preserve existing approve/reject action IDs until a later UX pass.

- `src/slack/feedback.js`
  - Convert approved feedback into correction candidates.
  - Preserve existing feedback files during migration.

- `src/slack/review-actions.js`
  - Add reviewer identity to quality audit events.
  - Later add `needs_edit`.

- `src/slack/knowledge-writer.js`
  - Add dedupe and audit-aware append behavior.
  - Preserve pending state when writes fail.

- `src/slack/blocks.js`
  - Later only: display richer source context after success metrics prove the contract is useful.

- `docs/functionality-overview.md`
  - Document the quality lifecycle once implementation begins.

## Exact Object Schemas

These schemas are intentionally plain JavaScript objects to match the current codebase style.

### Answer Evidence Contract

```js
{
  version: 1,
  answerId: 'ans_...',
  createdAt: '2026-07-09T00:00:00.000Z',
  mode: 'shadow',
  queryHash: 'sha256:...',
  queryPreview: 'short sanitized preview',
  role: 'csa',
  channelId: 'C...',
  threadTs: '123.456',
  issueTitle: 'Zapier API access',
  integrationType: 'Zapier',
  confidence: 'high',
  confidenceReason: 'direct evidence found for integration and symptom',
  sections: {
    diagnosis: {
      text: 'Zapier API access is disabled for the tenant.',
      evidenceIds: ['ev_1'],
      trust: 'direct'
    },
    customerMessage: {
      text: 'Hi [Name]...',
      evidenceIds: ['ev_1'],
      trust: 'direct'
    },
    escalation: {
      shouldEscalate: false,
      reason: 'CSA can resolve with known backend enablement path.',
      escalationPath: null,
      evidenceIds: ['ev_1'],
      trust: 'direct'
    },
    steps: [
      {
        id: 'claim_1',
        num: 1,
        title: 'Enable Zapier API access',
        detail: 'Enable Zapier API access on the ServiceTitan backend for this tenant.',
        tag: 'backend',
        evidenceIds: ['ev_1', 'ev_2'],
        trust: 'direct',
        reusable: true,
        tenantSpecific: false,
        nominationEligible: false
      }
    ]
  },
  evidence: [
    {
      id: 'ev_1',
      source: 'confluence',
      urlHash: 'sha256:...',
      hostname: 'servicetitan.atlassian.net',
      title: 'Zapier setup',
      snippetPreview: 'short sanitized preview',
      sourceQuality: 'high',
      directness: 'direct',
      freshness: 'unknown',
      sensitivity: 'safe',
      reuseValue: 'high',
      matchedIntegration: true,
      matchedSymptom: true,
      reasons: ['integration_match', 'symptom_match', 'actionable_resolution']
    }
  ],
  quality: {
    directAnswer: true,
    reusableKnowledge: true,
    nominationEligible: false,
    approximateMapping: true,
    reasons: ['direct_source_match', 'reusable_backend_claim'],
    stepCoverage: {
      stepCount: 1,
      mappedStepCount: 1,
      directMappedStepCount: 1,
      unsupportedStepCount: 0
    }
  }
}
```

### Evidence Source Score

```js
{
  id: 'ev_1',
  sourceQuality: 'high',
  directness: 'direct',
  freshness: 'unknown',
  sensitivity: 'safe',
  reuseValue: 'high',
  reasons: ['integration_match', 'symptom_match']
}
```

The five dimensions must remain separate. Do not collapse them into a single score.

### Claim Candidate

```js
{
  version: 1,
  candidateId: 'qc_...',
  answerId: 'ans_...',
  sourceStepId: 'claim_1',
  claimOrdinal: 1,
  claimType: 'backend',
  integrationType: 'Zapier',
  text: 'Enable Zapier API access in ServiceTitan backend settings before reconnecting.',
  evidenceIds: ['ev_1', 'ev_2'],
  approximateMapping: true,
  tenantSpecific: false,
  genericPlaceholder: false,
  answerRequiresEscalation: false,
  eligibility: {
    preDuplicateEligible: true,
    reasons: [
      'specific_integration',
      'durable_claim_type',
      'direct_evidence',
      'safe_evidence',
      'supported_source_quality',
      'reusable_evidence',
      'non_tenant_specific'
    ],
    blockers: []
  },
  evidenceSummary: {
    resolvedCount: 2,
    directCount: 1,
    safeDirectCount: 1,
    qualifyingEvidenceCount: 1,
    freshQualifyingEvidenceCount: 0,
    unknownFreshnessQualifyingEvidenceCount: 1,
    staleOtherwiseQualifyingEvidenceCount: 0
  }
}
```

This raw candidate is in memory only. PR 2 persistence stores aggregate `quality.nominationPolicy` summaries with `duplicateCheck: 'deferred'`, not candidate text, step IDs, evidence mappings, or proposed knowledge entries.

### Review Candidate

```js
{
  id: 'qr_...',
  version: 1,
  eventType: 'nomination',
  status: 'pending',
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
  createdBy: {
    type: 'bot',
    userId: null
  },
  answerId: 'ans_...',
  sourceFeedbackId: null,
  sourceNominationId: null,
  integrationType: 'Zapier',
  issueTitle: 'Zapier API access',
  claim: {
    text: 'Enable Zapier API access on the ServiceTitan backend for this tenant.',
    evidenceIds: ['ev_1', 'ev_2'],
    reusable: true,
    sensitivity: 'safe'
  },
  eventPayload: {
    nomination: {
      proposedKnowledgeEntry: '- [auto, 2026-07-09] ...'
    },
    correction: null,
    staleKnowledgeReport: null,
    duplicateReport: null,
    reviewerEdit: null
  },
  review: {
    reviewerUserId: null,
    reviewerName: null,
    decision: null,
    reason: null,
    decidedAt: null
  },
  write: {
    target: 'knowledge.md',
    status: 'not_attempted',
    error: null,
    writtenAt: null
  }
}
```

Allowed `eventType` values:

- `nomination`
- `correction`
- `stale_knowledge_report`
- `duplicate_report`
- `reviewer_edit`

Allowed `status` values:

- `pending`
- `needs_edit`
- `approved`
- `rejected`
- `superseded`
- `write_failed`

### Quality Audit Event

```js
{
  id: 'qa_...',
  timestamp: '2026-07-09T00:00:00.000Z',
  type: 'contract_created',
  actor: {
    type: 'bot',
    userId: null,
    userHash: null
  },
  entity: {
    type: 'answer_contract',
    id: 'ans_...'
  },
  metadata: {
    queryHash: 'sha256:...',
    integrationTypeHash: 'sha256:...',
    nominationEligible: true,
    approximateMapping: true,
    reasons: ['shadow_mode']
  }
}
```

Persistent audit metadata must avoid raw previews, free-text reasons, raw secrets, PII, customer payloads, source snippets, raw URLs, and actor display names. The in-memory Answer Evidence Contract can still carry short sanitized previews in Phase 1; JSONL persistence should store hashes, IDs, booleans/statuses, enum dimensions, allowlisted reason codes, approximate mapping state, hash-only integration correlation, and only controlled allowlisted hostnames.

## Source Scoring Rules

### Source Quality

`sourceQuality` describes whether the source itself is credible.

- `high`
  - ServiceTitan-owned KB, Confluence, or clear Slack answer from a known support/escalation context.
  - Jira ticket with resolved outcome and enough context to understand the fix.

- `medium`
  - Slack discussion with partial agreement but no final confirmed resolution.
  - Jira ticket still in progress but with useful diagnosis.
  - Older Confluence page with no contradictory evidence.

- `low`
  - Ambiguous Slack mention.
  - Generic KB page that does not address the symptom.
  - Source with no actionable resolution.

### Source Directness

`directness` describes whether the source matches this user query.

- `direct`
  - Matches integration and symptom.
  - Provides an actionable resolution or clear escalation path.

- `related`
  - Matches integration but different symptom.
  - Matches symptom but different integration.
  - Useful for framing but not enough to justify specific steps.

- `background`
  - General setup docs, definitions, or broad process guidance.
  - Can support context, not claims.

### Source Freshness

`freshness` describes temporal risk.

- `fresh`
  - Recent or explicitly still current.
  - For Slack/Jira, prefer recent resolved discussions.

- `stale`
  - Old source for a system that may have changed.
  - Source contradicts newer material.

- `unknown`
  - No reliable date or freshness signal.

### Source Sensitivity

`sensitivity` describes who may see it.

- `safe`
  - Safe for CSA-facing source display and knowledge entries.

- `specialist_only`
  - Internal escalation, engineering-only, pricing/contract, PII, security, backend-only sensitive details, or model/code policy says sensitive.

This dimension must continue to use or preserve `src/slack/source-policy.js`.

### Reuse Value

`reuseValue` describes whether the source supports durable knowledge.

- `high`
  - Reusable process, known integration setup, recurring troubleshooting step.

- `medium`
  - Reusable pattern with caveats.

- `low`
  - Tenant-specific, customer-specific, incident-specific, or one-off escalation context.

Important examples:

- A tenant-specific Jira ticket can be `sourceQuality: high`, `directness: direct`, and `reuseValue: low`.
- A common setup pattern can be `reuseValue: high` but `sourceQuality: low` if only loosely supported by a weak Slack thread.

## Answer Sections To Source Mapping

### Diagnosis

Diagnosis should require `direct` or strong `related` evidence. If the source mapping is inferred in Phase 1, mark `approximateMapping: true`.

### Agent Steps

Steps are the main claim source for nominations.

- `action`, `backend`, and `verify` steps may become claim candidates.
- `escalate` steps should not become durable knowledge unless they describe a reusable routing rule.
- A step with no evidence IDs may render, but must not be nomination eligible.

### Customer Message

Customer message should map only to CSA-safe evidence and safe steps.

If a customer message depends on specialist-only evidence, the quality layer should flag it but not block rendering in shadow mode.

### Escalation Decision

Escalation should map to:

- confidence
- source directness
- source sensitivity
- unsupported or low-reuse claims
- backend/access requirements

Escalation metadata is useful for later UX, but it should not change current answer behavior in PR 1.

## Nomination Policy Rules

Nominations are claim-level. A whole answer is never the nomination unit.

### PR 2 Pre-Duplicate Policy-Eligible Claims

PR 2 must not describe candidates as final nomination-eligible. Duplicate detection is intentionally deferred, so the correct runtime and reporting term is `preDuplicateEligible` or pre-duplicate policy-eligible.

A claim is pre-duplicate policy-eligible when all are true:

- It has a specific integration type.
- It is a durable resolution, verification, or setup rule.
- The answer is not low confidence.
- It is not tenant-specific.
- The answer does not require unresolved escalation.
- It has at least one single cohesive evidence record that simultaneously has:
  - `directness: direct`
  - `sensitivity: safe`
  - `sourceQuality: high` or `medium`
  - `reuseValue: high` or `medium`
  - `freshness: fresh` or `unknown`

Do not allow separate unrelated evidence records to independently satisfy the directness, sensitivity, quality, reuse, and freshness requirements.

PR 2 must persist:

```js
duplicateCheck: 'deferred'
```

These candidates must not drive live nominations until duplicate detection is added.

### Blocked Claims

A claim is blocked when any are true:

- It only has weak or background evidence.
- It is customer-specific, tenant-specific, or incident-specific.
- It depends on PII, pricing, contracts, security details, or internal backend-only context.
- It is merely a suggested channel post or customer-facing message.
- It is a generic troubleshooting placeholder.
- It is an escalation instruction without durable integration knowledge.
- It has all otherwise qualifying evidence stale.
- It has a fallback non-durable claim type.
- Duplicate checks are deferred in PR 2 and must not create runtime duplicate decisions.
- It conflicts with newer knowledge.

### Candidate Output

The policy should return both pre-duplicate policy-eligible and blocked candidates in shadow mode so we can measure whether claim-level nomination would improve the current whole-answer trigger. PR 2 must not send these candidates to the existing live nomination workflow.

Evidence blocker precedence:

1. No resolved evidence -> `unsupported_claim`.
2. Resolved but no direct evidence -> `no_direct_evidence`.
3. Direct but no safe direct evidence -> `no_safe_direct_evidence`.
4. Then evaluate stale evidence, source quality, and reuse against the direct-safe evidence population.

Avoid adding weak-quality and low-reuse blockers to a claim that has no resolved evidence.

### Implemented PR 2 Runtime Boundary

PR 2 implements claim-level nomination policy in shadow mode only.

Activation is strict opt-in:

- `QUALITY_LAYER_ENABLED` must be exactly `true` (case-insensitive).
- `QUALITY_LAYER_SHADOW_MODE` must allow shadow mode.
- `QUALITY_NOMINATION_POLICY_ENABLED` must be exactly `true` (case-insensitive).
- Unset, empty, `false`, `0`, `off`, or typo values keep the nomination policy disabled.

The implemented policy uses the shared bounded normalization in `src/quality/shadow-normalization.js`:

- Evidence is normalized with the same ID validation, ten-record persistence limit, enum clamping, URL hashing, hostname/reason allowlists, and first-valid-record-wins resolution used by shadow persistence.
- Steps are normalized through the same malformed-step filtering and 1,000-step bound used for step coverage.
- Claim candidates are created one per valid normalized answer step.
- Candidate claim text, source step IDs, evidence mappings, and candidate objects remain in memory only.
- Candidate builders map `action`, `backend`, `verify`, `escalate`, and fallback `step` claim types.
- Caller-supplied `nominationEligible`, `eligibility`, `reasons`, and `blockers` are ignored.
- The current approximate mapping state is preserved.

The implemented evaluator returns in-memory candidates plus an aggregate summary, but `recordQualityShadow()` attaches and persists only the aggregate `quality.nominationPolicy` summary. The persisted summary is pre-duplicate policy eligibility, not final nomination eligibility:

- `duplicateCheck` is always `deferred`.
- Duplicate detection has not run.
- Candidate summaries must not drive live nomination cards yet.
- Current whole-answer nomination behavior remains unchanged.

Canonical evaluated summary:

```js
{
  version: 1,
  status: 'evaluated',
  evaluated: true,
  duplicateCheck: 'deferred',
  candidateCount,
  preDuplicateEligibleCount,
  blockedCount,
  blockerCounts,
  eligibleReasonCounts,
  byClaimType,
  supportCounts,
}
```

Canonical policy-failure summary:

```js
{
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
}
```

Policy failures are isolated inside the recorder:

- Synchronous evaluator throws, rejected evaluator promises, missing summaries, and non-object summaries produce a canonical `policy_failed` summary.
- Each failure receives a fresh summary object and fresh nested maps; mutation of one returned contract must not affect a later request.
- The warning is a single generic `[quality] nomination policy failed` message with no raw exception text.
- Shadow/audit writes still proceed when possible.
- Audit payload shape remains unchanged and does not include nomination-policy fields.

Remaining PR 2 limitations:

- Evidence mapping is still approximate.
- Passing the policy does not prove semantic correctness.
- Duplicate detection is deferred.
- Candidate arrays are intentionally not persisted.
- Candidates must not drive live nomination cards yet.
- PR 2 measures whether the policy looks useful enough to plan PR 3; it is not approval to replace the live nomination workflow.

## Review Candidate Lifecycle

Feedback and nominations should share one review candidate lifecycle while preserving event type.

```text
created
  -> pending
  -> approved -> write attempted -> approved or write_failed
  -> rejected
  -> needs_edit -> reviewer_edit candidate -> pending
  -> superseded
```

### Event Types

- `nomination`
  - Created from an eligible durable claim.

- `correction`
  - Created from Wrong Answer feedback.
  - Should preserve original query, issue title, integration, feedback type, correction text, and source answer ID when available.

- `stale_knowledge_report`
  - Future event type for marking an existing knowledge entry as stale.

- `duplicate_report`
  - Future event type for marking duplicate or overlapping knowledge entries.

- `reviewer_edit`
  - Created when a reviewer chooses `Needs edit` and submits corrected wording.

### Reviewer Actions

Initial supported actions:

- Approve
- Reject

Next supported action:

- Needs edit

Do not block the first quality-layer PR on adding edit modals. First, establish candidate creation, storage, audit events, and safe writes.

## Safe knowledge.md Write Behavior

`knowledge.md` remains the durable knowledge surface.

The quality layer should improve append safety without replacing the file.

### Before Write

- Normalize integration name.
- Normalize claim text for dedupe.
- Check existing `knowledge.md` section for materially equivalent entries.
- Check source URLs already present in the section.
- Reject or mark duplicate when equivalent knowledge exists.
- Preserve pending candidate if validation fails unexpectedly.

### During Write

- Use existing serialized write behavior in `src/slack/knowledge-writer.js`.
- Append under the integration section.
- Include enough evidence summary to make the entry reviewable later.
- Do not include specialist-only source URLs in CSA-facing knowledge entries.

Example target format:

```md
## Zapier
- [auto, 2026-07-09] Zapier API access: Enable Zapier API access on the ServiceTitan backend for the tenant. Evidence: Confluence direct match, Slack related match.
```

### After Write

- Append audit event with reviewer identity, candidate ID, integration, normalized claim hash, and write result.
- Clear or invalidate relevant in-memory knowledge cache.
- Remove candidate from pending only after write succeeds.
- If write fails, keep candidate pending or mark `write_failed`; do not silently drop it.

## Storage Plan

No database in this phase.

Likely file-backed stores under `data/`:

- `data/quality-shadow.jsonl`
  - Shadow-mode contract summaries and scoring output.
  - Retention policy for PR 1:
    - Keep at most 2,000 records.
    - Keep at most 14 days of records.
    - Keep the file under 5 MB.
    - On append, prune when any limit is exceeded by keeping the newest records that satisfy all three limits.
  - Store sanitized summaries only. Do not store full raw snippets, customer-sensitive text, secrets, PII, request headers, full model prompts, or large payloads.
  - Persist `quality` as count-only and enum/boolean metadata:
    - `directAnswer`
    - `reusableKnowledge`
    - `nominationEligible`
    - `approximateMapping`
    - `reasons`
    - `stepCoverage`
      - `stepCount`
      - `mappedStepCount`
      - `directMappedStepCount`
      - `unsupportedStepCount`
    - `nominationPolicy` when PR 2 policy is enabled
      - `version`
      - `status`
      - `evaluated`
      - `duplicateCheck: 'deferred'`
      - `candidateCount`
      - `preDuplicateEligibleCount`
      - `blockedCount`
      - `blockerCounts`
      - `eligibleReasonCounts`
      - `byClaimType`
      - `supportCounts`
  - `quality.stepCoverage` counts are derived by `src/quality/shadow-store.js`, not trusted from caller-supplied `quality.stepCoverage` values.
  - The shadow serializer computes the sanitized/retained `evidence[]` array once. That exact array is both persisted and used for coverage calculation.
  - Only valid normalized step objects from `sections.steps[]` count toward `stepCount`, and the step population is bounded before coverage is calculated.
  - A step is mapped only when at least one sanitized evidence ID resolves to a retained persisted evidence record.
  - Evidence dropped by ID validation, evidence sanitization, or the ten-record persistence limit does not count toward mapped coverage.
  - Dangling evidence IDs do not count, and duplicate IDs within a step do not inflate counts.
  - Duplicate persisted evidence records use first-valid-record-wins; later records with the same ID do not alter mapped or direct coverage.
  - `directMappedStepCount` requires retained evidence whose clamped `directness` value is exactly `direct`.
  - Zero-step answers produce four zeroes.
  - Step coverage invariants:
    - `mappedStepCount + unsupportedStepCount === stepCount`
    - `directMappedStepCount <= mappedStepCount`
  - Step coverage persistence remains count-only and must not add step IDs or mappings, step titles/details/tags, source titles/snippets/URLs, query/customer text, diagnosis/customer-message/escalation prose, or other customer payload text.
  - `quality.nominationPolicy` is aggregate/count-only. It must not persist candidate IDs, step IDs, step ordinals, evidence IDs from step mappings, claim text, step titles/details/tags, integration names, source titles/snippets/URLs/channels, raw queries, customer text, diagnosis/customer-message/escalation prose, names, emails, phone numbers, tenant/account/location text, prompts, headers, payloads, unknown reason strings, or policy exception messages.
  - For `status: evaluated`, PR 2 nomination-policy summaries must enforce:
    - `preDuplicateEligibleCount + blockedCount === candidateCount`
    - `candidateCount === sum(byClaimType)`
    - every `supportCounts` value is `<= candidateCount`
  - For `status: policy_failed`, `evaluated` is false, candidate counts are zero, maps are empty, and the status itself represents the failure.
  - Every isolated policy failure must receive a fresh canonical `policy_failed` object and fresh nested maps.
  - Malformed or inconsistent caller-supplied nomination-policy summaries should canonicalize to a controlled `policy_failed` summary or be omitted.

- `data/quality-candidates.json`
  - Unified pending review candidates.

- `data/quality-audit.jsonl`
  - Append-only audit events.
  - Store actor IDs, entity IDs, hashes, status values, booleans, enum dimensions, approximate mapping state, controlled allowlisted hostnames, and allowlisted reason codes only. Do not store source titles, short previews, free-text reasons, full customer payloads, raw source bodies, raw URLs, arbitrary hostnames, or actor display names.

All files should be gitignored through the existing `data/` ignore behavior.

## Feature Flags

Feature flags should default to safe behavior.

```text
QUALITY_LAYER_ENABLED=false
QUALITY_LAYER_SHADOW_MODE=true
QUALITY_NOMINATION_POLICY_ENABLED=false
QUALITY_REVIEW_STORE_ENABLED=false
QUALITY_KNOWLEDGE_WRITE_ENABLED=false
QUALITY_AUDIT_ENABLED=true
```

Recommended rollout defaults:

- PR 1:
  - `QUALITY_LAYER_ENABLED=true`
  - `QUALITY_LAYER_SHADOW_MODE=true`
  - all behavior-changing flags false

- PR 2:
  - `QUALITY_LAYER_ENABLED=true`
  - `QUALITY_LAYER_SHADOW_MODE=true`
  - `QUALITY_NOMINATION_POLICY_ENABLED=true`
  - current live nomination behavior still unchanged

- Later PRs:
  - Enable claim-level nomination cards only after PR 2 shadow metrics look acceptable and duplicate detection is designed.
  - Enable unified review store after compatibility tests pass.
  - Enable quality-controlled knowledge writes after reviewer flow is stable.

If `QUALITY_LAYER_ENABLED=false`, the app should behave exactly as it does today.

`QUALITY_NOMINATION_POLICY_ENABLED` is strict opt-in. Only the literal value `true`, case-insensitive, enables it. The flag has no effect unless the base quality layer is enabled and shadow mode is active.

## Success Measurement Before Answer UX Redesign

Do not redesign Slack answer cards until the quality layer proves useful.

Minimum shadow-mode metrics:

- Contract creation success rate.
- Percent of answers with at least one direct evidence mapping.
- Step coverage counts:
  - total answer steps
  - steps with retained evidence mappings
  - steps with direct retained evidence
  - unsupported steps
- Percent of steps marked reusable.
- Candidate generation rate per answer.
- Pre-duplicate policy-eligible vs blocked claim ratio.
- Reasons for blocked nominations.
- Count of candidates awaiting duplicate detection.
- False positive sample rate from manual review.
- Any quality-layer failures that would have affected answering if not fail-open.

These step coverage metrics measure the current approximate Phase 1 mapper. They do not prove every mapping is semantically correct. The longer-term direction remains explicit evidence IDs emitted by the answerer for each claim and step.

Decision threshold before answer UX redesign:

- Contract creation succeeds for nearly all normal answers.
- Most high-confidence answers produce sensible evidence mappings.
- Nomination candidates are specific claims, not noisy whole-answer summaries.
- Reviewers agree that candidate cards reduce review effort.
- No observed quality-layer failure changes the user-visible answer.

## Phased Rollout

### Phase 1: Shadow Contract And Source Scoring

Goal: Build metadata without changing behavior.

Behavior:

- Build answer evidence contract from current answer and refs.
- Score evidence dimensions.
- Write bounded shadow metadata/audit events.
- Log summary metrics.
- Do not change Slack rendering.
- Do not change nomination behavior yet unless wrapped in no-op/shadow output.
- Fail open on every quality-layer error.

### Phase 2: Shadow Claim Candidates

Goal: Learn whether claim-level nominations are good.

Behavior:

- Generate claim candidates from answer steps.
- Mark candidates pre-duplicate policy-eligible or blocked with reasons.
- Persist `duplicateCheck: 'deferred'`; do not make final nomination-eligibility claims.
- Store shadow candidate summaries.
- Continue using existing nomination behavior for live review.
- Compare old nomination trigger vs new claim-level policy.

### Phase 3: Smarter Nominations

Goal: Replace whole-answer nomination with claim-level nomination.

Behavior:

- Use eligible claim candidates to build nomination review cards.
- Keep existing approve/reject action IDs where possible.
- Show evidence/trust context in nomination card.
- Preserve existing pending nomination storage until migration is proven.

### Phase 4: Unified Review Candidate Store

Goal: Route feedback and nominations through one lifecycle.

Behavior:

- Create `quality_review_candidate` records for nominations and corrections.
- Preserve event type.
- Keep legacy feedback and nomination files readable.
- Dual-write or compatibility-write during migration.
- Add audit events for reviewer decisions.

### Phase 5: Safe Knowledge Writes

Goal: Make approved knowledge changes safer.

Behavior:

- Add dedupe before appending to `knowledge.md`.
- Preserve pending state on write failure.
- Add reviewer identity and audit logs.
- Add `needs_edit` path after approve/reject stability.

### Phase 6: Answer UX Redesign

Goal: Improve Slack answer structure only after metadata is reliable.

Behavior:

- Show source-backed diagnosis.
- Clarify which steps are evidence-backed.
- Show source explanations instead of simple chips.
- Avoid exposing specialist-only evidence to CSAs.
- Use quality metrics to decide what to show.

## Rollback Plan

Rollback must be simple at every phase.

- Disable `QUALITY_LAYER_ENABLED` to bypass all quality-layer behavior.
- Disable `QUALITY_NOMINATION_POLICY_ENABLED` to return to existing nomination policy.
- Disable `QUALITY_REVIEW_STORE_ENABLED` to return to legacy feedback/nomination stores.
- Disable `QUALITY_KNOWLEDGE_WRITE_ENABLED` to prevent quality-controlled writes.
- Because Phase 1 is shadow-only and fail-open, rollback should not require data migration.
- Shadow/audit files can be left on disk; they should not be read by the answer path when disabled.

## Migration Safety

- Do not migrate existing feedback or nominations in PR 1.
- Do not remove existing files.
- Do not make existing approve/reject handlers depend on new quality files until compatibility tests exist.
- When unified review storage begins, prefer dual-read/dual-write:
  - Existing feedback and nomination files remain source of truth.
  - Quality candidates mirror or reference legacy IDs.
  - Cutover happens only after pending-state preservation is proven.
- If any knowledge write fails, preserve pending state and surface a controlled reviewer message.

## Test Plan

All tests should be added to `test.js` using the existing plain `assert` style.

### Contract Tests

- Builds a valid contract from a normal answer with Slack, Atlassian, and KB refs.
- Marks Phase 1 mappings as `approximateMapping: true`.
- Keeps rendering-compatible answer fields unchanged.
- Handles missing refs without throwing.
- Handles missing optional answer sections without throwing.

### Source Scoring Tests

- Separates quality, directness, freshness, sensitivity, and reuse value.
- Scores exact integration + symptom source as direct.
- Scores tenant-specific Jira as high quality but low reuse.
- Preserves specialist-only sensitivity from `source-policy`.
- Does not mark background docs as direct evidence.

### Nomination Policy Tests

- Creates claim candidate from a reusable supported step.
- Blocks whole-answer nomination.
- Blocks unsupported step.
- Blocks unrelated evidence records that only collectively satisfy direct/safe/quality/reuse/freshness.
- Blocks otherwise qualifying stale-only evidence with `stale_evidence`.
- Blocks tenant-specific claim.
- Blocks specialist-only evidence for CSA-facing knowledge.
- Marks duplicate checking as `duplicateCheck: 'deferred'`; PR 2 does not block duplicates.
- Blocks fallback step claims with `non_durable_claim_type`.
- Distinguishes vague placeholders such as `Investigate further` from concrete actions such as `Check the OAuth mapping in Settings`.
- Returns blocked reasons for shadow metrics.
- Logs policy failures without raw exception messages.

### Review Candidate Tests

- Preserves `eventType` for nomination and correction.
- Allows `nomination`, `correction`, `stale_knowledge_report`, `duplicate_report`, and `reviewer_edit`.
- Keeps pending state when write fails.
- Records reviewer identity on approve/reject.
- Marks write failure without deleting candidate.

### knowledge.md Safety Tests

- Dedupes equivalent normalized claim text.
- Dedupes repeated source URLs.
- Appends under the correct integration section.
- Does not include specialist-only source URLs in CSA-facing entries.
- Clears knowledge cache only after successful write.

### Fail-Open Tests

- Quality contract failure does not prevent Slack response rendering.
- Audit log failure does not prevent Slack response rendering.
- Candidate creation failure skips smarter nomination and leaves existing answer behavior intact.

### Regression Tests

- Existing feedback flow still saves pending feedback.
- Existing nomination approve/reject still works until deliberately migrated.
- Existing response block builders still produce valid blocks.
- `node test.js` passes with 0 failures.

## Phased PR Sequence

### PR 1: Shadow Contract And Source Scoring

Scope:

- Add `src/quality/evidence-contract.js`.
- Add `src/quality/source-scoring.js`.
- Add `src/quality/audit-log.js`.
- Call quality layer from `src/handlers/mention.js` behind flags.
- Add shadow-only tests.
- No user-visible Slack behavior changes.

Success:

- Existing answers still render.
- Shadow metadata is created when enabled.
- Any quality error is logged and skipped.
- `node test.js` passes.

### PR 2: Shadow Claim-Level Nomination Policy

Scope:

- Add shared evidence/step normalization for shadow persistence and policy evaluation.
- Add `src/quality/nomination-policy.js`.
- Generate pre-duplicate policy-eligible and blocked claim candidates.
- Store/log shadow candidate summaries.
- Do not replace live nomination cards yet.

Success:

- Old nomination behavior still works.
- New policy produces explainable pre-duplicate policy-eligible or blocked decisions.
- Policy decisions require cohesive qualifying evidence and persist `duplicateCheck: 'deferred'`.
- Metrics show whether claim-level nominations are useful.
- No Slack answer card, answer text, source chip, button, action ID, live nomination card, approval flow, prompt, `knowledge.md`, or audit payload shape changes.

### PR 3: Claim-Level Nomination Review Cards

Scope:

- Update `src/slack/nominations.js` to accept claim candidates.
- Show evidence/trust context in nomination cards.
- Keep approve/reject action IDs compatible.
- Preserve pending nomination storage semantics.

Success:

- Reviewers see claim-level cards.
- Existing approvals continue to use the current append path without changing write semantics.
- PR 3 must not claim dedupe, audit-aware write safety, or stronger `knowledge.md` write guarantees; those belong to PR 5.
- No whole-answer nomination cards are generated by the new policy.

### PR 4: Unified Review Candidate Store

Scope:

- Add `src/quality/knowledge-review.js`.
- Mirror nominations and feedback into unified review candidates.
- Preserve event type.
- Add audit events for reviewer decisions.
- Keep legacy storage compatible.

Success:

- Feedback and nominations share lifecycle metadata.
- Legacy flows still work.
- Candidate write failure preserves pending state.

### PR 5: Safe Knowledge Writes

Scope:

- Harden `src/slack/knowledge-writer.js` with claim dedupe and audit context.
- Add reviewer identity to approved writes.
- Preserve pending candidates on write failure.
- Add `needs_edit` status support if review flow is ready.

Success:

- Duplicate knowledge is blocked or marked duplicate.
- Approved writes are auditable.
- Failed writes do not lose review candidates.

### PR 6: Answer UX Redesign

Scope:

- Redesign Slack answer card only after success metrics justify it.
- Show evidence-backed diagnosis and clearer source explanations.
- Keep CSA/specialist source filtering enforced in code.

Success:

- UX changes are backed by trustworthy contract metadata.
- No specialist-only evidence leaks to CSAs.
- Reviewers report better source clarity.

## What Must Stay Unchanged Initially

- Slack mention and DM answer flow.
- Current response card structure.
- Current answerer prompt shape unless metadata passthrough is strictly required later.
- Existing feedback button behavior.
- Existing nomination approve/reject behavior in PR 1.
- `knowledge.md` as durable knowledge store.
- Auto-answer remains local-only and out of product scope.

## Open Technical Decisions

These decisions should be resolved during implementation planning, not guessed inside PR 1:

- Whether query hashes are enough for audit correlation or whether short sanitized query previews are needed.
- Whether claim dedupe should start as string normalization only or include lightweight token similarity.
- Whether `needs_edit` should be a modal in Slack or a reviewer comment followed by a new candidate.

## Approval Status

Direction approved by the user on 2026-07-09:

- Answer Evidence + Knowledge Quality layer.
- Shadow mode first.
- No Slack answer redesign in PR 1.
- No pipeline rewrite.
- No database.
- No auto-answer product expansion.
