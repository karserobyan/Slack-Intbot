import { makeQualityId, normalizeForQuality, sanitizePreview } from './privacy.js';
import { normalizeQualitySteps } from './shadow-normalization.js';

export const CLAIM_TYPES = new Set(['action', 'backend', 'verify', 'step', 'escalate']);
export const POLICY_ELIGIBLE_REASONS = new Set([
  'durable_claim_type',
  'specific_integration',
  'cohesive_qualifying_evidence',
  'non_tenant_specific',
  'concrete_claim',
]);
export const POLICY_BLOCKERS = new Set([
  'empty_claim',
  'escalation_claim',
  'non_durable_claim_type',
  'unsupported_claim',
  'weak_evidence',
  'stale_evidence',
  'specialist_only_evidence',
  'tenant_specific_claim',
  'generic_placeholder',
]);

const EXACT_GENERIC_TEXT = new Set([
  'investigate further',
  'try again',
  'look into it',
  'check it',
  'review it',
]);
const GENERIC_STEP_TEXT = /\b(contact support|reach out|ask someone|follow up later)\b/i;
const TENANT_SPECIFIC_TEXT = /\b(this tenant|this customer|tenant-specific|customer-specific|tenant\s*#?\d+|customer\s*#?\d+|account\s*#?\d+|location\s*#?\d+)\b/i;

export function emptyEvidenceSummary() {
  return {
    resolvedCount: 0,
    directCount: 0,
    safeDirectCount: 0,
    specialistOnlyCount: 0,
    exclusivelySpecialistOnly: false,
    highOrMediumQualityCount: 0,
    highOrMediumReuseCount: 0,
    qualifyingEvidenceCount: 0,
    freshQualifyingEvidenceCount: 0,
    unknownFreshnessQualifyingEvidenceCount: 0,
    staleOtherwiseQualifyingEvidenceCount: 0,
  };
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
      answerId: contract?.answerId,
      sourceStepId: step.id || `claim_${index + 1}`,
      claimOrdinal: index + 1,
      claimType,
      text,
      integrationType: contract?.integrationType,
      evidenceIds: [...new Set(step.evidenceIds)],
      approximateMapping: contract?.quality?.approximateMapping === true,
      tenantSpecific: step.tenantSpecific === true || TENANT_SPECIFIC_TEXT.test(text),
      genericPlaceholder: isGenericPlaceholder(text),
      answerRequiresEscalation,
      eligibility: { preDuplicateEligible: false, reasons: [], blockers: [] },
      evidenceSummary: emptyEvidenceSummary(),
    };
  });
}
