/**
 * Knowledge base writer.
 * Appends entries to data/knowledge.md with deduplication.
 *
 * Entry types:
 *   [kb, YYYY-MM-DD]   — auto-saved KB article from kb-search (Anthropic web_search)
 *   [auto, YYYY-MM-DD] — moderator-approved bot response nomination
 *
 * All writes serialised via _writeQueue to prevent concurrent write races.
 * Slack alert sent to the configured feedback channel on every successful write.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { clearKnowledgeCache } from './knowledge.js';
import { getFeedbackChannelId } from '../utils/feedback-channel.js';

const DATA_DIR = join(process.cwd(), 'data');
export const DEFAULT_KB_FILE = join(DATA_DIR, 'knowledge.md');

let _writeQueue = Promise.resolve();
let _failWritesForTest = false;
let _defaultFileOverrideForTest = null;

export function _setKnowledgeWriterFailureForTest(shouldFail) {
  _failWritesForTest = shouldFail;
}

export function _setKnowledgeWriterDefaultFileForTest(filePath) {
  _defaultFileOverrideForTest = filePath;
}

function defaultKbFile() {
  return _defaultFileOverrideForTest ?? DEFAULT_KB_FILE;
}

async function readKb(filePath = DEFAULT_KB_FILE) {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return ''; // first run — no KB yet
    // Unreadable for any other reason: abort rather than treat as empty, which
    // would let the next append rewrite a near-empty file and wipe the KB.
    console.error(`[knowledge-writer] Failed to read ${filePath} (${err.code ?? err.name}): ${err.message}. Aborting write to avoid clobbering.`);
    throw err;
  }
}

// Atomic write (temp + rename) so a crash mid-write can't truncate knowledge.md.
async function writeKb(content, filePath = DEFAULT_KB_FILE) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, filePath);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function insertUnderSection(content, integration, line) {
  const sectionHeader = `## ${integration}`;
  const sectionIdx = content.indexOf(`\n${sectionHeader}`);

  if (sectionIdx !== -1) {
    const afterHeader = sectionIdx + sectionHeader.length + 1;
    const nextSectionIdx = content.indexOf('\n## ', afterHeader);
    const insertAt = nextSectionIdx !== -1 ? nextSectionIdx : content.length;
    const before = content.slice(0, insertAt).trimEnd();
    const after = content.slice(insertAt);
    return `${before}\n${line}${after}`;
  }

  const trimmed = content.trimEnd();
  return `${trimmed}\n\n${sectionHeader}\n\n${line}\n`;
}

/**
 * Returns true if the given URL already appears anywhere in the KB file.
 */
export async function hasKbUrl(url, filePath = DEFAULT_KB_FILE) {
  return (await readKb(filePath)).includes(url);
}

/**
 * Returns true if an entry with the given issue title already exists
 * under the integration's section.
 */
export async function hasIssueTitle(integration, title, filePath = DEFAULT_KB_FILE) {
  const content = await readKb(filePath);
  const sectionRegex = new RegExp(`## ${escapeRegex(integration)}\\s*([\\s\\S]*?)(?=\\n## |$)`);
  const match = content.match(sectionRegex);
  return match ? match[1].includes(title) : false;
}

/**
 * Appends a KB article entry. Deduplicates by URL.
 * @param {string} integration
 * @param {string} url
 * @param {string} title
 * @param {string} snippet
 * @param {string} [filePath]
 * @param {object} [client] - Slack WebClient for alert
 * @returns {Promise<boolean>} true if written, false if skipped
 */
export async function appendKbArticle(integration, url, title, snippet, filePath = defaultKbFile(), client = null) {
  return new Promise((resolve) => {
    _writeQueue = _writeQueue
      .then(async () => {
        if (_failWritesForTest) throw new Error('knowledge writer failure injected for test');
        if (await hasKbUrl(url, filePath)) { resolve(false); return; }
        const line = `- [kb, ${today()}] ${title} — ${url} — ${snippet}`;
        await writeKb(insertUnderSection(await readKb(filePath), integration, line), filePath);
        resolve(true);
        clearKnowledgeCache();
        if (client && getFeedbackChannelId()) {
          await client.chat.postMessage({
            channel: getFeedbackChannelId(),
            text: `📚 KB article auto-saved to knowledge.md: ${integration} — ${title}`,
          }).catch((err) => console.warn('[knowledge-writer] Slack alert failed:', err.message));
        }
      })
      .catch((err) => {
        console.error('[knowledge-writer] appendKbArticle failed:', err.message);
        resolve(false);
        if (client && getFeedbackChannelId()) {
          client.chat.postMessage({
            channel: getFeedbackChannelId(),
            text: `⚠️ knowledge.md write failed: ${integration} — ${title}. ${err.message}`,
          }).catch(() => {});
        }
      });
  });
}

/**
 * Appends an approved bot-response entry. Deduplicates by issue title within section.
 * @param {string} integration
 * @param {string} issueTitle
 * @param {string[]} steps
 * @param {string[]} refs
 * @param {string} [filePath]
 * @param {object} [client] - Slack WebClient for alert
 * @returns {Promise<boolean>} true if written, false if skipped
 */
export async function appendBotResponse(integration, issueTitle, steps, refs, filePath = defaultKbFile(), client = null) {
  return new Promise((resolve) => {
    _writeQueue = _writeQueue
      .then(async () => {
        if (_failWritesForTest) throw new Error('knowledge writer failure injected for test');
        if (await hasIssueTitle(integration, issueTitle, filePath)) { resolve(false); return; }
        const refsText = refs.length > 0 ? ` Confirmed in ${refs.join(' + ')}.` : '';
        const line = `- [auto, ${today()}] ${issueTitle}: ${steps.join('; ')}.${refsText}`;
        await writeKb(insertUnderSection(await readKb(filePath), integration, line), filePath);
        resolve(true);
        clearKnowledgeCache();
        if (client && getFeedbackChannelId()) {
          await client.chat.postMessage({
            channel: getFeedbackChannelId(),
            text: `✅ Knowledge entry approved and saved: ${integration} — ${issueTitle}`,
          }).catch((err) => console.warn('[knowledge-writer] Slack alert failed:', err.message));
        }
      })
      .catch((err) => {
        console.error('[knowledge-writer] appendBotResponse failed:', err.message);
        resolve(false);
        if (client && getFeedbackChannelId()) {
          client.chat.postMessage({
            channel: getFeedbackChannelId(),
            text: `⚠️ knowledge.md write failed: ${integration} — ${issueTitle}. ${err.message}`,
          }).catch(() => {});
        }
      });
  });
}
