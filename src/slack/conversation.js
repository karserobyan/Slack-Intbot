/**
 * Per-thread conversation history store.
 *
 * Key design:
 * - TTL: 4 hours (covers a full support interaction)
 * - Max messages: 20 per thread (caps token cost on long conversations)
 * - Key: Slack thread timestamp (threadTs)
 * - Message format: { role: 'user' | 'assistant', content: string }
 *   — matches the Anthropic messages API format directly
 */

const TTL_MS = parseInt(process.env.CONVERSATION_TTL_MS ?? String(4 * 60 * 60 * 1000), 10) || 4 * 60 * 60 * 1000;
const MAX_MESSAGES = 20;

/** @type {Map<string, { messages: Array<{role: string, content: string}>, expiresAt: number }>} */
const store = new Map();

/**
 * Returns the message history for a thread, or null if none exists / expired.
 * @param {string} threadTs - Slack thread timestamp
 * @returns {Array<{role: string, content: string}>|null}
 */
export function getHistory(threadTs) {
  const entry = store.get(threadTs);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(threadTs);
    return null;
  }
  return entry.messages;
}

/**
 * Returns true if a thread has active (non-expired) history.
 * @param {string} threadTs
 * @returns {boolean}
 */
export function hasHistory(threadTs) {
  return getHistory(threadTs) !== null;
}

/**
 * Appends new messages to a thread's history.
 * Creates the entry if it doesn't exist. Resets TTL on each append.
 * Trims to MAX_MESSAGES by dropping the oldest messages when the cap is hit.
 *
 * @param {string} threadTs - Slack thread timestamp
 * @param {Array<{role: string, content: string}>} messages - New messages to append
 */
export function appendToHistory(threadTs, messages) {
  const existing = getHistory(threadTs) ?? [];
  const combined = [...existing, ...messages];
  // Trim to cap — drop oldest messages first
  const trimmed = combined.length > MAX_MESSAGES
    ? combined.slice(combined.length - MAX_MESSAGES)
    : combined;
  store.set(threadTs, { messages: trimmed, expiresAt: Date.now() + TTL_MS });
}

/**
 * Removes all expired thread histories. Call periodically to keep memory tidy.
 */
export function pruneConversations() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}
