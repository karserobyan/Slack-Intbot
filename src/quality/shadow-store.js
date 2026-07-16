import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getQualityShadowRetention } from './config.js';
import { hashValue, sanitizePreview } from './privacy.js';
import {
  evidenceByIdFirstWins,
  isSafeNonNegativeInt,
  normalizeQualityEvidence,
  normalizeQualitySteps,
  sanitizeCountMap,
} from './shadow-normalization.js';

let _shadowFile = join(process.cwd(), 'data', 'quality-shadow.jsonl');
let _writeQueue = Promise.resolve();

const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low', 'unknown']);
const REASON_CODES = new Set([
  'actionable_resolution',
  'approximate_mapping',
  'direct_evidence',
  'direct_match',
  'direct_source_match',
  'has_reusable_claim',
  'integration_match',
  'missing_direct_source',
  'reusable_backend_claim',
  'reusable_claim',
  'shadow_mode',
  'symptom_match',
  'weak_evidence',
]);
const NOMINATION_POLICY_BLOCKERS = new Set([
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
const NOMINATION_POLICY_ELIGIBLE_REASONS = new Set([
  'specific_integration',
  'durable_claim_type',
  'direct_evidence',
  'safe_evidence',
  'supported_source_quality',
  'reusable_evidence',
  'non_tenant_specific',
]);
const NOMINATION_POLICY_CLAIM_TYPES = new Set(['action', 'backend', 'verify', 'escalate', 'step']);
const NOMINATION_POLICY_SUPPORT_KEYS = new Set([
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

function canonicalPolicyFailedSummary() {
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

export function _setQualityShadowFileForTest(path) {
  _shadowFile = path;
  _writeQueue = Promise.resolve();
}

function safeHash(value, fallbackValue = '') {
  const text = String(value ?? '');
  if (/^sha256:[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
  return hashValue(fallbackValue || text);
}

function safeEnum(value, allowed, fallback = 'unknown') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function safeReasonCodes(reasons = []) {
  return reasons
    .slice(0, 8)
    .map(r => sanitizePreview(r, 40))
    .map(r => r.toLowerCase())
    .filter(r => REASON_CODES.has(r));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeNominationPolicyCountMap(value, allowedKeys) {
  if (!isPlainObject(value)) return null;
  for (const [key, count] of Object.entries(value)) {
    if (allowedKeys.has(key) && !isSafeNonNegativeInt(count)) return null;
  }
  return sanitizeCountMap(value, allowedKeys);
}

function sanitizeNominationPolicySummary(value) {
  if (!isPlainObject(value)) return canonicalPolicyFailedSummary();
  if (value.status === 'policy_failed') return canonicalPolicyFailedSummary();
  if (value.status !== 'evaluated') return canonicalPolicyFailedSummary();
  if (value.evaluated !== true) return canonicalPolicyFailedSummary();
  if (value.duplicateCheck !== 'deferred') return canonicalPolicyFailedSummary();
  if (
    !isSafeNonNegativeInt(value.candidateCount) ||
    !isSafeNonNegativeInt(value.preDuplicateEligibleCount) ||
    !isSafeNonNegativeInt(value.blockedCount)
  ) {
    return canonicalPolicyFailedSummary();
  }

  const blockerCounts = sanitizeNominationPolicyCountMap(value.blockerCounts, NOMINATION_POLICY_BLOCKERS);
  const eligibleReasonCounts = sanitizeNominationPolicyCountMap(value.eligibleReasonCounts, NOMINATION_POLICY_ELIGIBLE_REASONS);
  const byClaimType = sanitizeNominationPolicyCountMap(value.byClaimType, NOMINATION_POLICY_CLAIM_TYPES);
  const supportCounts = sanitizeNominationPolicyCountMap(value.supportCounts, NOMINATION_POLICY_SUPPORT_KEYS);

  if (!blockerCounts || !eligibleReasonCounts || !byClaimType || !supportCounts) {
    return canonicalPolicyFailedSummary();
  }

  if (value.preDuplicateEligibleCount + value.blockedCount !== value.candidateCount) {
    return canonicalPolicyFailedSummary();
  }

  const byClaimTypeTotal = Object.values(byClaimType).reduce((sum, count) => sum + count, 0);
  if (byClaimTypeTotal !== value.candidateCount) return canonicalPolicyFailedSummary();

  if (Object.values(supportCounts).some(count => count > value.candidateCount)) {
    return canonicalPolicyFailedSummary();
  }
  if (Object.values(blockerCounts).some(count => count > value.blockedCount)) {
    return canonicalPolicyFailedSummary();
  }
  if (Object.values(eligibleReasonCounts).some(count => count > value.preDuplicateEligibleCount)) {
    return canonicalPolicyFailedSummary();
  }

  return {
    version: 1,
    status: 'evaluated',
    evaluated: true,
    duplicateCheck: 'deferred',
    candidateCount: value.candidateCount,
    preDuplicateEligibleCount: value.preDuplicateEligibleCount,
    blockedCount: value.blockedCount,
    blockerCounts,
    eligibleReasonCounts,
    byClaimType,
    supportCounts,
  };
}

function coverageStepPopulation(record = {}) {
  return normalizeQualitySteps(record.sections?.steps);
}

function deriveStepCoverage(record = {}, persistedEvidence = []) {
  const steps = coverageStepPopulation(record);
  const evidenceById = evidenceByIdFirstWins(persistedEvidence);

  let mappedStepCount = 0;
  let directMappedStepCount = 0;

  for (const step of steps) {
    const resolved = [...new Set(step.evidenceIds)]
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

function sanitizeShadowRecord(record) {
  const persistedEvidence = normalizeQualityEvidence(record.evidence);
  const nominationPolicy = record.quality?.nominationPolicy === undefined
    ? undefined
    : sanitizeNominationPolicySummary(record.quality.nominationPolicy);
  const quality = {
    directAnswer: record.quality?.directAnswer === true,
    reusableKnowledge: record.quality?.reusableKnowledge === true,
    nominationEligible: record.quality?.nominationEligible === true,
    approximateMapping: record.quality?.approximateMapping === true,
    reasons: safeReasonCodes(record.quality?.reasons),
    stepCoverage: deriveStepCoverage(record, persistedEvidence),
  };
  if (nominationPolicy !== undefined) quality.nominationPolicy = nominationPolicy;
  return {
    createdAt: record.createdAt ?? new Date().toISOString(),
    answerId: sanitizePreview(record.answerId, 80),
    queryHash: safeHash(record.queryHash, record.queryPreview ?? ''),
    role: sanitizePreview(record.role, 20),
    channelId: sanitizePreview(record.channelId, 80),
    threadTs: sanitizePreview(record.threadTs, 80),
    issueHash: record.issueTitle ? hashValue(record.issueTitle) : null,
    integrationTypeHash: record.integrationType ? hashValue(record.integrationType) : null,
    confidence: safeEnum(record.confidence, CONFIDENCE_VALUES),
    evidence: persistedEvidence,
    quality,
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
  while (records.length > 0) {
    records = records.slice(1);
    await writeJsonlAtomic(file, pruneRecords(records, retention, now));
    const info = await stat(file);
    if (info.size <= retention.maxBytes) break;
  }
}

function recoverWriteQueue() {
  return _writeQueue.catch(() => {});
}

export function appendQualityShadowRecord(record, { retention = getQualityShadowRetention(), now = new Date() } = {}) {
  const sanitized = sanitizeShadowRecord(record);
  _writeQueue = recoverWriteQueue().then(async () => {
    const records = pruneRecords([...(await readRecords(_shadowFile)), sanitized], retention, now);
    await writeJsonlAtomic(_shadowFile, records);
    await enforceByteLimit(_shadowFile, retention, now);
    return sanitized;
  });
  return _writeQueue;
}
