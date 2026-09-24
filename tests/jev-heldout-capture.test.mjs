import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_ENDPOINT, JEV_MODEL, buildJevRequest } from '../shared/jev-classify.js';
import {
  NOUL_QUESTIONS, QUESTION_SET_SHA, askJev, buildNoulRequest, parseNoulAnswers, readCapture,
} from '../scripts/lib/jev-heldout.mjs';

const levelBody = { answers: { l0: { type: 'choice', choice: 'high', confidence: 0.8, probabilities: { critical: 0.25, high: 0.5, medium: 0.25 } } }, usage: { input_tokens: 600 } };
const noulBody = { answers: { commentary: { noul: 0.05 }, worsening: { noul: 0.9 }, violence: { noul: 0.7 } }, usage: { input_tokens: 400 } };
const json = (status, body) => ({ ok: status === 200, status, json: async () => body, body: { cancel: async () => {} } });

describe('Noul request and parser', () => {
  it('asks the three frozen Nouls about `headline`, sanitised like the level request', () => {
    const title = 'Line one\nline two';
    const req = buildNoulRequest(title);
    assert.equal(req.model, JEV_MODEL);
    assert.deepEqual(req.state, buildJevRequest([title], { levelOnly: true }).state);
    assert.deepEqual(req.state, { headline: 'Line one line two' });
    assert.equal(req.questions, NOUL_QUESTIONS);
    for (const q of Object.values(req.questions)) assert.match(q.instructions, /`headline`/);
  });

  it('reads every Noul as a finite number and drops the whole answer otherwise', () => {
    assert.deepEqual(parseNoulAnswers(noulBody), { commentary: 0.05, worsening: 0.9, violence: 0.7 });
    assert.equal(parseNoulAnswers({ answers: { ...noulBody.answers, violence: {} } }), null);
    assert.equal(parseNoulAnswers({ answers: { ...noulBody.answers, violence: { noul: '0.7' } } }), null);
    assert.equal(parseNoulAnswers({ answers: { ...noulBody.answers, violence: { noul: Number.NaN } } }), null);
    assert.equal(parseNoulAnswers(null), null);
  });
});

describe('askJev', () => {
  const stub = (responses) => {
    const sent = [];
    const fetchFn = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return responses.shift(); };
    return { sent, fetchFn };
  };

  it('sends the production level-only request unchanged, then the Noul request', async () => {
    const { sent, fetchFn } = stub([json(200, levelBody), json(200, noulBody)]);
    const usage = { inputTokens: 0, failedRequests: 0 };
    const answer = await askJev('Strait closed', { apiKey: 'k', fetchFn, usage });
    assert.deepEqual(sent.map((s) => s.url), [JEV_ENDPOINT, JEV_ENDPOINT]);
    assert.deepEqual(sent[0].body, buildJevRequest(['Strait closed'], { levelOnly: true }));
    assert.deepEqual(sent[1].body, JSON.parse(JSON.stringify(buildNoulRequest('Strait closed'))));
    assert.deepEqual(answer, { l: 'high', levelConf: 0.8, pAlert: 0.75, noul: { commentary: 0.05, worsening: 0.9, violence: 0.7 } });
    assert.deepEqual(usage, { inputTokens: 1000, failedRequests: 0 });
  });

  it('retries a 429 and counts a request that never succeeds as failed', async () => {
    const { sent, fetchFn } = stub([json(429, {}), json(200, levelBody), json(400, {})]);
    const usage = { inputTokens: 0, failedRequests: 0 };
    assert.equal(await askJev('t', { apiKey: 'k', fetchFn, usage, retryDelayMs: 0 }), null);
    assert.equal(sent.length, 3);
    assert.deepEqual(usage, { inputTokens: 600, failedRequests: 1 });
  });

  it('skips the Noul request when the level has no valid answer', async () => {
    const { sent, fetchFn } = stub([json(200, { answers: {} })]);
    const usage = { inputTokens: 0, failedRequests: 0 };
    assert.equal(await askJev('t', { apiKey: 'k', fetchFn, usage }), null);
    assert.equal(sent.length, 1);
    assert.equal(usage.failedRequests, 0);
  });
});

describe('readCapture', () => {
  const rows = [{ title: 'A strike', judge: 'high', borderline: false }, { title: '新华网 report', judge: 'high', borderline: false }, { title: 'B talks', judge: 'low', borderline: true }];
  const valid = { questionSetSha: QUESTION_SET_SHA, model: JEV_MODEL, titles: ['A strike', 'B talks'], runs: { a: { answers: [null, null] } } };
  const dir = mkdtempSync(join(tmpdir(), 'jev-heldout-capture-'));
  const write = (name, capture) => { const file = join(dir, name); writeFileSync(file, JSON.stringify(capture)); return file; };

  it('accepts the frozen questions, the pinned model and the Latin titles in order', () => {
    assert.deepEqual(readCapture(write('ok.json', valid), rows), valid);
  });

  it('rejects a mismatched question set, model, title list or run length', () => {
    assert.throws(() => readCapture(write('sha.json', { ...valid, questionSetSha: '0000000000000000' }), rows), /questionSetSha/);
    assert.throws(() => readCapture(write('model.json', { ...valid, model: 'jev-1.12.0' }), rows), /model/);
    assert.throws(() => readCapture(write('order.json', { ...valid, titles: ['B talks', 'A strike'] }), rows), /titles/);
    assert.throws(() => readCapture(write('nonlatin.json', { ...valid, titles: rows.map((r) => r.title) }), rows), /titles/);
    assert.throws(() => readCapture(write('short.json', { ...valid, runs: { a: { answers: [null] } } }), rows), /1 answers for 2/);
  });
});
