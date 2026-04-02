/**
 * In-memory per-user rate limiter.
 * Allows MAX_CALLS calls per user within WINDOW_MS milliseconds.
 * Exceeding the limit returns false; the caller should post a message and skip processing.
 */

const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10) || 60000; // 1 minute
const MAX_CALLS = parseInt(process.env.RATE_LIMIT_MAX ?? '5', 10) || 5; // 5 calls per window

/** @type {Map<string, { count: number, resetAt: number }>} */
const _limits = new Map();

/**
 * Returns true if the user is within their rate limit, false if they've exceeded it.
 * @param {string} userId
 * @returns {boolean}
 */
export function checkRateLimit(userId) {
  const now = Date.now();
  const entry = _limits.get(userId);

  if (!entry || now >= entry.resetAt) {
    _limits.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= MAX_CALLS) {
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Returns seconds until the rate limit window resets for a user.
 * @param {string} userId
 * @returns {number}
 */
export function rateLimitResetIn(userId) {
  const entry = _limits.get(userId);
  if (!entry) return 0;
  return Math.ceil((entry.resetAt - Date.now()) / 1000);
}

// Clean up expired entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of _limits.entries()) {
    if (now >= entry.resetAt) _limits.delete(userId);
  }
}, 5 * 60 * 1000);
