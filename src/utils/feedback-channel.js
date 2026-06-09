/**
 * Single source of truth for the feedback review channel ID.
 *
 * The bot historically had three different env var names for the same logical
 * channel (FEEDBACK_REVIEW_CHANNEL_ID, FEEDBACK_CHANNEL, FEEDBACK_CHANNEL_ID),
 * each read with a different fallback order in different modules. Always go
 * through this helper so the resolution is consistent everywhere.
 *
 * Canonical name: FEEDBACK_REVIEW_CHANNEL_ID. The other two are honored only
 * for backwards compatibility with older deployments.
 */
export function getFeedbackChannelId() {
  return (
    process.env.FEEDBACK_REVIEW_CHANNEL_ID
    || process.env.FEEDBACK_CHANNEL
    || process.env.FEEDBACK_CHANNEL_ID
    || null
  );
}
