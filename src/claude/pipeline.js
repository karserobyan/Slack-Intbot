import { runInterpreter } from './interpreter.js';
import { executeSearchPlan } from './search-executor.js';
import { runEvaluator } from './evaluator.js';
import { runAnswerer } from './answerer.js';
import { getKnowledge } from '../slack/knowledge.js';
import { getRelevantFeedback } from '../slack/feedback.js';

const HARD_CAP_MS = 60000;

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

export async function runPipeline({ rawQuery, role, agentName = null, threadHistory = [], onProgress, allowClarify = true }) {
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

    onProgress?.({ phase: 'stage', stage: 'answerer' });
    onProgress?.({ phase: 'writing' });
    const teamKnowledge = await getKnowledge().catch(() => null);
    const feedbackContext = await buildFeedbackContext(rawQuery);

    const answererArgs = {
      cleanedQuestion: interp.cleaned_question,
      searchResults,
      role,
      teamKnowledge,
      feedbackContext,
      agentName,
      signal,
    };

    const tAnswer = Date.now();
    let answer;
    try {
      answer = await runAnswerer(answererArgs);
    } catch (err1) {
      const transient = err1.status >= 500 || err1.name === 'AbortError' || err1.code === 'ECONNRESET' || err1.parseFailure === true;
      if (!transient || signal.aborted) throw err1;
      console.warn('[pipeline] Answerer first attempt failed, retrying:', err1.message);
      answer = await runAnswerer(answererArgs);
    }
    timings.answerer = Date.now() - tAnswer;

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
