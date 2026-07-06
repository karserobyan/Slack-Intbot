const ALLOWED_LINK_HOSTS = new Set([
  'servicetitan.slack.com',
  'servicetitan.atlassian.net',
  'help.servicetitan.com',
]);

export function escapeMrkdwn(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function safeSlackLink(url, label) {
  const safeLabel = escapeMrkdwn(label);
  try {
    const parsed = new URL(String(url ?? ''));
    if (!ALLOWED_LINK_HOSTS.has(parsed.hostname)) return safeLabel;
    return `<${parsed.href}|${safeLabel}>`;
  } catch {
    return safeLabel;
  }
}
