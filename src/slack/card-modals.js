import { getCachedById } from './cache.js';
import { buildFullStepsModal, buildDraftModal, buildExpiredModal } from './blocks.js';

const BUILDERS = { steps: buildFullStepsModal, draft: buildDraftModal };

export function cardModalView(kind, rawValue) {
  let id;
  try { id = JSON.parse(rawValue)?.id; } catch { /* a bad button value shows the expired modal */ }
  const cached = typeof id === 'string' ? getCachedById(id) : null;
  return cached ? BUILDERS[kind](cached) : buildExpiredModal();
}
