import { isQualityLayerEnabled, isQualityNominationPolicyEnabled, isQualityShadowMode } from './config.js';
import { buildAnswerEvidenceContract } from './evidence-contract.js';
import { appendQualityAuditEvent } from './audit-log.js';
import { appendQualityShadowRecord } from './shadow-store.js';
import { evaluateContractNominationPolicy } from './nomination-policy.js';

function createPolicyFailedSummary() {
  return {
    version: 1,
    status: 'policy_failed',
    evaluated: false,
    duplicateCheck: 'deferred',
    candidateCount: 0,
    preDuplicateEligibleCount: 0,
    blockedCount: 0,
    blockerCounts: {},
    eligibleReasonCounts: {},
    byClaimType: {},
    supportCounts: {},
  };
}

export async function recordQualityShadow({
  answer,
  query,
  role,
  channelId,
  threadTs,
  logger = console,
  now = new Date(),
  nominationPolicyEvaluator = evaluateContractNominationPolicy,
}) {
  if (!isQualityLayerEnabled()) return { status: 'disabled' };
  if (!isQualityShadowMode()) return { status: 'not_shadow_mode' };

  try {
    const contract = buildAnswerEvidenceContract({
      answer,
      query,
      role,
      channelId,
      threadTs,
      now,
    });

    if (isQualityNominationPolicyEnabled()) {
      try {
        const policyResult = await nominationPolicyEvaluator(contract);
        const summary = policyResult?.summary;
        if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
          contract.quality.nominationPolicy = summary;
        } else {
          logger?.warn?.('[quality] nomination policy failed');
          contract.quality.nominationPolicy = createPolicyFailedSummary();
        }
      } catch {
        logger?.warn?.('[quality] nomination policy failed');
        contract.quality.nominationPolicy = createPolicyFailedSummary();
      }
    }

    await appendQualityShadowRecord(contract, { now });
    await appendQualityAuditEvent({
      type: 'contract_created',
      actor: { type: 'bot' },
      entity: { type: 'answer_contract', id: contract.answerId },
      metadata: {
        queryHash: contract.queryHash,
        integrationType: contract.integrationType,
        nominationEligible: contract.quality.nominationEligible,
        approximateMapping: contract.quality.approximateMapping,
        reasons: contract.quality.reasons,
      },
    }, { now });

    return { status: 'recorded', contract };
  } catch (err) {
    logger?.warn?.(`[quality] shadow record failed: ${err.message}`);
    return { status: 'failed_open', error: err.message };
  }
}
