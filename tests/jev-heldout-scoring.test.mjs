import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARMS, armLabels, latinRows, scoreArms, verdict } from '../scripts/lib/jev-heldout.mjs';

const answer = (l, pAlert, worsening, violence, commentary) => ({ l, levelConf: 0.9, pAlert, noul: { worsening, violence, commentary } });
const row = (title, judge, borderline = false) => ({ title, judge, borderline });

const rows = [
  row('Troops foil attacks in Borno, kill four', 'high'),
  row('Ceasefire holds as talks resume', 'high'),
  row('Ebola outbreak passes its peak', 'medium'),
  row('The Guardian view on the war', 'info'),
  row('Удар по Киеву', 'high'),
  row('Strait of Hormuz closed', 'critical'),
  row('Border clashes flare again', 'high', true),
];
const jev = {
  'Troops foil attacks in Borno, kill four': answer('high', 0.9, 0.1, 0.8, 0),
  'Ceasefire holds as talks resume': answer('high', 0.9, 0.05, 0.1, 0),
  'Ebola outbreak passes its peak': answer('high', 0.9, 0.05, 0.1, 0),
  'The Guardian view on the war': answer('critical', 0.95, 0.9, 0.9, 0.8),
  'Удар по Киеву': answer('critical', 0.95, 0.9, 0.9, 0),
  'Strait of Hormuz closed': null,
  'Border clashes flare again': answer('high', 0.5, 0.9, 0.9, 0),
};
const relay = {
  'Troops foil attacks in Borno, kill four': 'high',
  'Ceasefire holds as talks resume': 'high',
  'Ebola outbreak passes its peak': 'high',
  'The Guardian view on the war': 'info',
  'Удар по Киеву': 'high',
  'Strait of Hormuz closed': 'high',
  'Border clashes flare again': 'medium',
};
const pick = ({ alertLevel, missed, falseAlerts, unlabelledAlerts }) => ({ alertLevel, missed, falseAlerts, unlabelledAlerts });

describe('Jev held-out scoring', () => {
  it('drops non-Latin titles', () => {
    assert.deepEqual(rows.filter((r) => !latinRows(rows).includes(r)).map((r) => r.title), ['Удар по Киеву']);
  });

  it('labels each arm, keeping an unanswered title unlabelled', () => {
    const veto = ARMS.find((a) => a.name === 'jev-veto');
    const labels = armLabels(veto, jev);
    assert.equal(labels['Troops foil attacks in Borno, kill four'], 'high');
    assert.equal(labels['Ceasefire holds as talks resume'], 'info');
    assert.equal(labels['The Guardian view on the war'], 'info');
    assert.equal(labels['Strait of Hormuz closed'], null);
  });

  it('scores every arm on the Latin full and clear-cut slices', () => {
    const s = scoreArms(rows, { a: jev }, { 'relay-after': relay });
    assert.deepEqual(pick(s['jev-argmax'].a.full), { alertLevel: 4, missed: 1, falseAlerts: 2, unlabelledAlerts: 1 });
    assert.deepEqual(pick(s['jev-v1'].a.full), { alertLevel: 4, missed: 2, falseAlerts: 2, unlabelledAlerts: 1 });
    assert.deepEqual(pick(s['jev-veto'].a.full), { alertLevel: 4, missed: 3, falseAlerts: 0, unlabelledAlerts: 1 });
    assert.deepEqual(pick(s['jev-veto'].a.clearCut), { alertLevel: 3, missed: 2, falseAlerts: 0, unlabelledAlerts: 1 });
    assert.deepEqual(pick(s.relay['relay-after'].full), { alertLevel: 4, missed: 1, falseAlerts: 1, unlabelledAlerts: 0 });
    assert.deepEqual(pick(s.relay['relay-after'].clearCut), { alertLevel: 3, missed: 0, falseAlerts: 1, unlabelledAlerts: 0 });
  });

  it('feeds verdict end to end', () => {
    const v = verdict(scoreArms(rows, { a: jev, b: jev }, { 'relay-after': relay, 'relay-after-rerun': relay }));
    assert.equal(v.pass, false);
    assert.deepEqual(v.slices.full.reasons, ['worst jev-veto run missed 3, worst relay run 1']);
    assert.equal(v.slices.full.jevWorstPrecision, 1);
    assert.equal(v.slices.full.relayBestPrecision, 0.75);
  });
});
