import { runInterpreter } from './interpreter.js';
import { executeSearchPlan } from './search-executor.js';
import { runEvaluator } from './evaluator.js';
import { runResolver, runReply } from './answerer.js';
import { customerWasMentioned, RETIRED_ROLE_FIELDS } from './answer-schema.js';
import { getKnowledge } from '../slack/knowledge.js';
import { getRelevantFeedback } from '../slack/feedback.js';
import { appendKbArticle } from '../slack/knowledge-writer.js';

const HARD_CAP_MS = 60000;

const FALLBACK_REASON = 'Not enough detail to resolve automatically — add specifics or escalate manually.';

function sanitize(str) {
  return String(str ?? '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*>]+/gm, '')
    .trim()
    .slice(0, 300);
}

async function buildFeedbackContext(rawQuery) {
  try {
    const corrections = await getRelevantFeedback(rawQuery);
    if (corrections.length === 0) return '';
    const lines = corrections.map(c =>
      `- Query: "${sanitize(c.query)}" → Bot was wrong (${c.feedbackType}). Correct answer: ${sanitize(c.correction)}`,
    );
    return `\n\nIMPORTANT — Past corrections from agents (use these to avoid repeating mistakes):\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

function stripRetiredAndNonModelFields(resolver) {
  delete resolver.clarifying_question;
  delete resolver.is_accounting_topic;
  delete resolver.customer_message;
  for (const key of RETIRED_ROLE_FIELDS) delete resolver[key];
}

function applyCappedFallback(answer) {
  const missingCore = !answer.issue_title || !(answer.steps?.length);
  if (!missingCore) return;

  console.info('[pipeline] resolver missing required fields on a capped follow-up — coercing to best-effort/escalate');
  answer.issue_title = 'Not enough detail to resolve';
  answer.confidence = 'low';
  answer.diagnosis = FALLBACK_REASON;
  answer.steps = [{ num: 1, title: 'Escalate for more detail', detail: FALLBACK_REASON, tag: 'escalate' }];
  answer.involvement = {
    needed: true,
    who: 'engineering',
    reason: FALLBACK_REASON,
    channel: '#ask-integrations',
  };
  if (!Array.isArray(answer.slack_refs)) answer.slack_refs = [];
  if (!Array.isArray(answer.atlassian_refs)) answer.atlassian_refs = [];
  if (!Array.isArray(answer.kb_refs)) answer.kb_refs = [];
  if (!Array.isArray(answer.sources_used)) answer.sources_used = [];
  if (!answer.integration_type) answer.integration_type = 'General';
}

export async function runPipeline({ rawQuery, threadHistory = [], onProgress, allowClarify = true }) {
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), HARD_CAP_MS);
  const signal = overall.signal;

  const t0 = Date.now();
  const timings = {};

  try {
    onProgress?.({ phase: 'stage', stage: 'interpreter' });
    const tInterp = Date.now();
    const interp = await runInterpreter(rawQuery, { threadHistory, signal });
    timings.interpreter = Date.now() - tInterp;

    // Only ask a clarifying question when clarification is still allowed. On a
    // thread follow-up the caller passes allowClarify=false — the bot has already
    // engaged, so re-asking would create the "answer → question → answer →
    // question" loop. Instead we fall through and answer best-effort.
    if (interp.question_confidence === 'low' && allowClarify) {
      console.info(`[pipeline] shortcut=clarifying interpreter=${timings.interpreter}ms total=${Date.now() - t0}ms`);
      return {
        clarifying_question: interp.clarifying_question,
        cleaned_question: interp.cleaned_question,
      };
    }

    // A low-confidence interpret leaves search_plan null; when clarification is
    // capped, synthesize a plan from the cleaned/raw question so the answerer
    // still has something to work with (resolve-or-escalate, never loop). Uses
    // the fast REST sources only — skip the slow KB web-search on a query too
    // vague to have anchored it in the first place.
    const searchPlan = interp.search_plan ?? {
      sources: [
        { name: 'confluence', priority: 'high', query: interp.cleaned_question || rawQuery },
        { name: 'slack', priority: 'high', query: interp.cleaned_question || rawQuery },
      ],
      rationale: 'clarification capped — answering with best available context',
    };
    if (interp.question_confidence === 'low') {
      console.info(`[pipeline] clarification capped — forcing best-effort answer (interpreter=${timings.interpreter}ms)`);
    }

    onProgress?.({ phase: 'stage', stage: 'search-1' });
    const tSearch1 = Date.now();
    let searchResults = await executeSearchPlan(searchPlan, { onProgress, signal });
    timings.search1 = Date.now() - tSearch1;

    onProgress?.({ phase: 'stage', stage: 'evaluator' });
    const tEval = Date.now();
    const evaluation = await runEvaluator({
      cleanedQuestion: interp.cleaned_question,
      searchResults,
      originalPlan: searchPlan,
      signal,
    });
    timings.evaluator = Date.now() - tEval;

    let refined = false;
    if (!evaluation.sufficient && evaluation.refined_plan) {
      refined = true;
      onProgress?.({ phase: 'stage', stage: 'search-2' });
      const tSearch2 = Date.now();
      const round2 = await executeSearchPlan(evaluation.refined_plan, { onProgress, signal });
      timings.search2 = Date.now() - tSearch2;
      for (const k of Object.keys(round2)) {
        if (round2[k]) searchResults[k] = round2[k];
      }
    }

    onProgress?.({ phase: 'stage', stage: 'resolver' });
    onProgress?.({ phase: 'writing' });
    const teamKnowledge = await getKnowledge().catch(() => null);
    const feedbackContext = await buildFeedbackContext(rawQuery);

    const resolverArgs = {
      cleanedQuestion: interp.cleaned_question,
      searchResults,
      teamKnowledge,
      feedbackContext,
      signal,
    };

    const tResolver = Date.now();
    let answer;
    try {
      answer = await runResolver(resolverArgs);
    } catch (err1) {
      const transient = err1.status >= 500 || err1.name === 'AbortError' || err1.code === 'ECONNRESET' || err1.parseFailure === true;
      if (!transient || signal.aborted) throw err1;
      console.warn('[pipeline] Resolver first attempt failed, retrying:', err1.message);
      answer = await runResolver(resolverArgs);
    }
    timings.resolver = Date.now() - tResolver;

    stripRetiredAndNonModelFields(answer);

    // Close the clarification loop: allowClarify only gated Intake, but a
    // resolver must never re-ask on a capped follow-up. Strip any clarifying
    // residue (already deleted) and coerce missing required fields to escalate.
    if (!allowClarify) {
      applyCappedFallback(answer);
    }

    if (customerWasMentioned(interp)) {
      onProgress?.({ phase: 'stage', stage: 'reply' });
      const tReply = Date.now();
      const reply = await runReply({
        cleanedQuestion: interp.cleaned_question,
        resolver: answer,
        searchResults,
        signal,
      });
      timings.reply = Date.now() - tReply;
      if (typeof reply?.customer_message === 'string' && reply.customer_message.trim()) {
        answer.customer_message = reply.customer_message;
      }
    }

    // Parity with the legacy path (query.js): attach fetched KB refs so the
    // "📚 Knowledge Base" links show deterministically even if the answerer omits
    // them, and auto-save new KB articles to the team knowledge file — the new
    // pipeline otherwise silently stopped growing the KB after the flag flip.
    if (searchResults.kb?.refs?.length > 0) {
      if (!(answer.kb_refs?.length)) answer.kb_refs = searchResults.kb.refs;
      const integration = answer.integration_type || 'General';
      for (const ref of searchResults.kb.refs) {
        appendKbArticle(integration, ref.url, ref.title, ref.snippet ?? '').catch((err) => {
          console.warn('[pipeline] KB auto-save failed for', ref.url, ':', err.message);
        });
      }
    }

    answer._cleanedQuestion = interp.cleaned_question;
    const stageStr = Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(' ');
    console.info(`[pipeline] ok refined=${refined} ${stageStr} total=${Date.now() - t0}ms`);
    return answer;
  } catch (err) {
    if (signal.aborted) {
      console.error(`[pipeline] aborted after ${Date.now() - t0}ms (60s hard cap)`);
      err.pipelineTimedOut = true;
    }
    throw err;
  } finally {
    clearTimeout(overallTimer);
  }
}
