#!/usr/bin/env node
// Jev against the held-out judged set (#8478): the go/no-go for replacing the relay
// labeller. The arms, thresholds and verdict are frozen in scripts/lib/jev-heldout.mjs.
//
//   node scripts/eval-jev-heldout.mjs                                   # score the captured runs, offline, free
//   node --env-file=.env.local scripts/eval-jev-heldout.mjs --run jev-1 --freeze-sha <sha>   # first paid run
//   node --env-file=.env.local scripts/eval-jev-heldout.mjs --run jev-2  # a further paid run
//   ... --fixture <judged set> --capture <capture file>                 # other paths
//
// A paid run asks Jev about every held-out Latin title twice (production's level
// request, then the Noul request) and appends the raw answers to the capture. Scoring
// reads only a capture whose question set matches the frozen one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_MODEL } from '../shared/jev-classify.js';
import {
  ARMS, PRIMARY_ARM, QUESTION_SET_SHA, RELAY_ARM, RELAY_RUNS, SLICES,
  askJev, latinRows, readCapture, scoreArms, verdict,
} from './lib/jev-heldout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONCURRENCY = 6;
const USD_PER_M_INPUT = 0.042;

const fail = (message) => { console.error(message); process.exit(2); };
const VALUE_FLAGS = ['fixture', 'capture', 'run', 'freeze-sha'];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, '');
  if (!argv[i].startsWith('--') || !VALUE_FLAGS.includes(name)) fail(`unknown argument ${argv[i]}`);
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
}
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
const runName = arg('run');
const freezeSha = arg('freeze-sha');
const apiKey = (process.env.TYPESAFE_API_KEY || '').trim();
if (runName && !apiKey) fail('--run needs TYPESAFE_API_KEY (try node --env-file=.env.local)');
if (freezeSha && !/^[0-9a-f]{40}$/.test(freezeSha)) fail('--freeze-sha must be a full commit SHA');

const FIXTURE = resolve(root, arg('fixture') ?? 'tests/fixtures/classify-judged-headlines-heldout.json');
const CAPTURE = resolve(root, arg('capture') ?? 'tests/fixtures/jev-heldout-runs.json');
if (!existsSync(FIXTURE)) fail(`--fixture not found: ${FIXTURE}`);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const titles = latinRows(fixture.rows).map((r) => r.title);
const capture = existsSync(CAPTURE) ? readCapture(CAPTURE, fixture.rows) : null;

if (runName) {
  if (capture?.runs[runName]) fail(`runs["${runName}"] exists in ${CAPTURE}`);
  if (!capture && !freezeSha) fail(`${CAPTURE} does not exist; the first run needs --freeze-sha <the freeze commit>`);
  const usage = { inputTokens: 0, failedRequests: 0 };
  const answers = new Array(titles.length).fill(null);
  let next = 0;
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < titles.length) {
      const i = next++;
      answers[i] = await askJev(titles[i], { apiKey, usage });
    }
  }));
  const unanswered = answers.filter((a) => a === null).length;
  console.log(`${titles.length} titles, ${unanswered} unanswered, ${usage.failedRequests} failed requests, ${usage.inputTokens} input tokens ($${(usage.inputTokens * USD_PER_M_INPUT / 1e6).toFixed(4)}), ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  // A few unanswered titles are real behaviour and score as missed; many, or any failed
  // request, means the run itself broke.
  if (usage.failedRequests > 0 || unanswered > titles.length * 0.05) fail('refusing to capture; re-run');
  const out = capture ?? {
    note: 'Raw Jev answers on the held-out Latin titles of tests/fixtures/classify-judged-headlines-heldout.json, one entry per title in `titles` order; null = no valid level or Noul answer. Score with scripts/eval-jev-heldout.mjs.',
    freezeSha,
    questionSetSha: QUESTION_SET_SHA,
    model: JEV_MODEL,
    titles,
    runs: {},
  };
  out.runs[runName] = { capturedAt: new Date().toISOString(), answers, usage };
  writeFileSync(CAPTURE, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote runs["${runName}"] to ${CAPTURE}`);
  process.exit(0);
}

const relayRuns = Object.fromEntries(RELAY_RUNS.map((name) => {
  const run = fixture.runs?.[name];
  if (!run) fail(`${FIXTURE} has no runs["${name}"]`);
  return [name, Object.fromEntries(fixture.rows.map((r, i) => [r.title, run.labels[i]]).filter(([, l]) => l))];
}));
const jevRuns = Object.fromEntries(Object.entries(capture?.runs ?? {}).map(([name, run]) => [name, Object.fromEntries(titles.map((t, i) => [t, run.answers[i]]))]));
const scores = scoreArms(fixture.rows, jevRuns, relayRuns);

const relayMeta = RELAY_RUNS.map((n) => `${n} ${fixture.runs[n].model} prompt ${fixture.runs[n].promptSha}`).join('; ');
console.log(`relay: ${relayMeta}`);
console.log(`jev: ${JEV_MODEL}, questions ${QUESTION_SET_SHA}, freeze ${capture?.freezeSha ?? 'none'}`);
console.log(`Latin titles ${titles.length} of ${fixture.rows.length}\n`);
const cols = ['arm', 'run', 'slice', 'alerts', 'caught', 'missed', 'false', 'unlabelled', 'precision', 'recall'];
const table = [cols];
for (const arm of [RELAY_ARM, ...ARMS.map((a) => a.name)]) {
  for (const [run, bySlice] of Object.entries(scores[arm])) {
    for (const slice of SLICES) {
      const s = bySlice[slice];
      table.push([arm === PRIMARY_ARM ? `${arm}*` : arm, run, slice, s.alertLevel, s.alertLevel - s.missed, s.missed, s.falseAlerts, s.unlabelled, s.precisionPct ?? '-', s.recallPct ?? '-'].map(String));
    }
  }
}
const widths = cols.map((_, c) => Math.max(...table.map((r) => r[c].length)));
for (const r of table) console.log(r.map((v, c) => v.padEnd(widths[c])).join('  ').trimEnd());

if (!capture || Object.keys(capture.runs).length === 0) {
  console.log(`\nno Jev capture at ${CAPTURE}; no verdict`);
  process.exit(0);
}
const v = verdict(scores);
console.log(`\nVERDICT ${v.arm}: ${v.pass ? 'GO' : 'NO-GO'}`);
for (const slice of SLICES) console.log(`  ${slice}: ${v.slices[slice].pass ? 'pass' : v.slices[slice].reasons.join('; ')}`);
