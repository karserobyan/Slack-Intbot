/**
 * Parses Claude's JSON response string into an object.
 * Strips any accidental markdown fences before parsing.
 * Logs the raw text at debug level always, and at error level on parse failure.
 * @param {string} text
 * @returns {object}
 */
export function parseClaudeResponse(text) {
  const fenceStripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Extract JSON object — strips any leading/trailing prose Claude adds before/after the braces
  const start = fenceStripped.indexOf('{');
  const end = fenceStripped.lastIndexOf('}');
  const stripped = (start !== -1 && end !== -1) ? fenceStripped.slice(start, end + 1) : fenceStripped;

  if (process.env.LOG_LEVEL === 'debug') {
    console.debug('[claude] Raw response (first 500 chars):', stripped.slice(0, 500));
  }

  try {
    return JSON.parse(stripped);
  } catch (err) {
    console.error('[claude] JSON parse failed. Raw response was:\n', stripped);
    throw err;
  }
}

/**
 * Converts a structured Claude result into a human-readable summary for
 * conversation history. Lets Claude reference its prior response naturally
 * instead of parsing raw JSON in follow-up turns.
 *
 * @param {object} result - Parsed Claude response object
 * @returns {string}
 */
export function summarizeResultForHistory(result) {
  if (result.is_accounting_topic) return '';

  const lines = [];

  if (result.customer_message) {
    lines.push(result.customer_message);
  }

  if (result.diagnosis) {
    lines.push(`\nDiagnosis: ${result.diagnosis}`);
  }

  const steps = result.steps ?? [];
  if (steps.length > 0) {
    lines.push('\nSteps I gave:');
    for (const step of steps) {
      const detail = (step.detail ?? '').slice(0, 300);
      lines.push(`${step.num}. ${step.title} (${step.tag}): ${detail}`);
    }
  }

  if (result.involvement) {
    const inv = result.involvement;
    if (inv.needed) {
      const channel = inv.channel ? ` in ${inv.channel}` : '';
      const who = inv.who ?? 'another team';
      lines.push(`\nInvolvement: ${who}${channel} — ${inv.reason ?? ''}`.trimEnd());
    } else {
      lines.push('\nInvolvement: case owner finishes it');
    }
  }

  if (result.confidence != null || (result.sources_used ?? []).length > 0) {
    const confidence = result.confidence ?? 'unknown';
    const sources = (result.sources_used ?? []).join(', ') || 'none';
    lines.push(`\nConfidence: ${confidence} | Sources: ${sources}`);
  }

  if (result.clarifying_question) {
    lines.push(`\nI asked the agent: "${result.clarifying_question}"`);
  }

  return lines.join('\n');
}
