// The Jev held-out arms are frozen before any held-out answer exists (#8478). If a pin
// here reds, a frozen value moved: that is a new experiment and needs a new held-out set.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMS, NOUL_QUESTIONS, PRIMARY_ARM, QUESTION_SET_SHA, RELAY_RUNS, THRESHOLDS, verdict,
} from '../scripts/lib/jev-heldout.mjs';

const score = (caught, falseAlerts, missed) => ({ alertLevel: caught + missed, missed, falseAlerts });
const scores = (jevRuns, relayRuns) => ({
  'jev-veto': Object.fromEntries(jevRuns.map((r, i) => [`jev-${i}`, r])),
  relay: Object.fromEntries(relayRuns.map((r, i) => [`relay-${i}`, r])),
});
const both = (s) => ({ full: s, clearCut: s });

describe('frozen question set', () => {
  it('pins the question set, thresholds, arms and relay runs', () => {
    assert.equal(QUESTION_SET_SHA, 'e81030c97b184942');
    assert.deepEqual(THRESHOLDS, { pAlert: 0.7, worsening: 0.2, violence: 0.5, commentary: 0.5 });
    assert.deepEqual(Object.keys(NOUL_QUESTIONS), ['commentary', 'worsening', 'violence']);
    assert.deepEqual(ARMS.map((a) => [a.name, a.primary]), [['jev-argmax', false], ['jev-v1', false], ['jev-veto', true]]);
    assert.equal(PRIMARY_ARM, 'jev-veto');
    assert.deepEqual(RELAY_RUNS, ['relay-after', 'relay-after-rerun']);
  });

  it('applies the measured rule at its boundaries', () => {
    const arm = Object.fromEntries(ARMS.map((a) => [a.name, a.alert]));
    const answer = (l, pAlert, worsening, violence, commentary) => ({ l, levelConf: 0.9, pAlert, noul: { worsening, violence, commentary } });
    assert.equal(arm['jev-argmax'](answer('high', 0.4, 0.9, 0.9, 0)), true);
    assert.equal(arm['jev-v1'](answer('high', 0.69, 0.9, 0.9, 0)), false);
    assert.equal(arm['jev-v1'](answer('critical', 0.7, 0.9, 0.9, 0)), true);
    assert.equal(arm['jev-v1'](answer('medium', 0.9, 0.9, 0.9, 0)), false);
    assert.equal(arm['jev-veto'](answer('high', 0.9, 0.2, 0, 0)), true);
    assert.equal(arm['jev-veto'](answer('high', 0.9, 0.19, 0.49, 0)), false);
    assert.equal(arm['jev-veto'](answer('high', 0.9, 0.19, 0.5, 0)), true);
    assert.equal(arm['jev-veto'](answer('high', 0.9, 0.9, 0.9, 0.5)), false);
    assert.equal(arm['jev-veto'](answer('high', 0.9, 0.9, 0.9, 0.49)), true);
  });
});

describe('verdict', () => {
  it('passes when every Jev run beats the best relay run on precision and misses no more', () => {
    const v = verdict(scores([both(score(36, 4, 3)), both(score(35, 3, 4))], [both(score(37, 6, 4)), both(score(36, 6, 5))]));
    assert.equal(v.pass, true);
    assert.equal(v.arm, 'jev-veto');
    assert.deepEqual(v.slices.full.reasons, []);
    assert.equal(v.slices.clearCut.jevWorstMissed, 4);
    assert.equal(v.slices.clearCut.relayWorstMissed, 5);
  });

  it('fails on equal precision', () => {
    const v = verdict(scores([both(score(30, 6, 3))], [both(score(35, 7, 5))]));
    assert.equal(v.pass, false);
    assert.match(v.slices.full.reasons.join(), /not above/);
  });

  it('compares exact precision, not the rounded percentage', () => {
    // 36/43 = 83.72% and 41/49 = 83.67% both round to 83.7.
    const v = verdict(scores([both(score(36, 7, 3))], [both(score(41, 8, 3))]));
    assert.equal(v.pass, true, JSON.stringify(v));
  });

  it('passes on equal misses and fails on one more', () => {
    assert.equal(verdict(scores([both(score(30, 1, 5))], [both(score(30, 6, 5))])).pass, true);
    const v = verdict(scores([both(score(30, 1, 6))], [both(score(30, 6, 5))]));
    assert.equal(v.pass, false);
    assert.match(v.slices.full.reasons.join(), /missed 6/);
  });

  it('is decided by the worst Jev run', () => {
    assert.equal(verdict(scores([both(score(36, 1, 3)), both(score(30, 6, 3))], [both(score(35, 6, 5))])).pass, false);
  });

  it('fails when either slice fails', () => {
    const good = score(36, 1, 3);
    const relay = score(35, 6, 5);
    const v = verdict(scores([{ full: good, clearCut: score(10, 2, 0) }], [{ full: relay, clearCut: score(10, 1, 0) }]));
    assert.equal(v.pass, false);
    assert.equal(v.slices.full.pass, true);
    assert.equal(v.slices.clearCut.pass, false);
  });

  it('holds the clear-cut slice at the relay\'s 100% instead of requiring more', () => {
    const full = { jev: score(36, 3, 3), relay: score(35, 6, 4) };
    const pass = verdict(scores([{ full: full.jev, clearCut: score(26, 0, 1) }], [{ full: full.relay, clearCut: score(26, 0, 0) }, { full: full.relay, clearCut: score(25, 0, 1) }]));
    assert.equal(pass.pass, true, JSON.stringify(pass));
    assert.equal(pass.slices.full.rule, 'beat');
    assert.equal(pass.slices.clearCut.rule, 'hold');
    const oneFalse = verdict(scores([{ full: full.jev, clearCut: score(26, 1, 0) }], [{ full: full.relay, clearCut: score(26, 0, 0) }]));
    assert.equal(oneFalse.pass, false);
    assert.match(oneFalse.slices.clearCut.reasons.join(), /below worst relay 100\.0%/);
  });

  it('holds against the worst relay run on the clear-cut slice', () => {
    const v = verdict(scores([both(score(36, 3, 3))], [{ full: score(35, 6, 4), clearCut: score(30, 2, 3) }, { full: score(35, 6, 4), clearCut: score(30, 5, 3) }]));
    assert.equal(v.slices.clearCut.pass, true, JSON.stringify(v.slices.clearCut));
  });

  it('fails a Jev run that flagged nothing, and a missing arm', () => {
    assert.equal(verdict(scores([both(score(0, 0, 5))], [both(score(30, 6, 5))])).pass, false);
    assert.equal(verdict(scores([both(score(36, 1, 3))], [])).pass, false);
  });
});
