import { searchKnowledgeBase } from './kb-search.js';
import { searchConfluence, searchJira } from './atlassian-search.js';
import { searchSlackMessages } from '../slack/search-client.js';

const SOURCE_FUNCS = {
  kb: searchKnowledgeBase,
  confluence: searchConfluence,
  jira: searchJira,
  slack: searchSlackMessages,
};

/**
 * Runs every source in the plan in parallel. Returns a map keyed by source name
 * with `{ ...result, priority }` for sources that returned data, `null` for
 * sources that were absent from the plan, errored, or returned no results.
 *
 * @param {{ sources: Array<{ name: string, priority: string, query: string }> } | null} plan
 * @returns {Promise<Record<'kb'|'confluence'|'jira'|'slack', object|null>>}
 */
export async function executeSearchPlan(plan, { onProgress } = {}) {
  const sources = plan?.sources ?? [];

  const tasks = sources.map(s => {
    const fn = SOURCE_FUNCS[s.name];
    if (!fn) return Promise.resolve({ name: s.name, value: null });
    onProgress?.({ phase: 'tool_start', tool: s.name });
    return Promise.resolve(fn(s.query))
      .then(v => {
        onProgress?.({ phase: 'tool_done', tool: s.name, count: v?.refs?.length ?? null });
        return { name: s.name, value: v, priority: s.priority };
      })
      .catch(() => {
        onProgress?.({ phase: 'tool_done', tool: s.name, count: 0 });
        return { name: s.name, value: null };
      });
  });

  const settled = await Promise.allSettled(tasks);

  const result = { kb: null, confluence: null, jira: null, slack: null };
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value?.value) {
      result[r.value.name] = { ...r.value.value, priority: r.value.priority };
    }
  }
  return result;
}
