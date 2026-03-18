import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Channel IDs come from the Slack App config (api.slack.com → OAuth & Permissions → Bot scopes).
// NOTE: GCV2UN2MA starts with 'G', meaning it is a private channel/group DM — the bot must be
// invited to that channel or conversations.history calls will silently fail (missing_scope / not_in_channel).
const CHANNELS = [
  { id: 'CAF8XRX6J',    name: 'ask-integrations' },
  { id: 'C012EQ3RMSS',  name: 'ask-leads-integration' },
  { id: 'GCV2UN2MA',    name: '200ok-specialists' },
  { id: 'C031LUD5X8A',  name: 'integrations-ts-specialists' },
];

// Hoisted to module scope so the Set is built once, not on every extractKeywords call.
const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'for', 'and', 'or', 'not', 'with', 'that', 'this', 'has', 'have', 'had', 'they', 'their', 'our', 'your']);

/**
 * Extracts meaningful keywords from a natural-language query by lowercasing,
 * stripping punctuation, and removing short words and common stop words.
 *
 * @param {string} query - Raw user query string
 * @returns {string[]} Array of filtered keyword tokens
 */
export function extractKeywords(query) {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/**
 * Counts how many of the given keywords appear in a message's text.
 *
 * @param {string} text - The Slack message text to score
 * @param {string[]} keywords - Keywords to match against
 * @returns {number} Number of keywords found in the text
 */
export function scoreMessage(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

/**
 * Searches configured Slack channels for messages relevant to the query.
 * Fetches up to `limit` recent messages from each channel, scores them by
 * keyword overlap, and returns the top `topN` results sorted by score.
 *
 * @param {string} query - Natural-language search query
 * @param {object} [options]
 * @param {number} [options.limit=200] - Max messages to fetch per channel
 * @param {number} [options.topN=5] - Number of top results to return
 * @returns {Promise<Array<{ channel: string, text: string, score: number, ts: string }>>}
 */
export async function searchSlackChannels(query, { limit = 200, topN = 5 } = {}) {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const results = await Promise.allSettled(
    CHANNELS.map(async (ch) => {
      const res = await client.conversations.history({ channel: ch.id, limit });
      return (res.messages ?? [])
        .filter((m) => m.type === 'message' && !m.subtype && m.text?.trim())
        .map((m) => ({
          channel: ch.name,
          text: m.text.slice(0, 500),
          score: scoreMessage(m.text, keywords),
          ts: m.ts,
        }))
        .filter((m) => m.score > 0);
    }),
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      console.warn('[slack-search] Channel fetch failed:', r.reason?.message);
    }
  }

  const all = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  return all
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
