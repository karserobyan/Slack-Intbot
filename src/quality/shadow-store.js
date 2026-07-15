import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getQualityShadowRetention } from './config.js';
import { hashValue, sanitizePreview } from './privacy.js';

let _shadowFile = join(process.cwd(), 'data', 'quality-shadow.jsonl');
let _writeQueue = Promise.resolve();

const SOURCE_TYPES = new Set(['slack', 'confluence', 'jira', 'kb', 'unknown']);
const SOURCE_QUALITY_VALUES = new Set(['high', 'medium', 'low', 'unknown']);
const DIRECTNESS_VALUES = new Set(['direct', 'related', 'background', 'unknown']);
const FRESHNESS_VALUES = new Set(['fresh', 'stale', 'unknown']);
const SENSITIVITY_VALUES = new Set(['safe', 'internal', 'specialist_only', 'unknown']);
const REUSE_VALUES = new Set(['high', 'medium', 'low', 'unknown']);
const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low', 'unknown']);
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
const MAX_PERSISTED_EVIDENCE_RECORDS = 10;
const MAX_STEP_COVERAGE_COUNT = 1000;

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

function normalizeCoverageStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  const evidenceIds = Array.isArray(step.evidenceIds)
    ? step.evidenceIds.map(sanitizeEvidenceId).filter(Boolean)
    : [];
  return { evidenceIds };
}

function coverageStepPopulation(record = {}) {
  return (Array.isArray(record.sections?.steps) ? record.sections.steps : [])
    .map(normalizeCoverageStep)
    .filter(Boolean)
    .slice(0, MAX_STEP_COVERAGE_COUNT);
}

function evidenceByIdFromPersistedEvidence(persistedEvidence = []) {
  const evidenceById = new Map();
  for (const item of persistedEvidence) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (!id || evidenceById.has(id)) continue;
    evidenceById.set(id, item);
  }
  return evidenceById;
}

function deriveStepCoverage(record = {}, persistedEvidence = []) {
  const steps = coverageStepPopulation(record);
  const evidenceById = evidenceByIdFromPersistedEvidence(persistedEvidence);

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

function sanitizeEvidence(evidence = []) {
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

function sanitizeShadowRecord(record) {
  const persistedEvidence = sanitizeEvidence(record.evidence);
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
    quality: {
      directAnswer: record.quality?.directAnswer === true,
      reusableKnowledge: record.quality?.reusableKnowledge === true,
      nominationEligible: record.quality?.nominationEligible === true,
      approximateMapping: record.quality?.approximateMapping === true,
      reasons: safeReasonCodes(record.quality?.reasons),
      stepCoverage: deriveStepCoverage(record, persistedEvidence),
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
