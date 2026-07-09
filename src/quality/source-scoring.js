import { classifySourceRef } from '../slack/source-policy.js';
import { hashValue, normalizeForQuality, sanitizePreview } from './privacy.js';

const DIRECT_WORD_MIN = 2;

function includesToken(haystack, needle) {
  const h = normalizeForQuality(haystack);
  const n = normalizeForQuality(needle);
  return Boolean(n) && h.includes(n);
}

function tokenOverlap(a, b) {
  const left = new Set(normalizeForQuality(a).split(' ').filter(w => w.length > 2));
  const right = normalizeForQuality(b).split(' ').filter(w => w.length > 2);
  return right.filter(w => left.has(w)).length;
}

function inferDirectness(text, { query, integrationType, issueTitle }) {
  const integrationMatch = includesToken(text, integrationType);
  const issueMatch = includesToken(text, issueTitle) || tokenOverlap(text, query) >= DIRECT_WORD_MIN;
  if (integrationMatch && issueMatch) return 'direct';
  if (integrationMatch || issueMatch) return 'related';
  return 'background';
}

function inferSourceQuality(source, directness, text) {
  if (directness === 'direct' && ['confluence', 'jira', 'kb'].includes(source)) return 'high';
  if (directness === 'direct' && source === 'slack') return 'medium';
  if (directness === 'related') return 'medium';
  if (/\b(resolved|confirmed|fixed|enable|setup|configuration)\b/i.test(text)) return 'medium';
  return 'low';
}

function inferReuseValue(text, source, directness) {
  if (/\b(tenant|customer|account|location)\s*#?\d+\b/i.test(text)) return 'low';
  if (/\b(incident|outage|one-off|specific customer|this tenant only)\b/i.test(text)) return 'low';
  if (directness === 'direct' && /\b(setup|enable|mapping|configuration|verify|reconnect|access)\b/i.test(text)) return 'high';
  if (source === 'jira') return 'medium';
  return directness === 'background' ? 'low' : 'medium';
}

function inferFreshness(ref) {
  const raw = ref.timestamp ?? ref.date ?? ref.updated ?? ref.created;
  if (!raw) return 'unknown';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return 'unknown';
  const ageDays = (Date.now() - ts) / 86400000;
  return ageDays > 730 ? 'stale' : 'fresh';
}

export function refToEvidence(ref, { source, query, integrationType, issueTitle }, index = 0) {
  const classified = classifySourceRef(ref ?? {});
  const title = sanitizePreview(classified.title ?? classified.url ?? source, 120);
  const snippetPreview = sanitizePreview(classified.snippet ?? classified.text ?? '', 160);
  const text = [title, snippetPreview, classified.channel, classified.type].filter(Boolean).join(' ');
  const directness = inferDirectness(text, { query, integrationType, issueTitle });
  const sensitivity = classified.sensitive === true ? 'specialist_only' : 'safe';
  const sourceName = source || classified.type || 'unknown';
  return {
    id: `ev_${index + 1}`,
    source: sourceName,
    url: sanitizePreview(classified.url ?? '', 180),
    urlHash: hashValue(classified.url ?? ''),
    title,
    snippetPreview,
    channel: sanitizePreview(classified.channel ?? '', 80),
    sourceQuality: inferSourceQuality(sourceName, directness, text),
    directness,
    freshness: inferFreshness(classified),
    sensitivity,
    reuseValue: inferReuseValue(text, sourceName, directness),
    matchedIntegration: includesToken(text, integrationType),
    matchedSymptom: includesToken(text, issueTitle) || tokenOverlap(text, query) >= DIRECT_WORD_MIN,
    reasons: [],
  };
}

export function scoreEvidenceSource(evidence, context) {
  const text = [evidence.title, evidence.snippetPreview, evidence.channel, evidence.source].filter(Boolean).join(' ');
  const directness = inferDirectness(text, context);
  return {
    ...evidence,
    directness,
    sourceQuality: inferSourceQuality(evidence.source, directness, text),
    reuseValue: inferReuseValue(text, evidence.source, directness),
    sensitivity: evidence.sensitivity ?? 'safe',
    freshness: evidence.freshness ?? 'unknown',
    matchedIntegration: includesToken(text, context.integrationType),
    matchedSymptom: includesToken(text, context.issueTitle) || tokenOverlap(text, context.query) >= DIRECT_WORD_MIN,
    reasons: [
      ...(includesToken(text, context.integrationType) ? ['integration_match'] : []),
      ...(includesToken(text, context.issueTitle) ? ['symptom_match'] : []),
      ...(directness === 'direct' ? ['direct_match'] : []),
    ],
  };
}

export function scoreEvidenceSources(refGroups = {}, context = {}) {
  const refs = [
    ...(refGroups.slack_refs ?? []).map(ref => ({ ref, source: 'slack' })),
    ...(refGroups.atlassian_refs ?? []).map(ref => ({ ref, source: ref.type === 'jira' ? 'jira' : 'confluence' })),
    ...(refGroups.kb_refs ?? []).map(ref => ({ ref, source: 'kb' })),
  ];
  return refs.map(({ ref, source }, index) =>
    scoreEvidenceSource(refToEvidence(ref, { ...context, source }, index), context),
  );
}
