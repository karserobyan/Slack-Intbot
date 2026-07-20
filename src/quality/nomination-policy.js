import { makeQualityId, normalizeForQuality, sanitizePreview } from './privacy.js';
import {
  evidenceByIdFirstWins,
  normalizeQualityEvidence,
  normalizeQualitySteps,
} from './shadow-normalization.js';

export const CLAIM_TYPES = new Set(['action', 'backend', 'verify', 'step', 'escalate']);
export const POLICY_ELIGIBLE_REASONS = new Set([
  'specific_integration',
  'cohesive_qualifying_evidence',
  'durable_claim_type',
  'non_tenant_specific',
  'concrete_claim',
]);
export const POLICY_BLOCKERS = new Set([
  'answer_requires_escalation',
  'empty_claim',
  'escalation_claim',
  'low_confidence_answer',
  'low_reuse_value',
  'missing_specific_integration',
  'no_cohesive_qualifying_evidence',
  'no_direct_evidence',
  'no_safe_direct_evidence',
  'non_durable_claim_type',
  'specialist_only_evidence',
  'generic_placeholder',
  'stale_evidence',
  'tenant_specific_claim',
  'unsupported_claim',
  'weak_source_quality',
]);
const DURABLE_CLAIM_TYPES = new Set(['action', 'backend', 'verify']);
const SPECIFIC_INTEGRATION_PLACEHOLDERS = new Set(['', 'general', 'unknown', 'integration', 'integration issue']);
const HIGH_OR_MEDIUM_VALUES = new Set(['high', 'medium']);
const SUPPORT_COUNT_KEYS = [
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
];

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

function normalizeIntegrationType(value) {
  return normalizeForQuality(value);
}

function hasSpecificIntegration(value) {
  return !SPECIFIC_INTEGRATION_PLACEHOLDERS.has(normalizeIntegrationType(value));
}

function isGenericPlaceholder(text) {
  const normalized = normalizeForQuality(text);
  if (!normalized) return true;
  if (EXACT_GENERIC_TEXT.has(normalized)) return true;
  return GENERIC_STEP_TEXT.test(text) && normalized.split(' ').length <= 5;
}

function normalizedEvidenceContext(contract) {
  const evidence = normalizeQualityEvidence(contract?.evidence);
  return {
    evidence,
    evidenceById: evidenceByIdFirstWins(evidence),
  };
}

function resolveCandidateEvidence(candidate, evidenceById) {
  return [...new Set(Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds : [])]
    .map(id => evidenceById.get(id))
    .filter(Boolean);
}

function evidenceSummaryForResolvedEvidence(resolvedEvidence) {
  const directEvidence = resolvedEvidence.filter(evidence => evidence.directness === 'direct');
  const safeDirectEvidence = directEvidence.filter(evidence => evidence.sensitivity === 'safe');
  const specialistOnlyEvidence = resolvedEvidence.filter(evidence => evidence.sensitivity === 'specialist_only');
  const highOrMediumQualityEvidence = safeDirectEvidence.filter(evidence => HIGH_OR_MEDIUM_VALUES.has(evidence.sourceQuality));
  const highOrMediumReuseEvidence = safeDirectEvidence.filter(evidence => HIGH_OR_MEDIUM_VALUES.has(evidence.reuseValue));
  const qualifyingEvidence = safeDirectEvidence.filter(evidence =>
    HIGH_OR_MEDIUM_VALUES.has(evidence.sourceQuality) &&
    HIGH_OR_MEDIUM_VALUES.has(evidence.reuseValue));
  const freshQualifyingEvidence = qualifyingEvidence.filter(evidence => evidence.freshness === 'fresh');
  const unknownFreshnessQualifyingEvidence = qualifyingEvidence.filter(evidence => evidence.freshness === 'unknown');
  const staleOtherwiseQualifyingEvidence = qualifyingEvidence.filter(evidence => evidence.freshness === 'stale');

  return {
    resolvedCount: resolvedEvidence.length,
    directCount: directEvidence.length,
    safeDirectCount: safeDirectEvidence.length,
    specialistOnlyCount: specialistOnlyEvidence.length,
    exclusivelySpecialistOnly: resolvedEvidence.length > 0 && specialistOnlyEvidence.length === resolvedEvidence.length,
    highOrMediumQualityCount: highOrMediumQualityEvidence.length,
    highOrMediumReuseCount: highOrMediumReuseEvidence.length,
    qualifyingEvidenceCount: qualifyingEvidence.length,
    freshQualifyingEvidenceCount: freshQualifyingEvidence.length,
    unknownFreshnessQualifyingEvidenceCount: unknownFreshnessQualifyingEvidence.length,
    staleOtherwiseQualifyingEvidenceCount: staleOtherwiseQualifyingEvidence.length,
  };
}

function specialistOnlyDependency(resolvedEvidence, evidenceSummary) {
  if (evidenceSummary.safeDirectCount > 0 || evidenceSummary.specialistOnlyCount === 0) return false;
  if (evidenceSummary.exclusivelySpecialistOnly) return true;
  const directEvidence = resolvedEvidence.filter(evidence => evidence.directness === 'direct');
  return directEvidence.length > 0 && directEvidence.every(evidence => evidence.sensitivity === 'specialist_only');
}

function evaluateEvidenceBlockers(resolvedEvidence, evidenceSummary) {
  if (evidenceSummary.resolvedCount === 0) return ['unsupported_claim'];
  if (evidenceSummary.directCount === 0) {
    const blockers = ['no_direct_evidence'];
    if (specialistOnlyDependency(resolvedEvidence, evidenceSummary)) blockers.push('specialist_only_evidence');
    return blockers;
  }
  if (evidenceSummary.safeDirectCount === 0) {
    const blockers = ['no_safe_direct_evidence'];
    if (specialistOnlyDependency(resolvedEvidence, evidenceSummary)) blockers.push('specialist_only_evidence');
    return blockers;
  }

  const blockers = [];
  if (evidenceSummary.highOrMediumQualityCount === 0) blockers.push('weak_source_quality');
  if (evidenceSummary.highOrMediumReuseCount === 0) blockers.push('low_reuse_value');
  if (
    evidenceSummary.highOrMediumQualityCount > 0 &&
    evidenceSummary.highOrMediumReuseCount > 0 &&
    evidenceSummary.qualifyingEvidenceCount === 0
  ) {
    blockers.push('no_cohesive_qualifying_evidence');
  }
  if (
    evidenceSummary.qualifyingEvidenceCount > 0 &&
    evidenceSummary.freshQualifyingEvidenceCount === 0 &&
    evidenceSummary.unknownFreshnessQualifyingEvidenceCount === 0
  ) {
    blockers.push('stale_evidence');
  }
  return blockers;
}

function incrementCount(map, key) {
  map[key] = (map[key] ?? 0) + 1;
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

export function evaluateNominationEligibility(candidate, contract, context = null) {
  const text = sanitizePreview(candidate?.text ?? '', 500);
  const claimType = CLAIM_TYPES.has(candidate?.claimType) ? candidate.claimType : 'step';
  const tenantSpecific = candidate?.tenantSpecific === true || TENANT_SPECIFIC_TEXT.test(text);
  const genericPlaceholder = isGenericPlaceholder(text);
  const answerRequiresEscalation = candidate?.answerRequiresEscalation === true || contract?.sections?.escalation?.shouldEscalate === true;
  const integrationType = sanitizePreview(candidate?.integrationType ?? contract?.integrationType ?? '', 80);
  const evidenceIds = [...new Set(Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds : [])];
  const evidenceContext = context ?? normalizedEvidenceContext(contract);
  const resolvedEvidence = resolveCandidateEvidence(candidate, evidenceContext.evidenceById);
  const evidenceSummary = evidenceSummaryForResolvedEvidence(resolvedEvidence);
  const blockers = [];

  if (contract?.confidence === 'low') blockers.push('low_confidence_answer');
  if (!hasSpecificIntegration(integrationType)) blockers.push('missing_specific_integration');

  const normalizedText = normalizeForQuality(text);
  if (!normalizedText) blockers.push('empty_claim');
  else if (genericPlaceholder) blockers.push('generic_placeholder');

  if (claimType === 'escalate') blockers.push('escalation_claim');
  else if (!DURABLE_CLAIM_TYPES.has(claimType)) blockers.push('non_durable_claim_type');

  if (tenantSpecific) blockers.push('tenant_specific_claim');
  if (answerRequiresEscalation) blockers.push('answer_requires_escalation');

  blockers.push(...evaluateEvidenceBlockers(resolvedEvidence, evidenceSummary));

  const preDuplicateEligible = blockers.length === 0;
  const reasons = preDuplicateEligible
    ? [
      'specific_integration',
      'durable_claim_type',
      'concrete_claim',
      'non_tenant_specific',
      'cohesive_qualifying_evidence',
    ]
    : [];

  return {
    version: 1,
    candidateId: candidate?.candidateId,
    answerId: candidate?.answerId,
    sourceStepId: candidate?.sourceStepId,
    claimOrdinal: candidate?.claimOrdinal,
    claimType,
    text,
    integrationType,
    evidenceIds,
    approximateMapping: candidate?.approximateMapping === true,
    tenantSpecific,
    genericPlaceholder,
    answerRequiresEscalation,
    eligibility: {
      preDuplicateEligible,
      reasons,
      blockers,
    },
    evidenceSummary,
  };
}

export function summarizeNominationPolicy(policyResult) {
  const candidates = Array.isArray(policyResult?.candidates) ? policyResult.candidates : [];
  const blockerCounts = {};
  const eligibleReasonCounts = {};
  const byClaimType = {};
  const supportCounts = {};
  let preDuplicateEligibleCount = 0;

  for (const candidate of candidates) {
    const claimType = CLAIM_TYPES.has(candidate?.claimType) ? candidate.claimType : 'step';
    incrementCount(byClaimType, claimType);

    const blockers = (Array.isArray(candidate?.eligibility?.blockers) ? candidate.eligibility.blockers : [])
      .filter(blocker => POLICY_BLOCKERS.has(blocker));
    const reasons = (Array.isArray(candidate?.eligibility?.reasons) ? candidate.eligibility.reasons : [])
      .filter(reason => POLICY_ELIGIBLE_REASONS.has(reason));
    const preDuplicateEligible = candidate?.eligibility?.preDuplicateEligible === true && blockers.length === 0;
    const evidenceSummary = {
      ...emptyEvidenceSummary(),
      ...(candidate?.evidenceSummary && typeof candidate.evidenceSummary === 'object' ? candidate.evidenceSummary : {}),
    };

    if (preDuplicateEligible) {
      preDuplicateEligibleCount += 1;
      for (const reason of reasons) incrementCount(eligibleReasonCounts, reason);
    } else {
      for (const blocker of blockers) incrementCount(blockerCounts, blocker);
    }

    if (evidenceSummary.resolvedCount > 0) incrementCount(supportCounts, 'resolvedCount');
    if (evidenceSummary.directCount > 0) incrementCount(supportCounts, 'directCount');
    if (evidenceSummary.safeDirectCount > 0) incrementCount(supportCounts, 'safeDirectCount');
    if (evidenceSummary.specialistOnlyCount > 0) incrementCount(supportCounts, 'specialistOnlyCount');
    if (evidenceSummary.exclusivelySpecialistOnly === true) incrementCount(supportCounts, 'exclusivelySpecialistOnly');
    if (evidenceSummary.highOrMediumQualityCount > 0) incrementCount(supportCounts, 'highOrMediumQualityCount');
    if (evidenceSummary.highOrMediumReuseCount > 0) incrementCount(supportCounts, 'highOrMediumReuseCount');
    if (evidenceSummary.qualifyingEvidenceCount > 0) incrementCount(supportCounts, 'qualifyingEvidenceCount');
    if (evidenceSummary.freshQualifyingEvidenceCount > 0) incrementCount(supportCounts, 'freshQualifyingEvidenceCount');
    if (evidenceSummary.unknownFreshnessQualifyingEvidenceCount > 0) incrementCount(supportCounts, 'unknownFreshnessQualifyingEvidenceCount');
    if (evidenceSummary.staleOtherwiseQualifyingEvidenceCount > 0) incrementCount(supportCounts, 'staleOtherwiseQualifyingEvidenceCount');
  }

  for (const key of SUPPORT_COUNT_KEYS) {
    if (!Number.isInteger(supportCounts[key]) || supportCounts[key] < 0) delete supportCounts[key];
  }

  return {
    version: 1,
    status: 'evaluated',
    evaluated: true,
    duplicateCheck: 'deferred',
    candidateCount: candidates.length,
    preDuplicateEligibleCount,
    blockedCount: candidates.length - preDuplicateEligibleCount,
    blockerCounts,
    eligibleReasonCounts,
    byClaimType,
    supportCounts,
  };
}

export function evaluateContractNominationPolicy(contract, options = {}) {
  const context = normalizedEvidenceContext(contract);
  const candidates = buildClaimCandidates(contract, options)
    .map(candidate => evaluateNominationEligibility(candidate, contract, context));
  const result = {
    version: 1,
    answerId: contract?.answerId,
    status: 'evaluated',
    approximateMapping: contract?.quality?.approximateMapping === true,
    candidates,
  };
  return {
    ...result,
    summary: summarizeNominationPolicy(result),
  };
}
