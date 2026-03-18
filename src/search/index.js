import { extractKeywords, searchSlackChannels } from './slack-search.js';
import { searchConfluence } from './confluence-search.js';

/**
 * Formats search results into a [CONTEXT] block for Claude.
 * Returns an empty string if both result arrays are empty.
 * @param {object} params
 * @param {Array<{channel: string, text: string, score: number, ts: string}>} params.slackResults
 * @param {Array<{title: string, excerpt: string, url: string}>} params.confluenceResults
 * @returns {string}
 */
export function formatContext({ slackResults, confluenceResults }) {
  const parts = [];

  if (slackResults.length > 0) {
    parts.push('## Relevant Slack threads found:');
    slackResults.forEach((r) => {
      parts.push(`- [#${r.channel}] ${r.text}`);
    });
  }

  if (confluenceResults.length > 0) {
    parts.push('\n## Relevant Confluence pages found:');
    confluenceResults.forEach((p) => {
      parts.push(`- **${p.title}**: ${p.excerpt} (${p.url})`);
    });
  }

  return parts.length > 0 ? `\n\n[CONTEXT]\n${parts.join('\n')}\n[/CONTEXT]` : '';
}

/**
 * Runs Slack and Confluence searches in parallel for a given query.
 * Fails gracefully — a failed search returns empty results, not an error.
 * @param {string} query
 * @returns {Promise<string>} Formatted context block, or empty string if nothing found
 */
export async function gatherContext(query) {
  const keywords = extractKeywords(query);

  const [slackResult, confluenceResult] = await Promise.allSettled([
    searchSlackChannels(query),
    searchConfluence(keywords),
  ]);

  const slackResults = slackResult.status === 'fulfilled' ? slackResult.value : [];
  const confluenceResults = confluenceResult.status === 'fulfilled' ? confluenceResult.value : [];

  if (slackResult.status === 'rejected') {
    console.warn('[search] Slack search failed:', slackResult.reason?.message);
  }
  if (confluenceResult.status === 'rejected') {
    console.warn('[search] Confluence search failed:', confluenceResult.reason?.message);
  }

  return formatContext({ slackResults, confluenceResults });
}
