import { createHash, randomBytes } from 'node:crypto';

const TOKEN_RE = /\b(xox[baprs]-[A-Za-z0-9-]+|sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function sanitizePreview(value, max = 160) {
  const clean = String(value ?? '')
    .replace(TOKEN_RE, '[redacted-token]')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function hashValue(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

export function makeQualityId(prefix, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${prefix}_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function normalizeForQuality(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
