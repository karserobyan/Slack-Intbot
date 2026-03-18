/**
 * Interactive CLI simulator for IntegrationsBot.
 * Runs the full pipeline without Slack — type queries and see formatted output.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node cli.js
 *   # or set it in .env
 */

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { isAccountingTopic, ACCOUNTING_REDIRECT_CHANNEL } from './src/utils/accounting-filter.js';
import { queryWithContext } from './src/claude/query.js';
import { getCached, setCached, cacheStats } from './src/slack/cache.js';
import { saveFeedback, getRelevantFeedback, getAllFeedback } from './src/slack/feedback.js';

// ── ANSI colors ──────────────────────────────────────────────────────────────
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const WHITE = '\x1b[37m';
const BG_RED = '\x1b[41m';
const BG_GREEN = '\x1b[42m';
const BG_YELLOW = '\x1b[43m';
const BG_BLUE = '\x1b[44m';

const TAG_COLORS = {
  action: `${BG_BLUE}${WHITE} action ${RESET}`,
  backend: `${BG_YELLOW}${WHITE} backend ${RESET}`,
  verify: `${BG_GREEN}${WHITE} verify ${RESET}`,
  escalate: `${BG_RED}${WHITE} escalate ${RESET}`,
};

// ── Formatters ───────────────────────────────────────────────────────────────

function printHeader(text) {
  console.log(`\n${BOLD}${'═'.repeat(60)}${RESET}`);
  console.log(`${BOLD}  ${text}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(60)}${RESET}`);
}

function printSection(title) {
  console.log(`\n${BOLD}${CYAN}── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}${RESET}`);
}

function formatResponse(data) {
  // Header
  printHeader(`🔌 ${data.issue_title}`);
  console.log(`${DIM}Integration:${RESET} ${MAGENTA}${data.integration_type}${RESET}    ${DIM}Sources:${RESET} ${(data.sources_used ?? []).join(', ')}`);

  // Section 1 — Agent Troubleshooting
  printSection('🔧 Agent Troubleshooting (internal only)');
  const steps = data.agent_steps ?? [];
  if (steps.length === 0) {
    console.log(`  ${DIM}No troubleshooting steps generated.${RESET}`);
  }
  for (const step of steps) {
    const tag = TAG_COLORS[step.tag] ?? `[${step.tag}]`;
    console.log(`\n  ${BOLD}${step.num}.${RESET} ${BOLD}${step.title}${RESET}  ${tag}`);
    // Wrap detail text
    const lines = step.detail.split('\n');
    for (const line of lines) {
      console.log(`     ${line}`);
    }
  }

  // Section 2 — Customer Email Draft
  if (data.customer_email) {
    const email = data.customer_email;
    printSection('✉️  Customer Email Draft');
    console.log(`\n  ${BOLD}Subject:${RESET} ${email.subject}\n`);
    console.log(`${YELLOW}${'─'.repeat(60)}${RESET}`);
    const bodyLines = email.body.split('\n');
    for (const line of bodyLines) {
      console.log(`  ${line}`);
    }
    console.log(`${YELLOW}${'─'.repeat(60)}${RESET}`);

    if (email.kb_links && email.kb_links.length > 0) {
      console.log(`\n  ${BOLD}📚 KB Links:${RESET}`);
      for (const link of email.kb_links) {
        console.log(`     • ${link.label}: ${BLUE}${link.url}${RESET}`);
      }
    }
  }

  // Sources
  const slackRefs = data.slack_refs ?? [];
  const atlassianRefs = data.atlassian_refs ?? [];
  if (slackRefs.length > 0 || atlassianRefs.length > 0) {
    printSection('📎 Sources Referenced');
    for (const ref of slackRefs) {
      const icon = ref.was_resolved ? '✅' : '⏳';
      console.log(`  ${icon} ${BOLD}#${ref.channel}${RESET}${ref.author ? ` (${ref.author})` : ''} — ${ref.issue_summary}`);
      if (ref.resolution) console.log(`     ${DIM}Resolution: ${ref.resolution}${RESET}`);
    }
    for (const ref of atlassianRefs) {
      const icon = ref.type === 'jira' ? '🎟️ ' : '📄';
      console.log(`  ${icon} ${BOLD}${ref.title}${RESET}${ref.status ? ` [${ref.status}]` : ''} — ${ref.summary}`);
      if (ref.url) console.log(`     ${DIM}${ref.url}${RESET}`);
    }
  }

  console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
  const stats = cacheStats();
  console.log(`${DIM}IntegrationsBot • Cache: ${stats.size}/${stats.maxEntries} entries${RESET}`);
  console.log(`${DIM}Type ${RESET}${RED}/wrong${RESET}${DIM} to flag this answer as incorrect${RESET}\n`);
}

/** Holds the last response so /wrong can reference it */
let lastQuery = null;
let lastResult = null;

function formatAccountingRedirect(query) {
  printHeader('⚠️  Accounting Integration — Out of Scope');
  console.log(`\n  This question is about an ${BOLD}accounting integration${RESET}.`);
  console.log(`  These are handled by a different team.\n`);
  console.log(`  ${BOLD}Please redirect to:${RESET} ${GREEN}${ACCOUNTING_REDIRECT_CHANNEL}${RESET}\n`);
  console.log(`  ${DIM}Original query: "${query.slice(0, 120)}${query.length > 120 ? '…' : ''}"${RESET}\n`);
}

// ── Main loop ────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(`${RED}${BOLD}Missing ANTHROPIC_API_KEY${RESET}`);
  console.log(`Set it in .env or run: ${CYAN}ANTHROPIC_API_KEY=sk-ant-... node cli.js${RESET}\n`);
  process.exit(1);
}

console.log(`${BOLD}${GREEN}IntegrationsBot — CLI Simulator${RESET}`);
console.log(`${DIM}Type a customer issue or agent question. Type "quit" to exit.${RESET}`);
console.log(`${DIM}Examples:${RESET}`);
console.log(`  ${CYAN}Customer's Zapier integration shows no API access on their tenant${RESET}`);
console.log(`  ${CYAN}Angi leads stopped syncing after tenant migration${RESET}`);
console.log(`  ${CYAN}How do I set up QuickBooks? ${DIM}(-> accounting redirect)${RESET}`);
console.log();
console.log(`${DIM}Commands:${RESET}`);
console.log(`  ${CYAN}/wrong${RESET}     ${DIM}— flag the last answer as incorrect and provide correction${RESET}`);
console.log(`  ${CYAN}/feedback${RESET}   ${DIM}— view all saved feedback entries${RESET}`);
console.log(`  ${CYAN}quit${RESET}       ${DIM}— exit${RESET}`);
console.log();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${BOLD}${GREEN}agent>${RESET} `,
});

rl.prompt();

rl.on('line', async (input) => {
  const query = input.trim();

  if (!query) {
    rl.prompt();
    return;
  }

  if (query.toLowerCase() === 'quit' || query.toLowerCase() === 'exit') {
    console.log(`${DIM}Goodbye!${RESET}`);
    process.exit(0);
  }

  // ── /wrong command — flag the last response as incorrect ────────────────
  if (query.toLowerCase() === '/wrong') {
    if (!lastResult) {
      console.log(`\n${RED}No previous answer to flag. Ask a question first.${RESET}\n`);
      rl.prompt();
      return;
    }

    console.log(`\n${BOLD}${RED}👎 Flagging as wrong:${RESET} ${lastResult.issue_title}`);
    console.log(`${DIM}What type of problem?${RESET}`);
    console.log(`  ${BOLD}1${RESET} — Completely wrong answer`);
    console.log(`  ${BOLD}2${RESET} — Partially correct but missing key steps`);
    console.log(`  ${BOLD}3${RESET} — Outdated information`);
    console.log(`  ${BOLD}4${RESET} — Wrong integration identified`);

    const feedbackTypes = ['wrong_answer', 'partially_correct', 'outdated', 'wrong_integration'];

    rl.question(`\n${YELLOW}Choose (1-4):${RESET} `, (typeAnswer) => {
      const idx = parseInt(typeAnswer, 10) - 1;
      const feedbackType = feedbackTypes[idx] ?? 'wrong_answer';

      rl.question(`${YELLOW}What is the correct answer?${RESET}\n> `, async (correction) => {
        if (!correction.trim()) {
          console.log(`${DIM}Feedback cancelled.${RESET}\n`);
          rl.prompt();
          return;
        }

        const record = await saveFeedback({
          query: lastQuery,
          issueTitle: lastResult.issue_title,
          integrationType: lastResult.integration_type,
          feedbackType,
          correction: correction.trim(),
          agentId: 'cli-user',
          agentName: 'CLI Tester',
        });

        console.log(`\n${GREEN}✅ Feedback saved!${RESET} (${record.id})`);
        console.log(`${DIM}The bot will use this correction for future similar queries.${RESET}\n`);
        rl.prompt();
      });
    });
    return;
  }

  // ── /feedback command — view all saved feedback ─────────────────────────
  if (query.toLowerCase() === '/feedback') {
    const all = await getAllFeedback();
    if (all.length === 0) {
      console.log(`\n${DIM}No feedback recorded yet. Use /wrong after a response to flag it.${RESET}\n`);
    } else {
      printHeader(`📝 Saved Feedback (${all.length} entries)`);
      for (const entry of all.slice(-10)) { // show last 10
        console.log(`\n  ${BOLD}${entry.id}${RESET} ${DIM}(${entry.timestamp})${RESET}`);
        console.log(`  ${DIM}Query:${RESET} ${entry.query.slice(0, 80)}`);
        console.log(`  ${DIM}Type:${RESET} ${RED}${entry.feedbackType}${RESET}`);
        console.log(`  ${DIM}Correction:${RESET} ${GREEN}${entry.correction.slice(0, 120)}${RESET}`);
      }
      console.log();
    }
    rl.prompt();
    return;
  }

  // 1. Accounting check
  if (isAccountingTopic(query)) {
    formatAccountingRedirect(query);
    rl.prompt();
    return;
  }

  // 2. Cache check
  const cached = getCached(query);
  if (cached) {
    console.log(`\n${DIM}(served from cache)${RESET}`);
    formatResponse(cached);
    rl.prompt();
    return;
  }

  // 3. Call Claude
  console.log(`\n${YELLOW}🔍 Searching knowledge sources… (this may take 10-30 seconds)${RESET}`);

  try {
    let dots = 0;
    const spinner = setInterval(() => {
      dots = (dots + 1) % 4;
      process.stdout.write(`\r${YELLOW}${'·'.repeat(dots + 1)}${' '.repeat(3 - dots)}${RESET}`);
    }, 500);

    // Inject past corrections for context
    let feedbackContext = '';
    const corrections = await getRelevantFeedback(query);
    if (corrections.length > 0) {
      const lines = corrections.map(
        (c) => `- Query: "${c.query}" -> Bot was wrong (${c.feedbackType}). Correct answer: ${c.correction}`,
      );
      feedbackContext = `\n\nIMPORTANT - Past corrections from agents:\n${lines.join('\n')}`;
      console.log(`${DIM}(injecting ${corrections.length} past correction(s) as context)${RESET}`);
    }

    const result = await queryWithContext(query + feedbackContext);

    clearInterval(spinner);
    process.stdout.write('\r    \r'); // clear spinner

    // Double-check accounting via Claude's response
    if (result.is_accounting_topic) {
      formatAccountingRedirect(query);
    } else {
      lastQuery = query;
      lastResult = result;
      setCached(query, result);
      formatResponse(result);
    }
  } catch (err) {
    console.log(`\n${RED}${BOLD}Error:${RESET} ${err.message}`);
    if (err.message.includes('401') || err.message.includes('authentication')) {
      console.log(`${DIM}Check that your ANTHROPIC_API_KEY is valid.${RESET}`);
    }
    console.log();
  }

  rl.prompt();
});

rl.on('close', () => {
  console.log(`\n${DIM}Goodbye!${RESET}`);
  process.exit(0);
});
