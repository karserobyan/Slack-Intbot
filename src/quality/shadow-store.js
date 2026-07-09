import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getQualityShadowRetention } from './config.js';
import { hashValue, sanitizePreview } from './privacy.js';

let _shadowFile = join(process.cwd(), 'data', 'quality-shadow.jsonl');
let _writeQueue = Promise.resolve();

export function _setQualityShadowFileForTest(path) {
  _shadowFile = path;
  _writeQueue = Promise.resolve();
}

function sanitizeEvidence(evidence = []) {
  return evidence.slice(0, 10).map((e) => ({
    id: sanitizePreview(e.id, 40),
    source: sanitizePreview(e.source, 40),
    urlHash: e.urlHash ?? hashValue(e.url ?? ''),
    title: sanitizePreview(e.title, 120),
    snippetPreview: sanitizePreview(e.snippetPreview, 32),
    sourceQuality: e.sourceQuality,
    directness: e.directness,
    freshness: e.freshness,
    sensitivity: e.sensitivity,
    reuseValue: e.reuseValue,
    reasons: (e.reasons ?? []).slice(0, 8).map(r => sanitizePreview(r, 40)),
  }));
}

function sanitizeShadowRecord(record) {
  return {
    createdAt: record.createdAt ?? new Date().toISOString(),
    answerId: sanitizePreview(record.answerId, 80),
    queryHash: record.queryHash ?? hashValue(record.queryPreview ?? ''),
    queryPreview: sanitizePreview(record.queryPreview, 120),
    role: sanitizePreview(record.role, 20),
    channelId: sanitizePreview(record.channelId, 80),
    threadTs: sanitizePreview(record.threadTs, 80),
    issueTitle: sanitizePreview(record.issueTitle, 140),
    integrationType: sanitizePreview(record.integrationType, 80),
    confidence: record.confidence,
    evidence: sanitizeEvidence(record.evidence),
    quality: {
      directAnswer: record.quality?.directAnswer === true,
      reusableKnowledge: record.quality?.reusableKnowledge === true,
      nominationEligible: record.quality?.nominationEligible === true,
      approximateMapping: record.quality?.approximateMapping === true,
      reasons: (record.quality?.reasons ?? []).slice(0, 8).map(r => sanitizePreview(r, 40)),
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
