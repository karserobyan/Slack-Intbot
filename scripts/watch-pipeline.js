#!/usr/bin/env node

import { createInterface } from 'node:readline';

const WINDOW = parseInt(process.env.WATCH_WINDOW ?? '50', 10);
const REFRESH_MS = 2000;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const recent = [];

const OK_RE = /\[pipeline\] ok refined=(\w+)((?: \w+=\d+ms)+) total=(\d+)ms/;
const SHORTCUT_RE = /\[pipeline\] shortcut=clarifying interpreter=(\d+)ms total=(\d+)ms/;
const ABORT_RE = /\[pipeline\] aborted after (\d+)ms/;

function record(entry) {
  recent.push(entry);
  if (recent.length > WINDOW) recent.shift();
}

function parseLine(line) {
  const ok = line.match(OK_RE);
  if (ok) {
    const stages = {};
    for (const m of ok[2].matchAll(/(\w+)=(\d+)ms/g)) {
      stages[m[1]] = parseInt(m[2], 10);
    }
    return { kind: 'ok', refined: ok[1] === 'true', stages, total: parseInt(ok[3], 10) };
  }
  const sc = line.match(SHORTCUT_RE);
  if (sc) return { kind: 'shortcut', stages: { interpreter: parseInt(sc[1], 10) }, total: parseInt(sc[2], 10) };
  const ab = line.match(ABORT_RE);
  if (ab) return { kind: 'abort', total: parseInt(ab[1], 10) };
  return null;
}

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function fmt(ms) {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function summary() {
  const n = recent.length;
  if (n === 0) {
    return `${C.dim}(no pipeline events yet — pipe the bot's stdout into this script)${C.reset}`;
  }

  const ok = recent.filter(e => e.kind === 'ok');
  const shortcuts = recent.filter(e => e.kind === 'shortcut');
  const aborts = recent.filter(e => e.kind === 'abort');

  const totals = recent.map(e => e.total);
  const p50 = percentile(totals, 0.5);
  const p95 = percentile(totals, 0.95);
  const maxT = Math.max(...totals);

  const refinedCount = ok.filter(e => e.refined).length;
  const refinedRate = ok.length > 0 ? Math.round((refinedCount / ok.length) * 100) : 0;
  const shortcutRate = Math.round((shortcuts.length / n) * 100);
  const abortRate = Math.round((aborts.length / n) * 100);

  const stageAvg = (name) => {
    const vals = ok.filter(e => name in e.stages).map(e => e.stages[name]);
    if (vals.length === 0) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  };

  const interpAvg = stageAvg('interpreter');
  const search1Avg = stageAvg('search1');
  const evalAvg = stageAvg('evaluator');
  const search2Avg = stageAvg('search2');
  const answerAvg = stageAvg('answerer');

  const abortStyle = aborts.length > 0 ? C.red : C.dim;
  const shortcutStyle = C.cyan;

  return [
    `${C.bold}Pipeline window${C.reset} ${C.dim}(last ${n} of ${WINDOW})${C.reset}`,
    '',
    `${C.bold}Totals${C.reset}   p50=${fmt(p50)}  p95=${fmt(p95)}  max=${fmt(maxT)}`,
    `${C.bold}Counts${C.reset}   full-answers=${C.green}${ok.length}${C.reset}  shortcuts=${shortcutStyle}${shortcuts.length}${C.reset} (${shortcutRate}%)  aborts=${abortStyle}${aborts.length}${C.reset} (${abortRate}%)`,
    `${C.bold}Refine${C.reset}   ${refinedCount}/${ok.length} full-answers (${refinedRate}%)`,
    '',
    `${C.bold}Avg stage timings (full-answer paths only)${C.reset}`,
    `  interpreter: ${fmt(interpAvg)}`,
    `  search-1:    ${fmt(search1Avg)}`,
    `  evaluator:   ${fmt(evalAvg)}`,
    `  search-2:    ${fmt(search2Avg)} ${C.dim}(only when refinement triggers)${C.reset}`,
    `  answerer:    ${fmt(answerAvg)}`,
    aborts.length > 0
      ? `\n${C.red}⚠ ${aborts.length} pipeline(s) hit the 60s budget — investigate.${C.reset}`
      : '',
  ].filter(Boolean).join('\n');
}

function render() {
  // Clear screen + move cursor home
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(`${C.dim}Pipeline log watcher  ·  ${new Date().toLocaleTimeString()}  ·  refreshes every ${REFRESH_MS / 1000}s  ·  Ctrl-C to exit${C.reset}\n`);
  console.log(summary());
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const parsed = parseLine(line);
  if (parsed) record(parsed);
});

setInterval(render, REFRESH_MS);
render();
