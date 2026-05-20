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

export async function runPipeline({ rawQuery, role, agentName = null, threadHistory = [], onProgress }) {
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), HARD_CAP_MS);

  try {
    onProgress?.({ phase: 'stage', stage: 'interpreter' });
    const interp = await runInterpreter(rawQuery, { threadHistory });

    if (interp.question_confidence === 'low') {
      return {
        clarifying_question: interp.clarifying_question,
        cleaned_question: interp.cleaned_question,
      };
    }

    onProgress?.({ phase: 'stage', stage: 'search-1' });
    let searchResults = await executeSearchPlan(interp.search_plan, { onProgress });

    onProgress?.({ phase: 'stage', stage: 'evaluator' });
    const evaluation = await runEvaluator({
      cleanedQuestion: interp.cleaned_question,
      searchResults,
      originalPlan: interp.search_plan,
    });

    if (!evaluation.sufficient && evaluation.refined_plan) {
      onProgress?.({ phase: 'stage', stage: 'search-2' });
      const round2 = await executeSearchPlan(evaluation.refined_plan, { onProgress });
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
    };

    let answer;
    try {
      answer = await runAnswerer(answererArgs);
    } catch (err1) {
      const transient = err1.status >= 500 || err1.name === 'AbortError' || err1.code === 'ECONNRESET';
      if (!transient) throw err1;
      console.warn('[pipeline] Answerer first attempt failed, retrying:', err1.message);
      answer = await runAnswerer(answererArgs);
    }

    answer._cleanedQuestion = interp.cleaned_question;
    return answer;
  } finally {
    clearTimeout(overallTimer);
  }
}
