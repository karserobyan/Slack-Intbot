import { isAccountingTopic } from '../utils/accounting-filter.js';
import { summarizeResultForHistory } from '../claude/prompts.js';
import { getHistory, hasHistory, appendToHistory } from '../slack/conversation.js';
import {
  buildResponseBlocks,
  buildThreadReplyBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildProgressBlocks,
} from '../slack/blocks.js';
import { getCached, setCachedMulti, cacheStats } from '../slack/cache.js';
import { checkRateLimit, rateLimitResetIn } from '../utils/rate-limiter.js';
import { nominateResponse } from '../slack/nominations.js';
import { runPipeline } from '../claude/pipeline.js';
import { recordQualityShadow } from '../quality/shadow-recorder.js';

function stripBotMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

// Per-request fields that depend on the current thread/channel/query and must
// NEVER be served stale from cache.
const TRANSIENT_FIELDS = ['_originalQuery', '_cleanedQuestion'];

// Returns a shallow clone with all transient per-request fields removed — used
// before writing to the shared cache so stored data is request-agnostic.
export function stripTransient(data) {
  const clean = { ...data };
  for (const f of TRANSIENT_FIELDS) delete clean[f];
  return clean;
}

// Returns a shallow clone of a (possibly cached) result with the per-request
// fields freshly attached for THIS thread/channel.
export function withRequestContext(data, { query, threadTs, channelId }) {
  const view = stripTransient(data);
  view._originalQuery = query;
  return view;
}

async function deliverPipelineResult({
  pipelineResult,
  query,
  channelId,
  threadTs,
  client,
  thinkingTs,
  isDm,
  followUp = false,
}) {
  if (pipelineResult.clarifying_question) {
    const qText = pipelineResult.clarifying_question;
    const blocks = buildFollowUpBlocks(qText, followUp ? { label: 'Diagnosing…' } : undefined);
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: qText.slice(0, 200) }).catch(async () => {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: qText.slice(0, 200) });
      });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: qText.slice(0, 200) });
    }
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: qText },
    ]);
    return { delivered: true, clarifying: true };
  }

  const cleanedKey = pipelineResult._cleanedQuestion;
  delete pipelineResult._cleanedQuestion;

  const view = withRequestContext(pipelineResult, { query, threadTs, channelId });
  const blocks = followUp ? buildThreadReplyBlocks(view) : buildResponseBlocks(view, { isDm });
  const fallbackText = followUp
    ? String(view.diagnosis ?? view.issue_title ?? query).slice(0, 200)
    : `Troubleshooting: ${view.issue_title} (${view.integration_type})`;

  if (thinkingTs) {
    await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: fallbackText }).catch(async () => {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: fallbackText });
    });
  } else {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: fallbackText });
  }

  const assistantTurn = followUp
    ? String(view.diagnosis ?? '').trim() || summarizeResultForHistory(view)
    : summarizeResultForHistory(view);
  appendToHistory(threadTs, [
    { role: 'user', content: query },
    { role: 'assistant', content: assistantTurn },
  ]);

  return { delivered: true, clarifying: false, view, cleanedKey };
}

function maybeNominate(client, result, query, queryStart) {
  const KNOWLEDGE_MIN_MS = parseInt(process.env.KNOWLEDGE_MIN_MS ?? '30000', 10);
  const hasRefs = (result.slack_refs?.length > 0) || (result.atlassian_refs?.length > 0);
  const noEscalation = result.involvement?.needed !== true;
  const hasSteps = (result.steps?.length ?? 0) > 0;
  if (
    (Date.now() - queryStart) >= KNOWLEDGE_MIN_MS &&
    hasRefs &&
    noEscalation &&
    hasSteps
  ) {
    const steps = (result.steps ?? []).map((s) => `${s.title}: ${s.detail}`.slice(0, 200));
    const refs = [
      ...(result.slack_refs ?? []).slice(0, 2).map((r) => `Slack ${r.channel ?? ''} ${r.title ?? ''}`.trim()),
      ...(result.atlassian_refs ?? []).slice(0, 2).map((r) => `${r.type ?? 'Atlassian'}: ${r.title ?? ''}`.trim()),
    ].filter(Boolean);
    nominateResponse(client, {
      integration: result.integration_type ?? 'General',
      issueTitle: result.issue_title ?? query.slice(0, 80),
      steps,
      refs,
    }).catch((err) => console.warn('[mention] nominateResponse failed (non-critical):', err.message));
  }
}

function makeProgressHandler({ client, channelId, thinkingTs, query, thinkingLabel, followUp = false }) {
  const steps = [];
  let lastUpdateMs = 0;
  return async (event) => {
    if (event.phase === 'tool_start') {
      steps.push({ tool: event.tool, phase: 'tool_start', count: null });
    } else if (event.phase === 'tool_done') {
      const existing = steps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
      if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
    } else if (event.phase === 'writing') {
      steps.push({ tool: null, phase: 'writing', count: null });
    } else {
      return;
    }
    const now = Date.now();
    if (thinkingTs && now - lastUpdateMs >= 1000) {
      lastUpdateMs = now;
      await client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        blocks: buildProgressBlocks(query, steps, { followUp }),
        text: thinkingLabel,
      }).catch(() => {});
    }
  };
}

// Core query handler — shared by mention.js and dm.js.
export async function handleQuery({ rawText, channelId, threadTs, client, userId, isDm = false }) {
  const query = stripBotMention(rawText);

  // 1. Empty query — greet and return early (silent in DMs, session card already guides the user)
  if (!query) {
    if (isDm) return;
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "Hi! Ask me about a ServiceTitan integration issue and I'll help you troubleshoot it. For example: _\"Customer's Zapier integration isn't working — they say API access was never set up.\"_",
    });
    return;
  }

  // 2. Rate limit — prevent spam
  if (!checkRateLimit(userId)) {
    const resetIn = rateLimitResetIn(userId);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `⏳ You're sending requests too quickly. Please wait ${resetIn}s before trying again.`,
    });
    return;
  }

  // 3. Fast-path: accounting redirect (keyword match, no Claude)
  if (isAccountingTopic(query)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildAccountingRedirectBlocks(query),
      text: 'This question is about accounting integrations — please redirect to #ask-partner-enabled-accounting-integrations.',
    });
    return;
  }

  // 4. Help command — always bypasses history check
  if (query.toLowerCase() === 'help') {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildHelpBlocks(),
      text: 'IntegrationsBot — Help',
    });
    return;
  }

  // 5. Follow-up: active thread history → pipeline with allowClarify=false
  if (hasHistory(threadTs)) {
    const history = getHistory(threadTs);
    let thinkingTs;
    try {
      const thinkingMsg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildThinkingBlocks(query, { followUp: true }),
        text: 'Replying…',
      });
      thinkingTs = thinkingMsg.ts;
    } catch (err) {
      console.error('[mention] Failed to post thinking message:', err.message);
    }

    const onProgress = makeProgressHandler({
      client, channelId, thinkingTs, query, thinkingLabel: 'Replying…', followUp: true,
    });

    let pipelineResult;
    try {
      pipelineResult = await runPipeline({
        rawQuery: query,
        threadHistory: history,
        onProgress,
        allowClarify: false,
      });
    } catch (err) {
      console.error('[mention] pipeline (follow-up) failed:', err.message);
      const errText = err.pipelineTimedOut
        ? 'This question took longer than 60 seconds to investigate — try a more specific phrasing, or escalate manually.'
        : 'Something went wrong — please retry or escalate manually.';
      if (thinkingTs) {
        await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: buildErrorBlocks(query), text: errText });
      } else {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: buildErrorBlocks(query), text: errText });
      }
      return;
    }

    await deliverPipelineResult({
      pipelineResult,
      query,
      channelId,
      threadTs,
      client,
      thinkingTs,
      isDm,
      followUp: true,
    });
    return;
  }

  // 6. Cache lookup
  const cached = getCached(query);
  const _cs = cacheStats();
  console.info(`[cache] ${cached ? 'hit' : 'miss'} hitRate=${_cs.hitRate} (${_cs.hits}h/${_cs.misses}m) size=${_cs.size}/${_cs.maxEntries}`);
  if (cached) {
    const cachedIntegration = (cached.integration_type ?? 'unknown').slice(0, 50);
    const cachedSources = (cached.sources_used ?? []).join(',') || 'none';
    console.info(`[query] cache-hit confidence=${cached.confidence ?? 'unknown'} integration=${cachedIntegration} sources=${cachedSources}`);
    const cachedView = withRequestContext(cached, { query, threadTs, channelId });
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildResponseBlocks(cachedView, { isDm }),
      text: `Troubleshooting steps for: ${cachedView.issue_title}`,
    });
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(cachedView) },
    ]);
    return;
  }

  // 7. Thinking placeholder + pipeline
  let thinkingTs;
  try {
    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildThinkingBlocks(query),
      text: 'Checking…',
    });
    thinkingTs = thinkingMsg.ts;
  } catch (err) {
    console.error('[mention] Failed to post thinking message:', err.message);
  }

  const queryStart = Date.now();
  const onProgress = makeProgressHandler({
    client, channelId, thinkingTs, query, thinkingLabel: 'Checking…',
  });

  let pipelineResult;
  try {
    pipelineResult = await runPipeline({
      rawQuery: query,
      onProgress,
    });
  } catch (err) {
    console.error('[mention] pipeline (initial) failed:', err.message);
    const errBlocks = buildErrorBlocks(query);
    const errText = err.pipelineTimedOut
      ? 'This question took longer than 60 seconds to investigate — try a more specific phrasing, or escalate manually.'
      : 'Something went wrong — please retry or escalate manually.';
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: errBlocks, text: errText });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: errBlocks, text: errText });
    }
    return;
  }

  const delivered = await deliverPipelineResult({
    pipelineResult,
    query,
    channelId,
    threadTs,
    client,
    thinkingTs,
    isDm,
    followUp: false,
  });

  if (delivered.clarifying) return;

  const CACHE_MIN_MS = parseInt(process.env.CACHE_MIN_MS ?? '30000', 10);
  if ((Date.now() - queryStart) >= CACHE_MIN_MS) {
    setCachedMulti([query, delivered.cleanedKey].filter(Boolean), stripTransient(delivered.view));
  }

  const pipeIntegration = (delivered.view.integration_type ?? 'unknown').slice(0, 50);
  const pipeSources = (delivered.view.sources_used ?? []).join(',') || 'none';
  console.info(`[query] pipeline confidence=${delivered.view.confidence ?? 'unknown'} integration=${pipeIntegration} sources=${pipeSources}`);

  recordQualityShadow({
    answer: delivered.view,
    query,
    channelId,
    threadTs,
    logger: console,
  }).catch((err) => console.warn('[quality] shadow record failed:', err.message));

  maybeNominate(client, delivered.view, query, queryStart);
}

export function registerMentionHandler(app, { queryHandler = handleQuery, dedupeTtlMs = 60_000 } = {}) {
  const _inFlight = new Set();

  app.event('app_mention', async ({ event, body, client, logger }) => {
    if (event.channel_type === 'im' || event.channel.startsWith('D')) return;
    const eventKey = body?.event_id ?? event.ts;
    if (_inFlight.has(eventKey)) {
      logger.warn(`[mention] Duplicate event ${eventKey} — skipping`);
      return;
    }
    _inFlight.add(eventKey);

    logger.info(`[mention] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);

    try {
      await queryHandler({
        rawText:   event.text ?? '',
        channelId: event.channel,
        threadTs:  event.thread_ts ?? event.ts,
        client,
        userId:    event.user,
      });
    } catch (err) {
      logger.error?.(`[mention] unhandled failure event=${eventKey} channel=${event.channel} ts=${event.ts} user=${event.user}: ${err.message}`);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: 'I hit an internal error handling this request. Please retry or escalate manually.',
      }).catch((postErr) => {
        logger.error?.(`[mention] failed to post fallback for event=${eventKey}: ${postErr.message}`);
      });
    } finally {
      setTimeout(() => _inFlight.delete(eventKey), dedupeTtlMs);
    }
  });
}
