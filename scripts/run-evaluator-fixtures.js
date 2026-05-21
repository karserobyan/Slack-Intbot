import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runEvaluator } from '../src/claude/evaluator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = join(__dirname, '..', 'test', 'fixtures', 'evaluator-queries.json');

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

  if (expected.sufficient !== undefined) {
    results.push(check(
      `sufficient === ${expected.sufficient}`,
      actual.sufficient === expected.sufficient,
      `actual sufficient: ${JSON.stringify(actual.sufficient)} · rationale: ${JSON.stringify(actual.rationale)}`,
    ));
  }

  if (expected.refined_plan_is_null) {
    results.push(check(
      'refined_plan is null',
      actual.refined_plan === null,
      `actual refined_plan: ${JSON.stringify(actual.refined_plan)}`,
    ));
  }

  if (expected.refined_plan_has_sources) {
    const sources = actual.refined_plan?.sources;
    results.push(check(
      'refined_plan has at least one source',
      Array.isArray(sources) && sources.length > 0,
      `actual refined_plan: ${JSON.stringify(actual.refined_plan)}`,
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

  console.log(`${C.bold}Evaluator golden-fixture run${C.reset}  ${C.dim}(${fixtures.length} scenarios against real Haiku 4.5)${C.reset}\n`);

  let totalPass = 0;
  let totalFail = 0;
  let totalFixturesClean = 0;

  for (const fx of fixtures) {
    console.log(`${C.cyan}● ${fx.id}${C.reset}  ${C.dim}${fx.description}${C.reset}`);
    const t0 = Date.now();
    let actual;
    try {
      actual = await runEvaluator(fx.input);
    } catch (err) {
      console.log(`    ${C.red}✗ evaluator threw: ${err.message}${C.reset}\n`);
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
    console.log(`    ${C.dim}${passed}/${results.length} checks · ${ms}ms · rationale: ${JSON.stringify(actual.rationale)}${C.reset}`);
    if (failed > 0) {
      console.log(`    ${C.yellow}actual full output:${C.reset}\n${JSON.stringify(actual, null, 2).split('\n').map(l => '      ' + l).join('\n')}`);
    }
    console.log();
  }

  const total = totalPass + totalFail;
  console.log(`${'─'.repeat(60)}`);
  console.log(`${C.bold}${totalFixturesClean}/${fixtures.length} fixtures fully clean${C.reset}  ·  ${totalPass}/${total} assertions passed`);
  if (totalFail > 0) {
    console.log(`${C.yellow}${totalFail} assertion(s) failed — review actual outputs above and decide whether the Evaluator prompt needs tightening before flipping NEW_PIPELINE=true.${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}All fixtures pass — Evaluator looks healthy.${C.reset}`);
}

main().catch(err => { console.error(err); process.exit(2); });
