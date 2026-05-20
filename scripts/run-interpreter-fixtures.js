import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInterpreter } from '../src/claude/interpreter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, '..', 'test', 'fixtures', 'interpreter-queries.json');

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

  if (expected.intent) {
    results.push(check(
      `intent === "${expected.intent}"`,
      actual.intent === expected.intent,
      `actual: ${JSON.stringify(actual.intent)}`,
    ));
  }

  if (expected.question_confidence) {
    results.push(check(
      `question_confidence === "${expected.question_confidence}"`,
      actual.question_confidence === expected.question_confidence,
      `actual: ${JSON.stringify(actual.question_confidence)}`,
    ));
  }

  if (expected.entities?.integration) {
    results.push(check(
      `entities.integration === "${expected.entities.integration}"`,
      actual.entities?.integration === expected.entities.integration,
      `actual: ${JSON.stringify(actual.entities?.integration)}`,
    ));
  }

  if (expected.entities?.symptom_contains) {
    const needle = expected.entities.symptom_contains.toLowerCase();
    const hay = String(actual.entities?.symptom ?? '').toLowerCase();
    results.push(check(
      `entities.symptom contains "${expected.entities.symptom_contains}"`,
      hay.includes(needle),
      `actual symptom: ${JSON.stringify(actual.entities?.symptom)}`,
    ));
  }

  if (expected.entities?.error_code_contains) {
    const needle = expected.entities.error_code_contains.toLowerCase();
    const hay = String(actual.entities?.error_code ?? '').toLowerCase();
    results.push(check(
      `entities.error_code contains "${expected.entities.error_code_contains}"`,
      hay.includes(needle),
      `actual error_code: ${JSON.stringify(actual.entities?.error_code)}`,
    ));
  }

  if (expected.entities?.tenant_id_contains) {
    const needle = expected.entities.tenant_id_contains.toLowerCase();
    const hay = String(actual.entities?.tenant_id ?? '').toLowerCase();
    results.push(check(
      `entities.tenant_id contains "${expected.entities.tenant_id_contains}"`,
      hay.includes(needle),
      `actual tenant_id: ${JSON.stringify(actual.entities?.tenant_id)}`,
    ));
  }

  if (expected.clarifying_question_not_null) {
    results.push(check(
      'clarifying_question is non-empty',
      typeof actual.clarifying_question === 'string' && actual.clarifying_question.length > 0,
      `actual: ${JSON.stringify(actual.clarifying_question)}`,
    ));
  }

  if (expected.search_plan_is_null) {
    results.push(check(
      'search_plan is null',
      actual.search_plan === null,
      `actual search_plan: ${JSON.stringify(actual.search_plan)}`,
    ));
  }

  if (Array.isArray(expected.search_plan_must_include)) {
    const sources = (actual.search_plan?.sources ?? []).map(s => s.name);
    for (const required of expected.search_plan_must_include) {
      results.push(check(
        `search_plan.sources includes "${required}"`,
        sources.includes(required),
        `actual sources: ${JSON.stringify(sources)}`,
      ));
    }
  }

  if (Array.isArray(expected.cleaned_question_must_omit)) {
    const cleaned = String(actual.cleaned_question ?? '');
    for (const forbidden of expected.cleaned_question_must_omit) {
      results.push(check(
        `cleaned_question omits "${forbidden}"`,
        !cleaned.toLowerCase().includes(forbidden.toLowerCase()),
        `actual cleaned_question: ${JSON.stringify(cleaned)}`,
      ));
    }
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

  console.log(`${C.bold}Interpreter golden-fixture run${C.reset}  ${C.dim}(${fixtures.length} queries against real Haiku 4.5)${C.reset}\n`);

  let totalPass = 0;
  let totalFail = 0;
  let totalFixturesClean = 0;

  for (const fx of fixtures) {
    console.log(`${C.cyan}● ${fx.id}${C.reset}  ${C.dim}${fx.input.slice(0, 80).replace(/\n/g, ' ')}${fx.input.length > 80 ? '…' : ''}${C.dim}${C.reset}`);
    const t0 = Date.now();
    let actual;
    try {
      actual = await runInterpreter(fx.input);
    } catch (err) {
      console.log(`    ${C.red}✗ interpreter threw: ${err.message}${C.reset}\n`);
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
    console.log(`    ${C.dim}${passed}/${results.length} checks · ${ms}ms${C.reset}`);
    if (failed > 0) {
      console.log(`    ${C.yellow}actual cleaned_question:${C.reset} ${JSON.stringify(actual.cleaned_question)}`);
      console.log(`    ${C.yellow}actual full output:${C.reset}\n${JSON.stringify(actual, null, 2).split('\n').map(l => '      ' + l).join('\n')}`);
    }
    console.log();
  }

  const total = totalPass + totalFail;
  console.log(`${'─'.repeat(60)}`);
  console.log(`${C.bold}${totalFixturesClean}/${fixtures.length} fixtures fully clean${C.reset}  ·  ${totalPass}/${total} assertions passed`);
  if (totalFail > 0) {
    console.log(`${C.yellow}${totalFail} assertion(s) failed — review the actual outputs above and decide whether the Interpreter prompt needs tightening before flipping NEW_PIPELINE=true.${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}All fixtures pass — Interpreter looks healthy. Safe to proceed with NEW_PIPELINE=true in a staging environment.${C.reset}`);
}

main().catch(err => { console.error(err); process.exit(2); });
