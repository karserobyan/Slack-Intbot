import { hashValue, makeQualityId, normalizeForQuality, sanitizePreview } from './privacy.js';
import { scoreEvidenceSources } from './source-scoring.js';

function safeConfidence(value) {
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium';
}

function keywordOverlapScore(text, evidence) {
  const claimWords = new Set(normalizeForQuality(text).split(' ').filter(w => w.length > 2));
  const evidenceWords = normalizeForQuality([evidence.title, evidence.snippetPreview, evidence.channel].join(' '))
    .split(' ')
    .filter(w => w.length > 2);
  return evidenceWords.filter(w => claimWords.has(w)).length;
}

function evidenceIdsForText(text, evidence, { safeOnly = false } = {}) {
  const scored = evidence
    .filter(e => !safeOnly || e.sensitivity === 'safe')
    .map(e => ({ id: e.id, score: keywordOverlapScore(text, e), direct: e.directness === 'direct' }))
    .filter(e => e.score > 0 || e.direct);
  scored.sort((a, b) => Number(b.direct) - Number(a.direct) || b.score - a.score);
  return scored.slice(0, 5).map(e => e.id);
}

function trustFromEvidence(ids, evidence) {
  if (ids.length === 0) return 'unsupported';
  if (ids.some(id => evidence.find(e => e.id === id)?.directness === 'direct')) return 'direct';
  return 'partial';
}

export function buildAnswerEvidenceContract({
  answer,
  query,
  role,
  channelId,
  threadTs,
  now = new Date(),
}) {
  const issueTitle = sanitizePreview(answer?.issue_title ?? 'Integration Issue', 140);
  const integrationType = sanitizePreview(answer?.integration_type ?? 'General', 80);
  const context = { query, integrationType, issueTitle };
  const evidence = scoreEvidenceSources({
    slack_refs: answer?.slack_refs ?? [],
    atlassian_refs: answer?.atlassian_refs ?? [],
    kb_refs: answer?.kb_refs ?? [],
  }, context);

  const diagnosisText = sanitizePreview(answer?.findings_summary?.diagnosis ?? '', 300);
  const diagnosisEvidenceIds = evidenceIdsForText(`${issueTitle} ${diagnosisText}`, evidence);
  const customerText = sanitizePreview(answer?.customer_message ?? '', 300);
  const customerEvidenceIds = evidenceIdsForText(`${issueTitle} ${customerText}`, evidence, { safeOnly: true });
  const escalationReason = sanitizePreview(answer?.escalate_decision?.reason ?? '', 220);
  const escalationEvidenceIds = evidenceIdsForText(`${issueTitle} ${escalationReason}`, evidence);

  const steps = (answer?.agent_steps ?? []).map((step, index) => {
    const text = `${step.title ?? ''} ${step.detail ?? ''}`;
    const evidenceIds = evidenceIdsForText(text, evidence);
    const tag = ['action', 'backend', 'verify', 'escalate'].includes(step.tag) ? step.tag : 'step';
    return {
      id: `claim_${index + 1}`,
      num: Number.isFinite(step.num) ? step.num : index + 1,
      title: sanitizePreview(step.title ?? tag, 120),
      detail: sanitizePreview(step.detail ?? '', 300),
      tag,
      evidenceIds,
      trust: trustFromEvidence(evidenceIds, evidence),
      reusable: false,
      tenantSpecific: /\b(tenant|customer|account|location)\s*#?\d+\b/i.test(`${step.title ?? ''} ${step.detail ?? ''}`),
      nominationEligible: false,
    };
  });

  const answerId = makeQualityId('ans', now);

  return {
    version: 1,
    answerId,
    createdAt: now.toISOString(),
    mode: 'shadow',
    queryHash: hashValue(query ?? ''),
    queryPreview: sanitizePreview(query ?? '', 120),
    role: role === 'specialist' ? 'specialist' : 'csa',
    channelId: sanitizePreview(channelId ?? '', 80),
    threadTs: sanitizePreview(threadTs ?? '', 80),
    issueTitle,
    integrationType,
    confidence: safeConfidence(answer?.confidence),
    confidenceReason: sanitizePreview(`current answer confidence: ${safeConfidence(answer?.confidence)}`, 120),
    sections: {
      diagnosis: {
        text: diagnosisText,
        evidenceIds: diagnosisEvidenceIds,
        trust: trustFromEvidence(diagnosisEvidenceIds, evidence),
      },
      customerMessage: {
        text: customerText,
        evidenceIds: customerEvidenceIds,
        trust: trustFromEvidence(customerEvidenceIds, evidence),
      },
      escalation: {
        shouldEscalate: answer?.escalate_decision?.should_escalate === true,
        reason: escalationReason,
        escalationPath: sanitizePreview(answer?.escalate_decision?.escalation_path ?? '', 120) || null,
        channelRecommendation: {
          channel: sanitizePreview(answer?.channel_recommendation?.channel ?? '', 80),
          reason: sanitizePreview(answer?.channel_recommendation?.reason ?? '', 160),
        },
        evidenceIds: escalationEvidenceIds,
        trust: trustFromEvidence(escalationEvidenceIds, evidence),
      },
      steps,
    },
    evidence,
    quality: {
      directAnswer: evidence.some(e => e.directness === 'direct'),
      reusableKnowledge: false,
      nominationEligible: false,
      approximateMapping: true,
      sourcesUsed: (answer?.sources_used ?? []).map(s => sanitizePreview(s, 40)).filter(Boolean),
      reasons: ['shadow_mode', 'approximate_mapping'],
    },
  };
}

export function isValidAnswerEvidenceContract(contract) {
  return contract?.version === 1 &&
    contract.mode === 'shadow' &&
    typeof contract.answerId === 'string' &&
    typeof contract.queryHash === 'string' &&
    Array.isArray(contract.evidence) &&
    Array.isArray(contract.sections?.steps) &&
    contract.quality?.approximateMapping === true;
}
