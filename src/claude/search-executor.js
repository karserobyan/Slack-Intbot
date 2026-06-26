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
export async function executeSearchPlan(plan, { onProgress, signal } = {}) {
  const sources = plan?.sources ?? [];

  // Per-source timing: search1 dominates pipeline latency, so log which source
  // is slow (kb vs confluence vs jira vs slack) instead of one opaque aggregate.
  const timings = [];

  const tasks = sources.map(s => {
    const fn = SOURCE_FUNCS[s.name];
    if (!fn) return Promise.resolve({ name: s.name, value: null });
    const t0 = Date.now();
    onProgress?.({ phase: 'tool_start', tool: s.name });
    return Promise.resolve(fn(s.query, { signal }))
      .then(v => {
        timings.push(`${s.name}=${Date.now() - t0}ms(refs=${v?.refs?.length ?? 0})`);
        onProgress?.({ phase: 'tool_done', tool: s.name, count: v?.refs?.length ?? null });
        return { name: s.name, value: v, priority: s.priority };
      })
      .catch(() => {
        timings.push(`${s.name}=${Date.now() - t0}ms(err)`);
        onProgress?.({ phase: 'tool_done', tool: s.name, count: 0 });
        return { name: s.name, value: null };
      });
  });

  const settled = await Promise.allSettled(tasks);

  if (timings.length > 0) console.info(`[search] ${timings.join(' ')}`);

  const result = { kb: null, confluence: null, jira: null, slack: null };
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value?.value) {
      result[r.value.name] = { ...r.value.value, priority: r.value.priority };
    }
  }
  return result;
}
