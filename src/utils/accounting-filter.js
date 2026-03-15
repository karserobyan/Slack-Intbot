/**
 * Detects whether a query relates to accounting integrations,
 * which are out of scope for this team.
 */

const ACCOUNTING_KEYWORDS = [
  'quickbooks',
  'quick books',
  'sage intacct',
  'sage intact',
  'netsuite',
  'net suite',
  'xero',
  'viewpoint vista',
  'accounts payable',
  'accounts receivable',
  'gl accounts',
  'general ledger',
  'accounting integration',
  'accounting sync',
  'chart of accounts',
  'journal entry',
  'journal entries',
  'qbo',          // QuickBooks Online abbreviation
  'qbd',          // QuickBooks Desktop abbreviation
];

/**
 * Returns true if the query contains accounting-related keywords.
 * @param {string} text
 * @returns {boolean}
 */
export function isAccountingTopic(text) {
  const lower = text.toLowerCase();
  return ACCOUNTING_KEYWORDS.some((kw) => lower.includes(kw));
}

export const ACCOUNTING_REDIRECT_CHANNEL = '#ask-partner-enabled-accounting-integrations';
