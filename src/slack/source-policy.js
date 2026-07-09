const SENSITIVE_CHANNEL_RE = /^#?(backend|eng|engineering|incident|private|security|sec|ops|pricing|contract|legal)(-|_|$)/i;
const SENSITIVE_TEXT_RE = /\b(incident|outage|pii|ssn|contract|pricing|secret|token|backend-only|internal escalation)\b/i;

export function classifySourceRef(ref) {
  const next = { ...ref };
  if (next.sensitive === true) return next;

  const url = String(next.url ?? '');
  if (url.includes('help.servicetitan.com')) return next;

  const channel = String(next.channel ?? '');
  const title = String(next.title ?? '');
  const type = String(next.type ?? '');

  if (SENSITIVE_CHANNEL_RE.test(channel) || SENSITIVE_TEXT_RE.test(`${title} ${type}`)) {
    next.sensitive = true;
  }

  return next;
}

export function filterRefsForRole(refs = [], role = 'csa') {
  const classified = refs.map(classifySourceRef);
  if (role === 'specialist') return classified;
  return classified.filter((ref) => ref.sensitive !== true);
}
