/**
 * Reads the NEW_PIPELINE env var. The 4-stage pipeline is now the DEFAULT
 * (Phase 2, enabled 2026-06-24 after real-traffic verification). Only the
 * literal string "false" (case-insensitive) disables it — a no-deploy
 * kill-switch back to the legacy queryWithContext/queryChat path. Unset or
 * any other value uses the new pipeline.
 */
export function isNewPipelineEnabled() {
  return (process.env.NEW_PIPELINE ?? 'true').toLowerCase() !== 'false';
}
