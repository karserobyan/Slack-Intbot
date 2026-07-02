import { isAccountingTopic } from '../utils/accounting-filter.js';
import { queryWithContext, queryChat } from '../claude/query.js';
import { summarizeResultForHistory } from '../claude/prompts.js';
import { getHistory, hasHistory, appendToHistory } from '../slack/conversation.js';
import {
  buildResponseBlocks,
  buildAccountingRedirectBlocks,
  buildThinkingBlocks,
  buildErrorBlocks,
  buildFollowUpBlocks,
  buildHelpBlocks,
  buildHelpDetailBlocks,
  buildChatResolutionBlocks,
  buildProgressBlocks,
} from '../slack/blocks.js';
import { getCached, setCached, setCachedMulti, cacheStats } from '../slack/cache.js';
import { getRelevantFeedback } from '../slack/feedback.js';
import { checkRateLimit, rateLimitResetIn } from '../utils/rate-limiter.js';
import { nominateResponse } from '../slack/nominations.js';
import { searchKnowledgeBase } from '../claude/kb-search.js';
import { searchConfluence, searchJira } from '../claude/atlassian-search.js';
import { runPipeline } from '../claude/pipeline.js';
import { isNewPipelineEnabled } from '../utils/feature-flags.js';

function stripBotMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

// Per-request fields that depend on the current thread/channel/query and must
// NEVER be served stale from cache. `_showSpecialistValue` in particular carries
// {threadTs, channelId}; if baked into a cached result it would route a later
// asker's "Show Specialist Detail" click into the original asker's thread.
const TRANSIENT_FIELDS = ['_originalQuery', '_showSpecialistValue', '_cleanedQuestion'];

// Returns a shallow clone with all transient per-request fields removed — used
// before writing to the shared cache so stored data is request-agnostic.
export function stripTransient(data) {
  const clean = { ...data };
  for (const f of TRANSIENT_FIELDS) delete clean[f];
  return clean;
}

// Returns a shallow clone of a (possibly cached) result with the per-request
// fields freshly attached for THIS thread/channel/role. Only CSAs get the
// "Show Specialist Detail" affordance.
export function withRequestContext(data, { query, threadTs, channelId, role }) {
  const view = stripTransient(data);
  view._originalQuery = query;
  if (role === 'csa') {
    view._showSpecialistValue = JSON.stringify({ threadTs, channelId, query: query.slice(0, 800) });
  }
  return view;
}

// Returns { role: 'csa' | 'specialist', agentName } from Slack profile. Defaults to 'csa' on failure.
async function detectAgentRole(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    const profile = res.user?.profile ?? {};
    const title = profile.title ?? '';
    const agentName = profile.display_name || profile.real_name || null;

    let role = 'csa';
    if (/Specialist/i.test(title) && /Integrat/i.test(title)) {
      role = 'specialist';
    }
    // Customer Support Advocate already defaults to 'csa'

    return { role, agentName };
  } catch (err) {
    console.warn('[mention] users.info failed — defaulting to CSA mode:', err.message);
    return { role: 'csa', agentName: null };
  }
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

  // 4. Help command — all roles, always bypasses history check
  if (query.toLowerCase() === 'help') {
    const { role } = await detectAgentRole(client, userId);

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildHelpBlocks(),
      text: 'IntegrationsBot — Help',
    });

    if (role === 'specialist') {
      if (isDm) {
        // DM is already private — post detail as a follow-up message
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildHelpDetailBlocks(),
          text: 'IntegrationsBot — Full Reference',
        });
      } else {
        // Channel — send ephemeral so only the Specialist sees the detail
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          blocks: buildHelpDetailBlocks(),
          text: 'IntegrationsBot — Full Reference (Specialists only)',
        });
      }
    }
    return;
  }

  // 5. Follow-up: active thread history → conversational mode
  if (hasHistory(threadTs)) {
    if (isNewPipelineEnabled()) {
      const history = getHistory(threadTs);
      let thinkingTs;
      try {
        const thinkingMsg = await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildThinkingBlocks(query),
          text: 'Thinking…',
        });
        thinkingTs = thinkingMsg.ts;
      } catch (err) {
        console.error('[mention] Failed to post thinking message:', err.message);
      }

      const { role: fuRole, agentName: fuAgentName } = await detectAgentRole(client, userId);

      const fuSteps = [];
      let fuLastUpdateMs = 0;
      const fuOnProgress = async (event) => {
        if (event.phase === 'tool_start') {
          fuSteps.push({ tool: event.tool, phase: 'tool_start', count: null });
        } else if (event.phase === 'tool_done') {
          const existing = fuSteps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
          if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
        } else if (event.phase === 'writing') {
          fuSteps.push({ tool: null, phase: 'writing', count: null });
        } else {
          return;
        }
        const now = Date.now();
        if (thinkingTs && now - fuLastUpdateMs >= 1000) {
          fuLastUpdateMs = now;
          await client.chat.update({
            channel: channelId,
            ts: thinkingTs,
            blocks: buildProgressBlocks(query, fuSteps),
            text: 'Thinking…',
          }).catch(() => {});
        }
      };

      let pipelineResult;
      try {
        pipelineResult = await runPipeline({
          rawQuery: query,
          role: fuRole,
          agentName: fuAgentName,
          threadHistory: history,
          onProgress: fuOnProgress,
          allowClarify: false, // follow-up: never re-ask — answer or escalate (no clarification loop)
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

      if (pipelineResult.clarifying_question) {
        const qText = pipelineResult.clarifying_question;
        const blocks = buildFollowUpBlocks(qText, { label: 'Diagnosing…' });
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
        return;
      }

      if (pipelineResult.is_accounting_topic) {
        const acctBlocks = buildAccountingRedirectBlocks(query);
        if (thinkingTs) {
          await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: acctBlocks, text: 'Accounting integration — please redirect.' });
        } else {
          await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: acctBlocks, text: 'Accounting integration — please redirect.' });
        }
        return;
      }

      pipelineResult._originalQuery = query;
      if (fuRole === 'csa') {
        pipelineResult._showSpecialistValue = JSON.stringify({ threadTs, channelId, query: query.slice(0, 800) });
      }
      const fuBlocks = buildResponseBlocks(pipelineResult, { isDm, role: fuRole });
      const fuFallbackText = `Troubleshooting: ${pipelineResult.issue_title ?? query.slice(0, 80)}`;
      if (thinkingTs) {
        await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: fuBlocks, text: fuFallbackText }).catch(async () => {
          await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: fuBlocks, text: fuFallbackText });
        });
      } else {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: fuBlocks, text: fuFallbackText });
      }
      appendToHistory(threadTs, [
        { role: 'user', content: query },
        { role: 'assistant', content: summarizeResultForHistory(pipelineResult) },
      ]);
      return;
    }

    const history = getHistory(threadTs);

    let thinkingTs;
    try {
      const thinkingMsg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildThinkingBlocks(query),
        text: 'Thinking…',
      });
      thinkingTs = thinkingMsg.ts;
    } catch (err) {
      console.error('[mention] Failed to post thinking message:', err.message);
    }

    const steps = [];
    let lastUpdateMs = 0;
    const onProgress = async (event) => {
      if (event.phase === 'tool_start') {
        steps.push({ tool: event.tool, phase: 'tool_start', count: null });
      } else if (event.phase === 'tool_done') {
        const existing = steps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
        if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
      } else if (event.phase === 'writing') {
        steps.push({ tool: null, phase: 'writing', count: null });
      }
      const now = Date.now();
      if (thinkingTs && now - lastUpdateMs >= 1000) {
        lastUpdateMs = now;
        await client.chat.update({
          channel: channelId,
          ts: thinkingTs,
          blocks: buildProgressBlocks(query, steps),
          text: 'Thinking…',
        }).catch(() => {});
      }
    };

    let chatResult;
    try {
      const onProgressError = (err) => console.warn('[mention] onProgress failed:', err.message);
      Promise.resolve(onProgress({ phase: 'tool_start', tool: 'KB' })).catch(onProgressError);
      Promise.resolve(onProgress({ phase: 'tool_start', tool: 'confluence' })).catch(onProgressError);
      Promise.resolve(onProgress({ phase: 'tool_start', tool: 'jira' })).catch(onProgressError);
      const [kbFetch, confluenceFetch, jiraFetch] = await Promise.allSettled([
        searchKnowledgeBase(query),
        searchConfluence(query),
        searchJira(query),
      ]);
      const kbContext = kbFetch.status === 'fulfilled' && kbFetch.value?.text ? kbFetch.value.text : null;
      const confluenceContext = confluenceFetch.status === 'fulfilled' && confluenceFetch.value?.text ? confluenceFetch.value.text : null;
      const jiraContext = jiraFetch.status === 'fulfilled' && jiraFetch.value?.text ? jiraFetch.value.text : null;
      Promise.resolve(onProgress({ phase: 'tool_done', tool: 'KB', count: kbFetch.status === 'fulfilled' ? (kbFetch.value?.refs?.length ?? null) : null })).catch(onProgressError);
      Promise.resolve(onProgress({ phase: 'tool_done', tool: 'confluence', count: confluenceFetch.status === 'fulfilled' ? (confluenceFetch.value?.refs?.length ?? null) : null })).catch(onProgressError);
      Promise.resolve(onProgress({ phase: 'tool_done', tool: 'jira', count: jiraFetch.status === 'fulfilled' ? (jiraFetch.value?.refs?.length ?? null) : null })).catch(onProgressError);
      chatResult = await queryChat(query, history, { kbContext, confluenceContext, jiraContext, onProgress });
    } catch (err) {
      console.error('[mention] queryChat failed:', err.message);
      const errText = 'Something went wrong — please retry or escalate manually.';
      if (thinkingTs) {
        await client.chat.update({ channel: channelId, ts: thinkingTs, text: errText });
      } else {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errText });
      }
      return;
    }

    let blocks, plainText;
    if (chatResult.state === 'resolved') {
      blocks = buildChatResolutionBlocks(chatResult);
      plainText = `${chatResult.title} — ${chatResult.diagnosis}`;
    } else {
      const text = [chatResult.acknowledgement, chatResult.question].filter(Boolean).join('\n\n');
      blocks = buildFollowUpBlocks(text, { label: 'Diagnosing…' });
      plainText = text;
    }

    appendToHistory(threadTs, [
      { role: 'user',      content: query },
      { role: 'assistant', content: plainText },
    ]);

    if (thinkingTs) {
      try {
        await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: plainText.slice(0, 200) });
      } catch (err) {
        console.error('[mention] chat.update failed (follow-up), falling back to postMessage:', err.message);
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: plainText.slice(0, 200) });
      }
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: plainText.slice(0, 200) });
    }
    return;
  }

  // 6. Cache lookup
  const cached = getCached(query);
  // Observability: is the 1-hour response cache actually earning its keep?
  const _cs = cacheStats();
  console.info(`[cache] ${cached ? 'hit' : 'miss'} hitRate=${_cs.hitRate} (${_cs.hits}h/${_cs.misses}m) size=${_cs.size}/${_cs.maxEntries}`);
  if (cached) {
    const cachedIntegration = (cached.integration_type ?? 'unknown').slice(0, 50);
    const cachedSources = (cached.sources_used ?? []).join(',') || 'none';
    console.info(`[query] cache-hit confidence=${cached.confidence ?? 'unknown'} integration=${cachedIntegration} sources=${cachedSources}`);
    const { role: cachedRole } = await detectAgentRole(client, userId);
    const cachedView = withRequestContext(cached, { query, threadTs, channelId, role: cachedRole });
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildResponseBlocks(cachedView, { isDm, role: cachedRole }),
      text: `Troubleshooting steps for: ${cachedView.issue_title}`,
    });
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(cachedView) },
    ]);
    return;
  }

  // 7. Role detection + thinking placeholder (parallel, zero latency)
  const [{ role, agentName }, thinkingResult] = await Promise.allSettled([
    detectAgentRole(client, userId),
    client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildThinkingBlocks(query),
      text: 'Checking…',
    }).catch((err) => {
      console.error('[mention] Failed to post thinking message:', err.message);
      return null;
    }),
  ]).then(([roleResult, thinkingSettled]) => [
    roleResult.status === 'fulfilled' ? roleResult.value : { role: 'csa', agentName: null },
    thinkingSettled.status === 'fulfilled' ? thinkingSettled.value : null,
  ]);

  const thinkingTs = thinkingResult?.ts;

  if (isNewPipelineEnabled()) {
    const queryStartPipe = Date.now();
    const pipeSteps = [];
    let pipeLastUpdateMs = 0;
    const pipeOnProgress = async (event) => {
      if (event.phase === 'tool_start') {
        pipeSteps.push({ tool: event.tool, phase: 'tool_start', count: null });
      } else if (event.phase === 'tool_done') {
        const existing = pipeSteps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
        if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
      } else if (event.phase === 'writing') {
        pipeSteps.push({ tool: null, phase: 'writing', count: null });
      } else {
        return;
      }
      const now = Date.now();
      if (thinkingTs && now - pipeLastUpdateMs >= 1000) {
        pipeLastUpdateMs = now;
        await client.chat.update({
          channel: channelId,
          ts: thinkingTs,
          blocks: buildProgressBlocks(query, pipeSteps),
          text: 'Checking…',
        }).catch(() => {});
      }
    };

    let pipelineResult;
    try {
      pipelineResult = await runPipeline({
        rawQuery: query,
        role,
        agentName,
        onProgress: pipeOnProgress,
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

    if (pipelineResult.clarifying_question) {
      const qText = pipelineResult.clarifying_question;
      const blocks = buildFollowUpBlocks(qText);
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
      return;
    }

    if (pipelineResult.is_accounting_topic) {
      const acctBlocks = buildAccountingRedirectBlocks(query);
      if (thinkingTs) {
        await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: acctBlocks, text: 'Accounting integration — please redirect to #ask-partner-enabled-accounting-integrations.' });
      } else {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: acctBlocks, text: 'Accounting integration — please redirect.' });
      }
      return;
    }

    const cleanedKey = pipelineResult._cleanedQuestion;
    delete pipelineResult._cleanedQuestion;

    pipelineResult._originalQuery = query;
    if (role === 'csa') {
      pipelineResult._showSpecialistValue = JSON.stringify({ threadTs, channelId, query: query.slice(0, 800) });
    }

    const CACHE_MIN_MS_PIPE = parseInt(process.env.CACHE_MIN_MS ?? '30000', 10);
    if ((Date.now() - queryStartPipe) >= CACHE_MIN_MS_PIPE) {
      setCachedMulti([query, cleanedKey].filter(Boolean), stripTransient(pipelineResult));
    }

    const pipeIntegration = (pipelineResult.integration_type ?? 'unknown').slice(0, 50);
    const pipeSources = (pipelineResult.sources_used ?? []).join(',') || 'none';
    console.info(`[query] pipeline role=${role} confidence=${pipelineResult.confidence ?? 'unknown'} integration=${pipeIntegration} sources=${pipeSources}`);

    const responseBlocks = buildResponseBlocks(pipelineResult, { isDm, role });
    const fallbackText = `Troubleshooting: ${pipelineResult.issue_title} (${pipelineResult.integration_type})`;
    if (thinkingTs) {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: responseBlocks, text: fallbackText }).catch(async () => {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: responseBlocks, text: fallbackText });
      });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: responseBlocks, text: fallbackText });
    }

    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(pipelineResult) },
    ]);

    const KNOWLEDGE_MIN_MS_PIPE = parseInt(process.env.KNOWLEDGE_MIN_MS ?? '30000', 10);
    const hasRefs = (pipelineResult.slack_refs?.length > 0) || (pipelineResult.atlassian_refs?.length > 0);
    const noEscalation = pipelineResult.escalate_decision?.should_escalate !== true;
    const hasSteps = (pipelineResult.agent_steps?.length ?? 0) > 0;
    if (
      (Date.now() - queryStartPipe) >= KNOWLEDGE_MIN_MS_PIPE &&
      hasRefs &&
      noEscalation &&
      hasSteps
    ) {
      const agentSteps = (pipelineResult.agent_steps ?? []).map((s) => `${s.title}: ${s.detail}`.slice(0, 200));
      const refs = [
        ...(pipelineResult.slack_refs ?? []).slice(0, 2).map((r) => `Slack ${r.channel ?? ''} ${r.title ?? ''}`.trim()),
        ...(pipelineResult.atlassian_refs ?? []).slice(0, 2).map((r) => `${r.type ?? 'Atlassian'}: ${r.title ?? ''}`.trim()),
      ].filter(Boolean);
      nominateResponse(client, {
        integration: pipelineResult.integration_type ?? 'General',
        issueTitle: pipelineResult.issue_title ?? query.slice(0, 80),
        steps: agentSteps,
        refs,
      }).catch((err) => console.warn('[mention] nominateResponse failed (non-critical):', err.message));
    }
    return;
  }

  // 8. Feedback corrections context
  let feedbackContext = '';
  try {
    const corrections = await getRelevantFeedback(query);
    if (corrections.length > 0) {
      // Sanitize corrections before injecting into the Claude prompt to prevent prompt injection.
      // Strip markdown headers and limit length on each field.
      const sanitize = (str) => String(str ?? '')
        .replace(/^#+\s*/gm, '')   // remove markdown headers
        .replace(/^\s*[-*>]+/gm, '') // remove list/quote markers at line start
        .trim()
        .slice(0, 300);

      const lines = corrections.map(
        (c) => `- Query: "${sanitize(c.query)}" → Bot was wrong (${c.feedbackType}). Correct answer: ${sanitize(c.correction)}`,
      );
      feedbackContext = `\n\nIMPORTANT — Past corrections from agents (use these to avoid repeating mistakes):\n${lines.join('\n')}`;
    }
  } catch {
    // feedback lookup failure is non-critical
  }

  // 10. Full Claude query (MCP search — slowest path)
  const queryStart = Date.now();
  const steps = [];
  let lastUpdateMs = 0;
  const onProgress = async (event) => {
    if (event.phase === 'tool_start') {
      steps.push({ tool: event.tool, phase: 'tool_start', count: null });
    } else if (event.phase === 'tool_done') {
      const existing = steps.findLast(s => s.tool === event.tool && s.phase === 'tool_start');
      if (existing) { existing.phase = 'tool_done'; existing.count = event.count; }
    } else if (event.phase === 'writing') {
      steps.push({ tool: null, phase: 'writing', count: null });
    }
    const now = Date.now();
    if (thinkingTs && now - lastUpdateMs >= 1000) {
      lastUpdateMs = now;
      await client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        blocks: buildProgressBlocks(query, steps),
        text: 'Checking…',
      }).catch(() => {});
    }
  };

  let result;
  try {
    result = await queryWithContext(query + feedbackContext, { role, agentName, onProgress });
  } catch (err) {
    console.error('[mention] Claude query failed:', err.message);

    const updateTarget = thinkingTs ?? threadTs;
    if (thinkingTs) {
      await client.chat.update({
        channel: channelId,
        ts: updateTarget,
        blocks: buildErrorBlocks(query),
        text: 'Something went wrong — please retry or escalate manually.',
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildErrorBlocks(query),
        text: 'Something went wrong — please retry or escalate manually.',
      });
    }
    return;
  }

  // 11. Attach query metadata + conditionally cache result
  result._originalQuery = query;
  if (role === 'csa') {
    result._showSpecialistValue = JSON.stringify({
      threadTs,
      channelId,
      query: query.slice(0, 800),
    });
  }
  const CACHE_MIN_MS = parseInt(process.env.CACHE_MIN_MS ?? '30000', 10);
  if (!result.clarifying_question && (Date.now() - queryStart) >= CACHE_MIN_MS) setCached(query, stripTransient(result));

  // 12. Accounting redirect from AI (double-check)
  if (result.is_accounting_topic) {
    const accountingBlocks = buildAccountingRedirectBlocks(query);
    if (thinkingTs) {
      await client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        blocks: accountingBlocks,
        text: 'Accounting integration — please redirect to #ask-partner-enabled-accounting-integrations.',
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: accountingBlocks,
        text: 'Accounting integration — please redirect.',
      });
    }
    return;
  }

  // 13. Clarifying question from AI
  if (result.clarifying_question) {
    const questionText = result.clarifying_question;
    if (thinkingTs) {
      await client.chat.update({
        channel: channelId,
        ts: thinkingTs,
        blocks: buildFollowUpBlocks(questionText),
        text: questionText.slice(0, 200),
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: buildFollowUpBlocks(questionText),
        text: questionText.slice(0, 200),
      });
    }
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(result) },
    ]);
    return;
  }

  const liveIntegration = (result.integration_type ?? 'unknown').slice(0, 50);
  const liveSources = (result.sources_used ?? []).join(',') || 'none';
  console.info(`[query] role=${role} confidence=${result.confidence ?? 'unknown'} integration=${liveIntegration} sources=${liveSources}`);

  // 14. Deliver response
  const responseBlocks = buildResponseBlocks(result, { isDm, role });
  const fallbackText = `Troubleshooting: ${result.issue_title} (${result.integration_type})`;

  if (thinkingTs) {
    try {
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks: responseBlocks, text: fallbackText });
    } catch (err) {
      console.error('[mention] chat.update failed, falling back to postMessage:', err.message);
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: responseBlocks, text: fallbackText });
    }
  } else {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks: responseBlocks, text: fallbackText });
  }

  // 15. Seed conversation history (after delivery so accounting redirects never seed history)
  appendToHistory(threadTs, [
    { role: 'user', content: query },
    { role: 'assistant', content: summarizeResultForHistory(result) },
  ]);

  // 16. Nominate for knowledge base
  const KNOWLEDGE_MIN_MS = parseInt(process.env.KNOWLEDGE_MIN_MS ?? '30000', 10);
  const hasRefs = (result.slack_refs?.length > 0) || (result.atlassian_refs?.length > 0);
  const noEscalation = result.escalate_decision?.should_escalate !== true;
  const hasSteps = (result.agent_steps?.length ?? 0) > 0;

  if (
    (Date.now() - queryStart) >= KNOWLEDGE_MIN_MS &&
    hasRefs &&
    noEscalation &&
    hasSteps &&
    !result.clarifying_question
  ) {
    const agentSteps = (result.agent_steps ?? []).map((s) => `${s.title}: ${s.detail}`.slice(0, 200));
    const refs = [
      ...(result.slack_refs ?? []).slice(0, 2).map((r) => `Slack ${r.channel ?? ''} ${r.title ?? ''}`.trim()),
      ...(result.atlassian_refs ?? []).slice(0, 2).map((r) => `${r.type ?? 'Atlassian'}: ${r.title ?? ''}`.trim()),
    ].filter(Boolean);

    nominateResponse(client, {
      integration: result.integration_type ?? 'General',
      issueTitle: result.issue_title ?? query.slice(0, 80),
      steps: agentSteps,
      refs,
    }).catch((err) => console.warn('[mention] nominateResponse failed (non-critical):', err.message));
  }
}

export function registerMentionHandler(app) {
  const _inFlight = new Set();

  app.event('app_mention', async ({ event, client, logger }) => {
    if (event.channel_type === 'im' || event.channel.startsWith('D')) return;
    if (_inFlight.has(event.ts)) {
      logger.warn(`[mention] Duplicate event ${event.ts} — skipping`);
      return;
    }
    _inFlight.add(event.ts);

    logger.info(`[mention] ${event.user} in ${event.channel}: ${event.text?.slice(0, 80)}`);

    try {
      await handleQuery({
        rawText:   event.text ?? '',
        channelId: event.channel,
        threadTs:  event.thread_ts ?? event.ts,
        client,
        userId:    event.user,
      });
    } finally {
      setTimeout(() => _inFlight.delete(event.ts), 60_000);
    }
  });
}
