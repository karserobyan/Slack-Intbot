const CHANNEL_LIST_URL = 'https://slack.com/api/users.conversations';
const CACHE_MS = 5 * 60 * 1000;
const GENERIC_TOKENS = new Set([
  'ask', 'api', 'app', 'bot', 'team', 'support', 'help', 'general',
  'integration', 'integrations', 'question', 'questions', 'channel', 'channels',
]);

let channelCache = { at: 0, channels: [] };

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
}

function stemsMatch(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.length >= 5 && longer.startsWith(shorter);
}

function matchesIssue(channelToken, issueTokens) {
  return issueTokens.some((word) => stemsMatch(channelToken, word));
}

export function normalizeChannelName(channel) {
  const raw = String(channel ?? '').trim().replace(/^#/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(raw)) return null;
  return `#${raw}`;
}

export function lookupHandoffChannel(channel) {
  const name = normalizeChannelName(channel);
  return name ? { channel: name } : null;
}

/**
 * Pick the workspace channel whose name and purpose match this issue.
 * Channel names are not stored here — they come from the list Slack returns.
 * A tie means we do not guess.
 */
export function chooseHandoffChannel(issueText, channels) {
  const issueTokens = tokens(issueText);
  if (issueTokens.length === 0 || !Array.isArray(channels) || channels.length === 0) return null;

  const ranked = channels.map((channel) => {
    const nameTokens = tokens(channel.name);
    const aboutTokens = tokens(`${channel.purpose ?? ''} ${channel.topic ?? ''}`);
    const nameHits = nameTokens.filter((token) => matchesIssue(token, issueTokens)).length;
    const aboutHits = aboutTokens.filter((token) => (
      matchesIssue(token, issueTokens) && !nameTokens.some((nameToken) => stemsMatch(nameToken, token))
    )).length;
    return {
      channel: normalizeChannelName(channel.name),
      score: nameHits * 3 + aboutHits * 2,
      coverage: nameTokens.length ? nameHits / nameTokens.length : 0,
    };
  }).filter((entry) => entry.channel && entry.score > 0)
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage);

  if (ranked.length === 0) return null;
  const [best, second] = ranked;
  if (second && second.score === best.score && second.coverage === best.coverage) return null;
  return best.channel;
}

export function settleInvolvement(involvement, contextText, channels = []) {
  if (!involvement || involvement.needed !== true) {
    return { needed: false, who: null, reason: involvement?.reason ?? null, channel: null };
  }

  return {
    needed: true,
    who: involvement.who ?? null,
    reason: involvement.reason ?? null,
    channel: chooseHandoffChannel(contextText, channels),
  };
}

export function buildHandoffMessage({ title, diagnosis, steps, customerMessage, reason, channel, sourceRef }) {
  // title, diagnosis, steps, and reason arrive already escaped from the button.
  const lines = [`*Handoff to ${channel}*`];
  if (title) lines.push(title);
  if (diagnosis) lines.push(diagnosis);
  const stepLines = (steps ?? []).slice(0, 8).map((step, index) => {
    const num = step.num ?? index + 1;
    const head = step.title ? `${num}. ${step.title}` : `${num}.`;
    return step.detail ? `${head} — ${step.detail}` : head;
  });
  if (stepLines.length) lines.push(stepLines.join('\n'));
  if (customerMessage) lines.push(`Customer draft: ${customerMessage}`);
  if (reason) lines.push(reason);
  if (sourceRef) lines.push(sourceRef);
  return lines.join('\n\n').slice(0, 3500);
}

export function formatHandoffChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return '';
  const lines = channels.slice(0, 80).map((channel) => {
    const name = normalizeChannelName(channel.name);
    if (!name) return null;
    const about = [channel.purpose, channel.topic].filter(Boolean).join(' — ');
    return about ? `${name} — ${about}` : name;
  }).filter(Boolean);
  if (lines.length === 0) return '';
  return `[HANDOFF CHANNELS]\n${lines.join('\n')}\n[/HANDOFF CHANNELS]\n\n`;
}

export async function listPostableChannels({
  token = process.env.SLACK_BOT_TOKEN,
  fetchImpl = globalThis.fetch,
  signal,
  now = Date.now(),
} = {}) {
  if (!token || token === 'xoxb-replace-me') return [];
  const useCache = fetchImpl === globalThis.fetch;
  if (useCache && channelCache.channels.length > 0 && now - channelCache.at < CACHE_MS) {
    return channelCache.channels;
  }

  const channels = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const url = new URL(CHANNEL_LIST_URL);
    url.searchParams.set('types', 'public_channel,private_channel');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.ok === false) return [];

    for (const channel of data.channels ?? []) {
      if (!channel?.name) continue;
      channels.push({
        id: channel.id,
        name: channel.name,
        purpose: channel.purpose?.value ?? '',
        topic: channel.topic?.value ?? '',
      });
    }

    cursor = data.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }

  if (useCache) channelCache = { at: now, channels };
  return channels;
}
