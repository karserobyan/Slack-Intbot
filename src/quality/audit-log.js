import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashValue, makeQualityId, sanitizePreview } from './privacy.js';

let _auditFile = join(process.cwd(), 'data', 'quality-audit.jsonl');
let _auditQueue = Promise.resolve();

export function _setQualityAuditFileForTest(path) {
  _auditFile = path;
  _auditQueue = Promise.resolve();
}

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

function safeHash(value, fallbackValue = '') {
  const text = String(value ?? '');
  if (/^sha256:[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
  return hashValue(fallbackValue || text);
}

function safeReasonCodes(reasons = []) {
  return reasons
    .slice(0, 8)
    .map(r => sanitizePreview(r, 40))
    .map(r => r.toLowerCase())
    .filter(r => REASON_CODES.has(r));
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
      integrationTypeHash: event.metadata?.integrationType ? hashValue(event.metadata.integrationType) : null,
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
