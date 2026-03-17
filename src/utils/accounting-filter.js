/**
 * Detects whether a query relates to accounting integrations,
 * which are out of scope for this team.
 */

// Each entry is a RegExp with word boundaries to prevent substring false positives.
// e.g. "xero" must not match "zero", "netsuite" must not match "netsuitething".
const ACCOUNTING_PATTERNS = [
  /\bquickbooks\b/i,
  /\bquick\s+books\b/i,
  /\bsage\s+intacct\b/i,
  /\bsage\s+intact\b/i,   // common misspelling
  /\bnetsuite\b/i,
  /\bnet\s+suite\b/i,
  /\bxero\b/i,
  /\bviewpoint\s+vista\b/i,
  /\baccounts\s+payable\b/i,
  /\baccounts\s+receivable\b/i,
  /\bgl\s+accounts\b/i,
  /\bgeneral\s+ledger\b/i,
  /\baccounting\s+integration\b/i,
  /\baccounting\s+sync\b/i,
  /\bchart\s+of\s+accounts\b/i,
  /\bjournal\s+entr(y|ies)\b/i,
  /\bqbo\b/i,   // QuickBooks Online
  /\bqbd\b/i,   // QuickBooks Desktop
];

/**
 * Returns true if the query contains accounting-related patterns.
 * Uses word-boundary regex matching to avoid substring false positives.
 * @param {string} text
 * @returns {boolean}
 */
export function isAccountingTopic(text) {
  return ACCOUNTING_PATTERNS.some((re) => re.test(text));
}

export const ACCOUNTING_REDIRECT_CHANNEL = '#ask-partner-enabled-accounting-integrations';
