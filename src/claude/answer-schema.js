/**
 * Shared answer contract for Resolver and Reply.
 * Prompts, the pipeline, Slack, and tests import these names.
 * Do not add a field here without updating every consumer.
 */

export const CONFIDENCE_VALUES = Object.freeze(['high', 'medium', 'low']);

export const STEP_TAGS = Object.freeze(['action', 'backend', 'verify', 'escalate']);

/** Another team. Absent who means the case owner finishes the case. */
export const INVOLVEMENT_WHO = Object.freeze([
  'engineering',
  'partner',
  'leads',
  'pricebook',
  'public-api',
  'back-office',
]);

export const INVOLVEMENT_CHANNELS = Object.freeze({
  engineering: '#ask-integrations',
  leads: '#ask-leads-integration',
  pricebook: '#ask-pricebook',
  'public-api': '#ask-public-api',
});

/**
 * Resolver JSON keys, in card order. customer_message is not one of them.
 * steps: [{ num, title, detail, tag }]
 * involvement: { needed, who, reason, channel }
 *   needed false → who null, channel null
 *   needed true  → who is engineering | partner | leads | pricebook | public-api | back-office
 *   channel is a known handoff channel, or null when that team has no confirmed channel
 */
export const RESOLVER_FIELDS = Object.freeze([
  'issue_title',
  'integration_type',
  'confidence',
  'diagnosis',
  'steps',
  'involvement',
  'slack_refs',
  'atlassian_refs',
  'kb_refs',
  'sources_used',
]);

/** Reply JSON. The only key Reply may emit. */
export const REPLY_FIELDS = Object.freeze(['customer_message']);

export const STEP_FIELDS = Object.freeze(['num', 'title', 'detail', 'tag']);

export const INVOLVEMENT_FIELDS = Object.freeze(['needed', 'who', 'reason', 'channel']);

/**
 * Role-mode keys. A resolver result, a reply result, and the merged
 * pipeline answer must not contain these. Tests fail when any are present.
 */
export const RETIRED_ROLE_FIELDS = Object.freeze([
  'role',
  'escalate_decision',
  'channel_recommendation',
  'agent_steps',
  'findings_summary',
  'suggested_channel_post',
  'intro_message',
]);

/** Model output must not carry these. Accounting is a keyword gate. Clarifying stays on Intake. */
export const NON_MODEL_FIELDS = Object.freeze([
  'customer_message',
  'is_accounting_topic',
  'clarifying_question',
]);

export function customerWasMentioned(interpreterResult) {
  return interpreterResult?.entities?.customer_mentioned === true;
}

export function retiredRoleFieldsIn(value) {
  if (!value || typeof value !== 'object') return [];
  return RETIRED_ROLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(value, field));
}

export function missingResolverFields(value) {
  if (!value || typeof value !== 'object') return [...RESOLVER_FIELDS];
  return RESOLVER_FIELDS.filter((field) => value[field] === undefined || value[field] === null);
}
