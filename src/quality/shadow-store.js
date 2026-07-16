import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getQualityShadowRetention } from './config.js';
import { hashValue, sanitizePreview } from './privacy.js';
import {
  evidenceByIdFirstWins,
  normalizeQualityEvidence,
  normalizeQualitySteps,
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
