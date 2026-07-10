import { isQualityLayerEnabled, isQualityShadowMode } from './config.js';
import { buildAnswerEvidenceContract } from './evidence-contract.js';
import { appendQualityAuditEvent } from './audit-log.js';
import { appendQualityShadowRecord } from './shadow-store.js';

export async function recordQualityShadow({
  answer,
  query,
  role,
  channelId,
  threadTs,
  logger = console,
  now = new Date(),
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
