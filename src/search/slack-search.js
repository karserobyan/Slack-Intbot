import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

const CHANNELS = [
  { id: 'CAF8XRX6J',    name: 'ask-integrations' },
  { id: 'C012EQ3RMSS',  name: 'ask-leads-integration' },
  { id: 'GCV2UN2MA',    name: '200ok-specialists' },
  { id: 'C031LUD5X8A',  name: 'integrations-ts-specialists' },
];

export function extractKeywords(query) {
  const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'for', 'and', 'or', 'not', 'with', 'that', 'this', 'has', 'have', 'had', 'they', 'their', 'our', 'your']);
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

export function scoreMessage(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

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

  const all = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  return all
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
