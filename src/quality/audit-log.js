import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashValue, makeQualityId, sanitizePreview } from './privacy.js';

let _auditFile = join(process.cwd(), 'data', 'quality-audit.jsonl');
let _auditQueue = Promise.resolve();

export function _setQualityAuditFileForTest(path) {
  _auditFile = path;
  _auditQueue = Promise.resolve();
}

function sanitizeAuditEvent(event, now) {
  const query = event.metadata?.query ?? event.metadata?.queryPreview ?? '';
  return {
    id: event.id ?? makeQualityId('qa', now),
    timestamp: event.timestamp ?? now.toISOString(),
    type: sanitizePreview(event.type, 80),
    actor: {
      type: sanitizePreview(event.actor?.type ?? 'bot', 40),
      userId: sanitizePreview(event.actor?.userId ?? '', 80) || null,
      name: sanitizePreview(event.actor?.name ?? '', 80) || null,
    },
    entity: {
      type: sanitizePreview(event.entity?.type ?? '', 80),
      id: sanitizePreview(event.entity?.id ?? '', 120),
    },
    metadata: {
      queryHash: query ? hashValue(query) : event.metadata?.queryHash,
      queryPreview: query ? sanitizePreview(query, 32) : sanitizePreview(event.metadata?.queryPreview ?? '', 32),
      integrationType: sanitizePreview(event.metadata?.integrationType ?? '', 80),
      nominationEligible: event.metadata?.nominationEligible === true,
      approximateMapping: event.metadata?.approximateMapping === true,
      reason: sanitizePreview(event.metadata?.reason ?? '', 80),
      reasons: (event.metadata?.reasons ?? []).slice(0, 8).map(r => sanitizePreview(r, 40)),
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
