/**
 * Team knowledge base loader.
 *
 * Reads data/knowledge.md and injects it into Claude prompts as a
 * [TEAM KNOWLEDGE] block. Cached for 5 minutes so edits take effect
 * quickly without requiring a bot restart.
 *
 * Returns null if the file does not exist — bot works normally without it.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const KNOWLEDGE_FILE = join(process.cwd(), 'data', 'knowledge.md');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SIZE_BYTES = 20 * 1024;    // 20KB cap — warn if exceeded

let _cache = null;
let _cacheTime = 0;

/**
 * Returns the contents of the team knowledge file, or null if not found.
 * Caches for 5 minutes. Logs a warning if file exceeds 20KB.
 *
 * @returns {Promise<string|null>}
 */
export async function getKnowledge() {
  const now = Date.now();
  if (_cache !== null && now - _cacheTime < CACHE_TTL_MS) return _cache;

  try {
    const content = await readFile(KNOWLEDGE_FILE, 'utf-8');
    if (Buffer.byteLength(content, 'utf-8') > MAX_SIZE_BYTES) {
      console.warn('[knowledge] data/knowledge.md exceeds 20KB — consider splitting or trimming to keep token costs low.');
    }
    _cache = content.trim() || null;
    _cacheTime = now;
    return _cache;
  } catch {
    // File not found or unreadable — not an error, just skip injection
    _cache = null;
    _cacheTime = now;
    return null;
  }
}

/**
 * Clears the in-memory cache — useful for testing.
 */
export function clearKnowledgeCache() {
  _cache = null;
  _cacheTime = 0;
}
