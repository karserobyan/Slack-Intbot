import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashValue, makeQualityId, sanitizePreview } from './privacy.js';

let _auditFile = join(process.cwd(), 'data', 'quality-audit.jsonl');
let _auditQueue = Promise.resolve();

export function _setQualityAuditFileForTest(path) {
  _auditFile = path;
  _auditQueue = Promise.resolve();
}

function safeLowRiskLabel(value, max = 80) {
  const text = sanitizePreview(value, max);
  if (!text) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+&/-]{0,79}$/.test(text)) return '';
  if (/@/.test(text) || /\bxox[abprs]-/i.test(text)) return '';
  if (/\b(?:tenant|account|location)\s*#?\d+\b/i.test(text)) return '';
  if (/\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/.test(text)) return '';
  return text;
}

function safeHash(value, fallbackValue = '') {
  const text = String(value ?? '');
  if (/^sha256:[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
  return hashValue(fallbackValue || text);
}

function safeReasonCodes(reasons = []) {
  return reasons
    .slice(0, 8)
    .map(r => sanitizePreview(r, 40))
    .filter(r => /^[A-Za-z0-9_.:-]{1,40}$/.test(r));
}

function queryHashFromMetadata(metadata = {}) {
  if (metadata.queryHash) return safeHash(metadata.queryHash, metadata.query ?? metadata.queryPreview ?? '');
  const query = metadata.query ?? metadata.queryPreview ?? '';
  return query ? hashValue(query) : null;
}

function sanitizeAuditEvent(event, now) {
  return {
    id: event.id ?? makeQualityId('qa', now),
    timestamp: event.timestamp ?? now.toISOString(),
    type: sanitizePreview(event.type, 80),
    actor: {
      type: sanitizePreview(event.actor?.type ?? 'bot', 40),
      userId: sanitizePreview(event.actor?.userId ?? '', 80) || null,
      userHash: event.actor?.userId ? hashValue(event.actor.userId) : null,
    },
    entity: {
      type: sanitizePreview(event.entity?.type ?? '', 80),
      id: sanitizePreview(event.entity?.id ?? '', 120),
    },
    metadata: {
      queryHash: queryHashFromMetadata(event.metadata),
      integrationType: safeLowRiskLabel(event.metadata?.integrationType, 80),
      nominationEligible: event.metadata?.nominationEligible === true,
      approximateMapping: event.metadata?.approximateMapping === true,
      reasons: safeReasonCodes(event.metadata?.reasons),
    },
  };
}

export function appendQualityAuditEvent(event, { now = new Date() } = {}) {
  const sanitized = sanitizeAuditEvent(event, now);
  _auditQueue = _auditQueue.catch(() => {}).then(async () => {
    await mkdir(dirname(_auditFile), { recursive: true });
    await appendFile(_auditFile, `${JSON.stringify(sanitized)}\n`);
    return sanitized;
  });
  return _auditQueue;
}
