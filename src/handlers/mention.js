import { isAccountingTopic } from '../utils/accounting-filter.js';
import { queryWithContext, queryChat, queryWithKnowledge } from '../claude/query.js';
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
import { getCached, setCached } from '../slack/cache.js';
import { getRelevantFeedback } from '../slack/feedback.js';
import { checkRateLimit, rateLimitResetIn } from '../utils/rate-limiter.js';
import { getKnowledge } from '../slack/knowledge.js';
import { nominateResponse } from '../slack/nominations.js';
import { searchKnowledgeBase } from '../claude/kb-search.js';

function stripBotMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
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

  // 1. Empty query — greet and return early
  if (!query) {
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
      const [kbFetch] = await Promise.allSettled([searchKnowledgeBase(query)]);
      const kbContext = kbFetch.status === 'fulfilled' && kbFetch.value?.text ? kbFetch.value.text : null;
      chatResult = await queryChat(query, history, { kbContext, onProgress });
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
      await client.chat.update({ channel: channelId, ts: thinkingTs, blocks, text: plainText.slice(0, 200) });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, blocks, text: plainText.slice(0, 200) });
    }
    return;
  }

  // 6. Cache lookup
  const cached = getCached(query);
  if (cached) {
    const cachedIntegration = (cached.integration_type ?? 'unknown').slice(0, 50);
    const cachedSources = (cached.sources_used ?? []).join(',') || 'none';
    console.info(`[query] cache-hit confidence=${cached.confidence ?? 'unknown'} integration=${cachedIntegration} sources=${cachedSources}`);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: buildResponseBlocks(cached, { isDm }),
      text: `Troubleshooting steps for: ${cached.issue_title}`,
    });
    appendToHistory(threadTs, [
      { role: 'user', content: query },
      { role: 'assistant', content: summarizeResultForHistory(cached) },
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

  // 8. Tier 2: knowledge.md fast-lookup (no MCP, no cache miss)
  try {
    const knowledge = await getKnowledge();
    if (knowledge) {
      let fastResult = null;
      try {
        fastResult = await queryWithKnowledge(query, knowledge, { role, agentName });
      } catch (err) {
        console.warn('[mention] Knowledge fast-lookup failed, falling through:', err.message);
      }

      if (fastResult && !fastResult.clarifying_question && fastResult.confidence !== 'low') {
        console.info(`[query] knowledge-hit confidence=${fastResult.confidence ?? 'unknown'} integration=${(fastResult.integration_type ?? 'unknown').slice(0, 50)}`);

        fastResult._originalQuery = query;
        if (role === 'csa') {
          fastResult._showSpecialistValue = JSON.stringify({ threadTs, channelId, query: query.slice(0, 800) });
        }

        if (thinkingTs) {
          await client.chat.update({
            channel: channelId,
            ts: thinkingTs,
            blocks: buildResponseBlocks(fastResult, { isDm }),
            text: `Troubleshooting steps for: ${fastResult.issue_title}`,
          });
        } else {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            blocks: buildResponseBlocks(fastResult, { isDm }),
            text: `Troubleshooting steps for: ${fastResult.issue_title}`,
          });
        }

        appendToHistory(threadTs, [
          { role: 'user', content: query },
          { role: 'assistant', content: summarizeResultForHistory(fastResult) },
        ]);

        return;
      }
      // Low confidence or clarifying question — fall through to full MCP search
    }
  } catch (err) {
    console.warn('[mention] Step 2.5 unexpected error, continuing to full search:', err.message);
  }

  // 9. Feedback corrections context
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
  if (!result.clarifying_question && (Date.now() - queryStart) >= CACHE_MIN_MS) setCached(query, result);

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
  const responseBlocks = buildResponseBlocks(result, { isDm });
  const fallbackText = `Troubleshooting: ${result.issue_title} (${result.integration_type})`;

  if (thinkingTs) {
    await client.chat.update({
      channel: channelId,
      ts: thinkingTs,
      blocks: responseBlocks,
      text: fallbackText,
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: responseBlocks,
      text: fallbackText,
    });
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
