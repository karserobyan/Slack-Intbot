const GUIDE_INTENTS = new Set(['how-to', 'integration-setup']);
const ANSWER_INTENTS = new Set(['policy', 'troubleshooting']);

// A terminator only ends a sentence before a capital or a Slack link, so "e.g. the" stays whole.
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z<])/;

export function layoutFor(intent) {
  if (GUIDE_INTENTS.has(intent)) return 'guide';
  if (ANSWER_INTENTS.has(intent)) return 'answer';
  return 'legacy';
}

function linkedRef(ref) {
  if (typeof ref?.title !== 'string' || !ref.title) return null;
  if (typeof ref.url !== 'string' || !ref.url) return null;
  return { title: ref.title, url: ref.url };
}

export function pickGuide(data) {
  const list = (refs) => (Array.isArray(refs) ? refs : []);
  const kb = list(data?.kb_refs).map(linkedRef).filter(Boolean);
  const confluence = list(data?.atlassian_refs)
    .filter((ref) => ref?.type === 'confluence')
    .map(linkedRef)
    .filter(Boolean);

  const diagnosis = typeof data?.diagnosis === 'string' ? data.diagnosis.toLowerCase() : '';
  const quoted = [...kb, ...confluence].find((ref) => diagnosis.includes(ref.title.toLowerCase()));

  return quoted ?? kb[0] ?? confluence[0] ?? null;
}

function splitSentences(text) {
  return text.split(SENTENCE_BOUNDARY);
}

export function trimToSentences(text, maxSentences, { keepLast = false, keep = null } = {}) {
  if (typeof text !== 'string' || !text) return '';
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return text;
  const tail = keep ? sentences.slice(maxSentences - 1).find(keep) : undefined;
  const kept = keepLast
    ? [...sentences.slice(0, maxSentences - 1), tail ?? sentences[sentences.length - 1]]
    : sentences.slice(0, maxSentences);
  return kept.join(' ');
}

export function oneLineStep(step, max = 140) {
  const detail = typeof step?.detail === 'string' ? step.detail.trim() : '';
  if (!detail) return '';
  const first = splitSentences(detail)[0];
  if (first.length <= max) return first;
  let cut = first.slice(0, max - 1);
  const open = cut.lastIndexOf('<');
  if (open > cut.lastIndexOf('>')) cut = cut.slice(0, open).trimEnd();
  return `${cut}…`;
}
