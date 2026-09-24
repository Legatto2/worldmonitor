// Jev on the held-out judged set (#8478): the frozen arms, the go/no-go, and the pure
// scoring behind scripts/eval-jev-heldout.mjs.
//
// FROZEN. The Noul questions and thresholds are the ones measured on 2026-09-18 in
// session 820214a2-d7bf-4b03-8c28-01e6f216435a: questions from its v2-collect.mjs
// (transcript line 2085, 13:55Z), rule from line 3352. The held-out titles were judged
// after that. No value in this block changes once a Jev answer on the held-out set
// exists; tests/jev-heldout-freeze.test.mjs pins every one.
import { buildJevRequest, hasNonLatinLetters } from '../../shared/jev-classify.js';
import { isAlertLevel, promptSha, scoreAlertLabels } from './classify-eval.mjs';

const noul = (instructions, t, f) => ({ type: 'noul', instructions, criteria: { true: t, false: f } });

export const NOUL_QUESTIONS = {
  commentary: noul(
    'Is `headline` an opinion piece, editorial, column, analysis, explainer, interview, retrospective, review, listicle or how-to guide, rather than a news report that something happened?',
    'Opinion, analysis or explainer. Examples: "Guardian view on the ceasefire", "Why the dollar keeps falling", "How to secure your router".',
    'A report that an event occurred. Examples: "Iran closes Strait of Hormuz", "At least 16 killed in mosque bombing".'),
  worsening: noul(
    'Does `headline` describe a situation getting worse, rather than improving, easing, receding, being contained or being resolved?',
    'Escalation, spread, a new attack, a collapse, rising deaths, a new restriction.',
    'Gains, recovery, passing its peak, slowing, aid arriving, a blockade lifted, an agreement reached, no change.'),
  violence: noul(
    'Does `headline` report armed violence or a deliberate attack that has actually taken place: a military strike, bombing, shooting, armed clash, or terrorist attack?',
    'An attack or strike that occurred.',
    'No violence occurred: threats, warnings, plans, sanctions, protests, accidents, disease, weather.'),
};

export const THRESHOLDS = { pAlert: 0.7, worsening: 0.2, violence: 0.5, commentary: 0.5 };

// answer: { l, levelConf, pAlert, noul: { worsening, violence, commentary } }
const v1 = (a) => isAlertLevel(a.l) && a.pAlert >= THRESHOLDS.pAlert;
// Veto only when the story is easing AND reports no violence, or is commentary.
const veto = (a) => v1(a)
  && !(a.noul.worsening < THRESHOLDS.worsening && a.noul.violence < THRESHOLDS.violence)
  && a.noul.commentary < THRESHOLDS.commentary;

export const ARMS = [
  { name: 'jev-argmax', primary: false, alert: (a) => isAlertLevel(a.l) },
  { name: 'jev-v1', primary: false, alert: v1 },
  { name: 'jev-veto', primary: true, alert: veto },
];
export const PRIMARY_ARM = 'jev-veto';
export const RELAY_ARM = 'relay';
export const RELAY_RUNS = ['relay-after', 'relay-after-rerun'];
export const SLICES = ['full', 'clearCut'];

export const QUESTION_SET_SHA = promptSha(JSON.stringify({
  level: buildJevRequest([''], { levelOnly: true }).questions,
  noul: NOUL_QUESTIONS,
}));

// Exact caught/flagged, not the rounded precisionPct: two fractions a tenth of a point
// apart can round to the same value and read as a tie.
const precision = (s) => {
  const flagged = s.alertLevel - s.missed + s.falseAlerts;
  return flagged ? (s.alertLevel - s.missed) / flagged : null;
};

// scores: { [arm]: { [run]: { full, clearCut } } }, each a scoreAlertLabels result.
// The primary arm passes only if, on every slice, its worst run's precision is above the
// relay's best run and its worst run misses no more alerts than the relay's worst run.
export function verdict(scores) {
  const slices = {};
  for (const slice of SLICES) {
    const jev = Object.values(scores[PRIMARY_ARM] ?? {}).map((r) => r[slice]);
    const relay = Object.values(scores[RELAY_ARM] ?? {}).map((r) => r[slice]);
    const reasons = [];
    if (!jev.length || !relay.length) {
      slices[slice] = { pass: false, reasons: [`needs at least one ${PRIMARY_ARM} run and one ${RELAY_ARM} run`] };
      continue;
    }
    const jevPrecision = jev.map(precision);
    const relayPrecision = relay.map(precision);
    const jevWorstPrecision = jevPrecision.includes(null) ? null : Math.min(...jevPrecision);
    const relayBestPrecision = Math.max(...relayPrecision.filter((p) => p !== null), 0);
    const jevWorstMissed = Math.max(...jev.map((s) => s.missed));
    const relayWorstMissed = Math.max(...relay.map((s) => s.missed));
    if (jevWorstPrecision === null) reasons.push(`a ${PRIMARY_ARM} run flagged no alert`);
    else if (!(jevWorstPrecision > relayBestPrecision)) reasons.push(`worst ${PRIMARY_ARM} precision ${pct(jevWorstPrecision)} is not above best ${RELAY_ARM} ${pct(relayBestPrecision)}`);
    if (jevWorstMissed > relayWorstMissed) reasons.push(`worst ${PRIMARY_ARM} run missed ${jevWorstMissed}, worst ${RELAY_ARM} run ${relayWorstMissed}`);
    slices[slice] = { pass: reasons.length === 0, jevWorstPrecision, relayBestPrecision, jevWorstMissed, relayWorstMissed, reasons };
  }
  return { arm: PRIMARY_ARM, pass: SLICES.every((s) => slices[s].pass), slices };
}

const pct = (p) => `${(100 * p).toFixed(1)}%`;

// Production keeps non-Latin titles off Jev, so every arm is scored without them.
export const latinRows = (rows) => rows.filter((r) => !hasNonLatinLetters(r.title));

// Mapped onto levels so scoreAlertLabels reads them unchanged; only its alert fields
// mean anything for a Jev arm. An unanswered title is unlabelled, so a real alert
// there is missed, as in production.
export const armLabels = (arm, answersByTitle) => Object.fromEntries(
  Object.entries(answersByTitle).map(([title, a]) => [title, a ? (arm.alert(a) ? 'high' : 'info') : null]),
);

// jevRuns: { [run]: { [title]: JevAnswer | null } }; relayRuns: { [run]: { [title]: level | null } }.
export function scoreArms(rows, jevRuns, relayRuns) {
  const full = latinRows(rows);
  const clearCut = full.filter((r) => !r.borderline);
  const bySlice = (labels) => ({ full: scoreAlertLabels(full, labels), clearCut: scoreAlertLabels(clearCut, labels) });
  const perRun = (runs, toLabels) => Object.fromEntries(Object.entries(runs).map(([run, x]) => [run, bySlice(toLabels(x))]));
  return {
    [RELAY_ARM]: perRun(relayRuns, (labels) => labels),
    ...Object.fromEntries(ARMS.map((arm) => [arm.name, perRun(jevRuns, (answers) => armLabels(arm, answers))])),
  };
}
