/**
 * Reads the NEW_PIPELINE env var. Strict: only the literal string "false"
 * (case-insensitive) disables the new pipeline. Anything else — including
 * unset, "0", "no", or typos — returns true.
 *
 * Default flipped to ON after >1 week of opt-in NEW_PIPELINE=true traffic
 * with healthy `[pipeline] ok ...` log lines. Rollback path: set
 * NEW_PIPELINE=false in the deployed environment — no code redeploy.
 * Strict comparison protects against accidental rollback from typos.
 */
export function isNewPipelineEnabled() {
  return (process.env.NEW_PIPELINE ?? '').toLowerCase() !== 'false';
}
