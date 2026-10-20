export const UNGROUNDED_DIAGNOSIS = 'Root cause unclear — no direct match found. Escalate for investigation.';
export const UNGROUNDED_STEP = "I searched but couldn't find specific information about this integration or issue. Hand it to the channel that owns this kind of issue.";

const COMMON_KNOWLEDGE = `
Zapier: Enable Zapier API access on ST backend for the tenant.
Angi Leads: Check booking provider IDs, job type mapping under Settings > Integrations > Marketing Integrations > Angi.
Reserve with Google: Check Actions Center, verify account matching status.
ServiceChannel: Check attachment settings, verify API credentials.
Thumbtack: For redirect loop, clear cache and cookies, try incognito.
Procore: Check cost code mappings for job cost export failures.
Chat-to-Text: Verify embed code placement, check SMS number setup.
`;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'been', 'was', 'were',
  'are', 'not', 'but', 'you', 'your', 'our', 'their', 'they', 'them', 'into', 'onto',
  'about', 'after', 'before', 'would', 'could', 'should', 'there', 'which', 'while',
  'also', 'only', 'just', 'than', 'then', 'such', 'other', 'some', 'more', 'most',
  'very', 'each', 'both', 'same', 'does', 'did', 'its', 'who', 'what', 'when', 'where',
  'why', 'how', 'can', 'may', 'all', 'any', 'out',
]);

const BOILERPLATE = new Set([
  'according', 'confluence', 'page', 'pages', 'thread', 'threads', 'jira',
  'guide', 'article', 'articles', 'documentation', 'source', 'sources',
  'slack', 'ticket', 'issue', 'help', 'center',
]);

function words(text) {
  return String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function contentWords(text) {
  return words(text).filter((word) => word.length >= 3 && !STOP.has(word) && !BOILERPLATE.has(word));
}

function covers(text, evidence) {
  const needed = contentWords(text);
  if (!needed.length) return false;
  const hits = needed.filter((word) => evidence.has(word));
  if (needed.length <= 4) return hits.length >= Math.ceil(needed.length * 0.6);
  const distinctiveHits = hits.filter((word) => word.length >= 5).length;
  if (distinctiveHits >= 2 && hits.length >= Math.ceil(needed.length * 0.34)) return true;
  return hits.length >= Math.ceil(needed.length * 0.4);
}

function hedges(text) {
  return /\b(likely|probably)\b|may be|could be/i.test(String(text ?? ''));
}

export function evidenceWords(searchResults, teamKnowledge, threadHistory = []) {
  const chunks = [COMMON_KNOWLEDGE];
  if (teamKnowledge) chunks.push(teamKnowledge);
  for (const turn of threadHistory ?? []) chunks.push(turn?.content);
  for (const key of ['kb', 'confluence', 'jira', 'slack']) {
    const block = searchResults?.[key];
    if (!block) continue;
    if (block.text) chunks.push(block.text);
    for (const ref of block.refs ?? []) {
      chunks.push(ref?.title, ref?.excerpt, ref?.snippet);
    }
  }
  return new Set(words(chunks.filter(Boolean).join('\n')));
}

export function answerIsGrounded(answer, knownWords) {
  if (hedges(answer?.diagnosis)) return false;
  return covers(answer?.diagnosis, knownWords);
}

export function applyGrounding(answer, knownWords) {
  if (!answerIsGrounded(answer, knownWords)) {
    answer.confidence = 'low';
    answer.diagnosis = UNGROUNDED_DIAGNOSIS;
    answer.steps = [{ num: 1, title: 'Hand off the question', detail: UNGROUNDED_STEP, tag: 'escalate' }];
    answer.involvement = {
      needed: true,
      who: 'engineering',
      reason: UNGROUNDED_DIAGNOSIS,
      channel: null,
    };
    return true;
  }
  const steps = Array.isArray(answer.steps) ? answer.steps : [];
  const kept = steps.filter((step) => covers(`${step?.title ?? ''} ${step?.detail ?? ''}`, knownWords));
  if (kept.length !== steps.length) {
    answer.steps = kept.map((step, index) => ({ ...step, num: index + 1 }));
  }
  return false;
}
