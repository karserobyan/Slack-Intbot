/**
 * Handoff destinations the bot is allowed to post into.
 * A channel is included only when its name is known from the product or from
 * the team. Back office is recognized, but its channel name is not confirmed,
 * so the card can name the team and the send button stays off.
 */
export const HANDOFF_CHANNELS = Object.freeze([
  {
    who: 'pricebook',
    channel: '#ask-pricebook',
    specific: true,
    hint: 'pricebook, price book, pricing items, services and materials prices',
    pattern: /\bprice\s*books?\b|\bpricebook\b/i,
  },
  {
    who: 'public-api',
    channel: '#ask-public-api',
    specific: true,
    hint: 'public API, developer API, API v2',
    pattern: /\bpublic\s+api\b|\bdeveloper\s+api\b|\bapi\s+v2\b|\bopenapi\b|\bopen\s+api\b/i,
  },
  {
    who: 'leads',
    channel: '#ask-leads-integration',
    specific: true,
    hint: 'Angi, Thumbtack, Yelp, HomeAdvisor, and other lead providers',
    pattern: /\bangi\b|\bthumbtack\b|\byelp\b|\bhome\s*advisor\b|\blead\s+providers?\b|\bcarrier\s+leads?\b/i,
  },
  {
    who: 'back-office',
    channel: null,
    specific: true,
    hint: 'back office. Channel name is not confirmed, so do not invent one',
    pattern: /\bback[\s-]*office\b/i,
  },
  {
    who: 'engineering',
    channel: '#ask-integrations',
    specific: false,
    hint: 'Zapier, webhooks, Procore, ServiceChannel, Reserve with Google, and other integrations',
    pattern: null,
  },
  {
    who: 'partner',
    channel: null,
    specific: true,
    hint: 'a named partner channel already in the thread or the research',
    pattern: null,
  },
]);

const BY_CHANNEL = new Map(
  HANDOFF_CHANNELS.filter((entry) => entry.channel).map((entry) => [entry.channel.toLowerCase(), entry]),
);

const BY_WHO = new Map(HANDOFF_CHANNELS.map((entry) => [entry.who, entry]));

export function lookupHandoffChannel(channel) {
  if (typeof channel !== 'string') return null;
  return BY_CHANNEL.get(channel.trim().toLowerCase()) ?? null;
}

export function matchHandoffTopic(text) {
  const haystack = String(text ?? '');
  return HANDOFF_CHANNELS.find((entry) => entry.pattern && entry.pattern.test(haystack)) ?? null;
}

export function handoffChannelListForPrompt() {
  return HANDOFF_CHANNELS.map((entry) => {
    const destination = entry.channel ?? 'no confirmed channel — leave channel null';
    return `- ${entry.who} → ${destination} (${entry.hint})`;
  }).join('\n');
}

/**
 * Keep a handoff only when the destination is a known channel.
 * A specific topic (pricebook, public API, leads, back office) replaces a
 * generic #ask-integrations choice.
 */
export function settleInvolvement(involvement, contextText) {
  if (!involvement || involvement.needed !== true) {
    return { needed: false, who: null, reason: involvement?.reason ?? null, channel: null };
  }

  const topic = matchHandoffTopic(contextText);
  const named = lookupHandoffChannel(involvement.channel);
  const chosen = topic?.specific ? topic : (named ?? topic ?? BY_WHO.get(involvement.who) ?? null);

  if (!chosen?.channel) {
    return {
      needed: true,
      who: chosen?.who ?? involvement.who ?? null,
      reason: involvement.reason ?? null,
      channel: null,
    };
  }

  return {
    needed: true,
    who: chosen.who,
    reason: involvement.reason ?? null,
    channel: chosen.channel,
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
