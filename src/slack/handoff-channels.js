import { completeHandoffChoice } from '../claude/handoff-chooser.js';

const CHANNEL_LIST_URL = 'https://slack.com/api/conversations.list';
const CACHE_MS = 5 * 60 * 1000;

const CHOOSER_SYSTEM = `You choose where this support issue should be posted.

Reply with JSON only: {"channel":"#name","suggestions":[]} or {"channel":null,"suggestions":["#a","#b"]}.

- Copy channel names exactly from the list. Never invent a name.
- Read the issue. The wording may not match the channel name. A price book or services-and-materials problem belongs with the channel whose name or purpose is about that work. A public API problem belongs with the channel about the public API. A back-office problem belongs with the channel about back office. A lead-provider problem belongs with the channel about those leads.
- If one listed channel clearly owns the issue, set channel to that name and suggestions to []. A specific channel beats a general one.
- If several listed channels could receive it and none is clearly the one, set channel to null and suggestions to those channels, at most 3, best first.
- If no listed channel could receive it, set channel to null and suggestions to [].`;

let channelCache = { at: 0, token: '', channels: [] };

export function normalizeChannelName(channel) {
  const raw = String(channel ?? '').trim().replace(/^#/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(raw)) return null;
  return `#${raw}`;
}

export function lookupHandoffChannel(channel) {
  const name = normalizeChannelName(channel);
  return name ? { channel: name } : null;
}

export function isListedChannel(channel, channels) {
  const name = normalizeChannelName(channel);
  if (!name || !Array.isArray(channels)) return false;
  return channels.some((entry) => normalizeChannelName(entry.name) === name);
}

function catalogLines(channels) {
  return channels.map((channel) => {
    const name = normalizeChannelName(channel.name);
    if (!name) return null;
    const about = [channel.purpose, channel.topic]
      .filter(Boolean)
      .join(' — ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    return about ? `${name} — ${about}` : name;
  }).filter(Boolean);
}

const EMPTY_CHOICE = Object.freeze({ channel: null, suggestions: [] });

function listedNames(names, channels) {
  const out = [];
  for (const name of names ?? []) {
    const normalized = normalizeChannelName(name);
    if (!normalized || !isListedChannel(normalized, channels) || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function parseChoice(text) {
  try {
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) return { channel: null, suggestions: [] };
    const parsed = JSON.parse(match[0]);
    return {
      channel: parsed?.channel ?? null,
      suggestions: Array.isArray(parsed?.suggestions) ? parsed.suggestions : [],
    };
  } catch {
    return { channel: null, suggestions: [] };
  }
}

export async function chooseHandoffChannel(issueText, channels, { complete = completeHandoffChoice, signal } = {}) {
  const lines = catalogLines(channels);
  const issue = String(issueText ?? '').trim();
  if (!issue || lines.length === 0) return { ...EMPTY_CHOICE };

  let text;
  try {
    text = await complete({
      system: CHOOSER_SYSTEM,
      user: `Issue:\n${issue.slice(0, 4000)}\n\nChannels:\n${lines.join('\n')}`,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[handoff] channel choice failed:', err.message);
    return { ...EMPTY_CHOICE };
  }

  const parsed = parseChoice(text);
  const concrete = normalizeChannelName(parsed.channel);
  if (concrete && isListedChannel(concrete, channels)) {
    return { channel: concrete, suggestions: [] };
  }
  return { channel: null, suggestions: listedNames(parsed.suggestions, channels).slice(0, 3) };
}

export async function settleInvolvement(involvement, contextText, channels = [], options = {}) {
  if (!involvement || involvement.needed !== true) {
    return { needed: false, who: null, reason: involvement?.reason ?? null, channel: null, suggestions: [] };
  }

  const choice = await chooseHandoffChannel(contextText, channels, options);
  return {
    needed: true,
    who: involvement.who ?? null,
    reason: involvement.reason ?? null,
    channel: choice.channel,
    suggestions: choice.suggestions,
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

function usableToken(token) {
  return Boolean(token) && token !== 'xoxb-replace-me' && token !== 'xoxp-replace-me';
}

export async function listPostableChannels({
  token = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN,
  fetchImpl = globalThis.fetch,
  signal,
  now = Date.now(),
} = {}) {
  if (!usableToken(token)) return [];
  const useCache = fetchImpl === globalThis.fetch;
  if (useCache && channelCache.token === token && channelCache.channels.length > 0 && now - channelCache.at < CACHE_MS) {
    return channelCache.channels;
  }

  const channels = [];
  let cursor = '';
  let complete = true;
  for (let page = 0; page < 10; page++) {
    const url = new URL(CHANNEL_LIST_URL);
    url.searchParams.set('types', 'public_channel,private_channel');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    let res;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      complete = false;
      break;
    }
    if (!res.ok) {
      complete = false;
      break;
    }
    const data = await res.json();
    if (data.ok === false) {
      complete = false;
      break;
    }

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

  if (useCache && complete && channels.length > 0) channelCache = { at: now, token, channels };
  return channels;
}
