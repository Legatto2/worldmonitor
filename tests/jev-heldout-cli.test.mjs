import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_MODEL } from '../shared/jev-classify.js';
import { QUESTION_SET_SHA } from '../scripts/lib/jev-heldout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'jev-heldout-cli-'));
const file = (name, data) => { const p = join(dir, name); writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); return p; };

const rows = [
  { title: 'Missile strike hits port', judge: 'critical', borderline: false },
  { title: 'Ebola outbreak passes its peak', judge: 'medium', borderline: false },
  { title: 'Border clashes flare again', judge: 'high', borderline: true },
  { title: 'Talks resume in Geneva', judge: 'low', borderline: false },
  { title: '新华网 bulletin', judge: 'high', borderline: false },
];
const relayRun = { path: 'relay', model: 'relay-model', promptSha: 'abc', labels: ['critical', 'high', 'medium', 'low', 'high'] };
const fixture = file('fixture.json', { rows, runs: { 'relay-after': relayRun, 'relay-after-rerun': relayRun } });
const titles = rows.slice(0, 4).map((r) => r.title);
const answer = (l, pAlert, worsening, violence, commentary) => ({ l, levelConf: 0.9, pAlert, noul: { worsening, violence, commentary } });
const jevAnswers = [answer('critical', 0.95, 0.9, 0.9, 0), answer('high', 0.9, 0.05, 0.1, 0), answer('high', 0.8, 0.9, 0.9, 0), answer('low', 0.1, 0.1, 0, 0)];
const capture = file('capture.json', {
  note: 'synthetic', freezeSha: 'f'.repeat(40), questionSetSha: QUESTION_SET_SHA, model: JEV_MODEL, titles,
  runs: { 'jev-1': { capturedAt: '2026-09-24T00:00:00Z', answers: jevAnswers, usage: { inputTokens: 1, failedRequests: 0 } } },
});

const marker = join(dir, 'fetched');
const preload = file('stub-fetch.mjs', `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(marker)}, 'x');
  const q = JSON.parse(init.body).questions;
  const body = q.l0
    ? { answers: { l0: { type: 'choice', choice: 'high', confidence: 0.9, probabilities: { critical: 0.25, high: 0.5 } } }, usage: { input_tokens: 600 } }
    : { answers: { commentary: { noul: 0.1 }, worsening: { noul: 0.9 }, violence: { noul: 0.8 } }, usage: { input_tokens: 400 } };
  return new Response(JSON.stringify(body), { status: 200 });
};
`);

const cli = (args, env = {}) => spawnSync(process.execPath, ['--import', preload, 'scripts/eval-jev-heldout.mjs', ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', ...env },
});

describe('eval-jev-heldout', () => {
  it('scores a capture offline and prints the verdict', () => {
    const r = cli(['--fixture', fixture, '--capture', capture]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`questions ${QUESTION_SET_SHA}, freeze f{40}`));
    assert.match(r.stdout, /Latin titles 4 of 5/);
    assert.match(r.stdout, /^jev-veto\* +jev-1 +full +2 +2 +0 +0 +0 +100 +100$/m);
    assert.match(r.stdout, /^jev-v1 +jev-1 +full +2 +2 +0 +1 +0 +66\.7 +100$/m);
    assert.match(r.stdout, /^relay +relay-after +full +2 +1 +1 +1 +0 +50 +50$/m);
    assert.match(r.stdout, /^relay +relay-after +clearCut +1 +1 +0 +1 +0 +50 +100$/m);
    assert.match(r.stdout, /VERDICT jev-veto: GO\n {2}full: pass\n {2}clearCut: pass/);
    assert.equal(existsSync(marker), false);
  });

  it('prints relay scores and no verdict without a capture', () => {
    const r = cli(['--fixture', fixture, '--capture', join(dir, 'none.json')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no Jev capture at .*none\.json; no verdict/);
    assert.doesNotMatch(r.stdout, /VERDICT/);
  });

  it('refuses an unknown flag and a flag without a value', () => {
    assert.equal(cli(['--fixture', fixture, '--force']).status, 2);
    assert.equal(cli(['--run']).status, 2);
  });

  it('exits 2 before any request: --run without a key, an existing run, a first run without --freeze-sha', () => {
    const noKey = cli(['--fixture', fixture, '--capture', capture, '--run', 'jev-2']);
    assert.equal(noKey.status, 2);
    assert.match(noKey.stderr, /TYPESAFE_API_KEY/);
    assert.equal(cli(['--fixture', fixture, '--capture', capture, '--run', 'jev-1'], { TYPESAFE_API_KEY: 'k' }).status, 2);
    assert.equal(cli(['--fixture', fixture, '--capture', join(dir, 'new.json'), '--run', 'jev-1'], { TYPESAFE_API_KEY: 'k' }).status, 2);
    assert.equal(existsSync(marker), false);
  });

  it('writes a run a later offline score reads', () => {
    const out = join(dir, 'fresh.json');
    const r = cli(['--fixture', fixture, '--capture', out, '--run', 'jev-1', '--freeze-sha', 'a'.repeat(40)], { TYPESAFE_API_KEY: 'k' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /4 titles, 0 unanswered, 0 failed requests, 4000 input tokens/);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual([written.freezeSha, written.questionSetSha, written.model, written.titles], ['a'.repeat(40), QUESTION_SET_SHA, JEV_MODEL, titles]);
    assert.deepEqual(written.runs['jev-1'].answers[0], answer('high', 0.75, 0.9, 0.8, 0.1));
    assert.equal(cli(['--fixture', fixture, '--capture', out]).status, 0);
  });
});
