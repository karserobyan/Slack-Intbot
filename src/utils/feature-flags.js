/**
 * Reads the NEW_PIPELINE env var. Strict: only the literal string "true"
 * (case-insensitive) returns true. Anything else, including "1" or "yes",
 * returns false. This avoids accidental enablement from typos.
 */
export function isNewPipelineEnabled() {
  return (process.env.NEW_PIPELINE ?? '').toLowerCase() === 'true';
}
