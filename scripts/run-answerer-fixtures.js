import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAnswerer } from '../src/claude/answerer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, '..', 'test', 'fixtures', 'answerer-queries.json');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function check(label, ok, detail) {
  const mark = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const line = `    ${mark} ${label}`;
  if (ok) return { line, pass: 1, fail: 0 };
  return { line: `${line}\n        ${C.dim}${detail}${C.reset}`, pass: 0, fail: 1 };
}

function verifyFixture(actual, expected) {
  const results = [];

  if (Array.isArray(expected.required_fields)) {
    for (const field of expected.required_fields) {
      results.push(check(
        `has "${field}"`,
        actual[field] !== undefined && actual[field] !== null,
        `actual: ${field} is ${JSON.stringify(actual[field])}`,
      ));
    }
  }

  if (Array.isArray(expected.confidence_in)) {
    results.push(check(
      `confidence ∈ [${expected.confidence_in.join(', ')}]`,
      expected.confidence_in.includes(actual.confidence),
      `actual confidence: ${JSON.stringify(actual.confidence)}`,
    ));
  }

  if (expected.agent_steps_non_empty) {
    results.push(check(
      'agent_steps is non-empty',
      Array.isArray(actual.agent_steps) && actual.agent_steps.length > 0,
      `actual agent_steps length: ${actual.agent_steps?.length ?? 'undefined'}`,
    ));
  }

  if (expected.escalate_should_be_false) {
    results.push(check(
      'escalate_decision.should_escalate === false',
      actual.escalate_decision?.should_escalate === false,
      `actual escalate_decision: ${JSON.stringify(actual.escalate_decision)}`,
    ));
  }

  if (expected.customer_message_non_empty) {
    results.push(check(
      'customer_message is non-empty',
      typeof actual.customer_message === 'string' && actual.customer_message.trim().length > 0,
      `actual customer_message: ${JSON.stringify(actual.customer_message)}`,
    ));
  }

  if (expected.integration_type_contains) {
    const needle = expected.integration_type_contains.toLowerCase();
    const hay = String(actual.integration_type ?? '').toLowerCase();
    results.push(check(
      `integration_type contains "${expected.integration_type_contains}"`,
      hay.includes(needle),
      `actual integration_type: ${JSON.stringify(actual.integration_type)}`,
    ));
  }

  if (expected.confidence_or_escalation) {
    const isLowConf = actual.confidence === 'low';
    const shouldEscalate = actual.escalate_decision?.should_escalate === true;
    results.push(check(
      'confidence is low OR escalate_decision.should_escalate is true',
      isLowConf || shouldEscalate,
      `actual confidence: ${JSON.stringify(actual.confidence)}, escalate: ${JSON.stringify(actual.escalate_decision)}`,
    ));
  }

  if (expected.clarifying_or_full_with_escalation) {
    const isClarifying = typeof actual.clarifying_question === 'string' && actual.clarifying_question.trim().length > 0;
    const isLowConfFull = actual.confidence === 'low';
    const shouldEscalateFull = actual.escalate_decision?.should_escalate === true;
    results.push(check(
      'emitted clarifying_question OR full response with low confidence / escalation',
      isClarifying || isLowConfFull || shouldEscalateFull,
      `actual: clarifying_question=${JSON.stringify(actual.clarifying_question)}, confidence=${JSON.stringify(actual.confidence)}, escalate=${JSON.stringify(actual.escalate_decision)}`,
    ));
  }

  return results;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`${C.red}ANTHROPIC_API_KEY not set. Add it to .env or export it before running this script.${C.reset}`);
    process.exit(2);
  }

  const raw = await readFile(FIXTURES_PATH, 'utf-8');
  const { fixtures } = JSON.parse(raw);

  console.log(`${C.bold}Answerer golden-fixture run${C.reset}  ${C.dim}(${fixtures.length} scenarios against real Sonnet 4.6)${C.reset}\n`);
  console.log(`${C.dim}Note: Sonnet costs more than Haiku — this run is ~$0.05–0.20 in API credits.${C.reset}\n`);

  let totalPass = 0;
  let totalFail = 0;
  let totalFixturesClean = 0;

  for (const fx of fixtures) {
    console.log(`${C.cyan}● ${fx.id}${C.reset}  ${C.dim}${fx.description}${C.reset}`);
    const t0 = Date.now();
    let actual;
    try {
      actual = await runAnswerer(fx.input);
    } catch (err) {
      console.log(`    ${C.red}✗ answerer threw: ${err.message}${C.reset}\n`);
      totalFail++;
      continue;
    }
    const ms = Date.now() - t0;
    const results = verifyFixture(actual, fx.expected);
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => r.fail).length;
    totalPass += passed;
    totalFail += failed;
    if (failed === 0) totalFixturesClean++;

    for (const r of results) console.log(r.line);
    console.log(`    ${C.dim}${passed}/${results.length} checks · ${ms}ms · confidence=${actual.confidence} · steps=${actual.agent_steps?.length ?? 0}${C.reset}`);
    if (failed > 0) {
      console.log(`    ${C.yellow}actual key fields:${C.reset}`);
      const summary = {
        issue_title: actual.issue_title,
        integration_type: actual.integration_type,
        confidence: actual.confidence,
        agent_steps_count: actual.agent_steps?.length,
        escalate_decision: actual.escalate_decision,
        customer_message: typeof actual.customer_message === 'string' ? actual.customer_message.slice(0, 200) : actual.customer_message,
      };
      console.log(JSON.stringify(summary, null, 2).split('\n').map(l => '      ' + l).join('\n'));
    }
    console.log();
  }

  const total = totalPass + totalFail;
  console.log(`${'─'.repeat(60)}`);
  console.log(`${C.bold}${totalFixturesClean}/${fixtures.length} fixtures fully clean${C.reset}  ·  ${totalPass}/${total} assertions passed`);
  if (totalFail > 0) {
    console.log(`${C.yellow}${totalFail} assertion(s) failed — review actual outputs above and decide whether the Answerer prompts need tightening before flipping NEW_PIPELINE=true.${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}All fixtures pass — Answerer looks healthy.${C.reset}`);
}

main().catch(err => { console.error(err); process.exit(2); });
