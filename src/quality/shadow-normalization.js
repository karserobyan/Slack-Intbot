import { hashValue, sanitizePreview } from './privacy.js';

const SOURCE_TYPES = new Set(['slack', 'confluence', 'jira', 'kb', 'unknown']);
const SOURCE_QUALITY_VALUES = new Set(['high', 'medium', 'low', 'unknown']);
const DIRECTNESS_VALUES = new Set(['direct', 'related', 'background', 'unknown']);
const FRESHNESS_VALUES = new Set(['fresh', 'stale', 'unknown']);
const SENSITIVITY_VALUES = new Set(['safe', 'internal', 'specialist_only', 'unknown']);
const REUSE_VALUES = new Set(['high', 'medium', 'low', 'unknown']);
const ALLOWED_HOSTNAMES = new Set([
  'help.servicetitan.com',
  'servicetitan.atlassian.net',
  'servicetitan.slack.com',
]);
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
const STEP_TAGS = new Set(['action', 'backend', 'verify', 'step', 'escalate']);

export const MAX_PERSISTED_EVIDENCE_RECORDS = 10;
export const MAX_STEP_COVERAGE_COUNT = 1000;

export function isSafeNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

export function sanitizeCountMap(value = {}, allowedKeys = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => allowedKeys.has(key) && isSafeNonNegativeInt(count)));
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

function safeHostname(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ALLOWED_HOSTNAMES.has(normalized) ? normalized : '';
}

function safeReasonCodes(reasons = []) {
  return reasons
    .slice(0, 8)
    .map(r => sanitizePreview(r, 40))
    .map(r => r.toLowerCase())
    .filter(r => REASON_CODES.has(r));
}

function sanitizeEvidenceId(value) {
  const id = sanitizePreview(value, 40);
  return /^ev_[a-z0-9_-]+$/i.test(id) ? id : '';
}

function normalizeQualityStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  const evidenceIds = Array.isArray(step.evidenceIds)
    ? step.evidenceIds.map(sanitizeEvidenceId).filter(Boolean)
    : [];
  return {
    id: sanitizePreview(step.id, 40),
    title: sanitizePreview(step.title, 240),
    detail: sanitizePreview(step.detail, 500),
    tag: safeEnum(step.tag, STEP_TAGS, 'step'),
    evidenceIds,
    tenantSpecific: step.tenantSpecific === true,
  };
}

export function normalizeQualityEvidence(evidence = []) {
  return evidence
    .map((e) => {
      const id = sanitizeEvidenceId(e?.id);
      if (!id) return null;
      return {
        id,
        source: safeEnum(e.source, SOURCE_TYPES),
        hostname: safeHostname(e.hostname),
        urlHash: safeHash(e.urlHash, e.url ?? ''),
        sourceQuality: safeEnum(e.sourceQuality, SOURCE_QUALITY_VALUES),
        directness: safeEnum(e.directness, DIRECTNESS_VALUES),
        freshness: safeEnum(e.freshness, FRESHNESS_VALUES),
        sensitivity: safeEnum(e.sensitivity, SENSITIVITY_VALUES),
        reuseValue: safeEnum(e.reuseValue, REUSE_VALUES),
        reasons: safeReasonCodes(e.reasons),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_PERSISTED_EVIDENCE_RECORDS);
}

export function evidenceByIdFirstWins(evidence = []) {
  const evidenceById = new Map();
  for (const item of evidence) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (!id || evidenceById.has(id)) continue;
    evidenceById.set(id, item);
  }
  return evidenceById;
}

export function normalizeQualitySteps(steps = []) {
  return (Array.isArray(steps) ? steps : [])
    .map(normalizeQualityStep)
    .filter(Boolean)
    .slice(0, MAX_STEP_COVERAGE_COUNT);
}
