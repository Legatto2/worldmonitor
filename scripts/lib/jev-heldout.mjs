// Jev on the held-out judged set (#8478): the frozen arms, the go/no-go, and the pure
// scoring behind scripts/eval-jev-heldout.mjs.
//
// FROZEN. The Noul questions and thresholds are the ones measured on 2026-09-18 in
// session 820214a2-d7bf-4b03-8c28-01e6f216435a: questions from its v2-collect.mjs
// (transcript line 2085, 13:55Z), rule from line 3352. The held-out titles were judged
// after that. No value in this block changes once a Jev answer on the held-out set
// exists; tests/jev-heldout-freeze.test.mjs pins every one.
import { readFileSync } from 'node:fs';
import {
  JEV_ENDPOINT, JEV_MODEL, buildJevRequest, hasNonLatinLetters, parseJevAnswers, sanitizeHeadline,
} from '../../shared/jev-classify.js';
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

// On the full set Jev has to beat the relay. The clear-cut slice is a guard it must hold:
// both captured relay runs are at 100% precision there, so "beat" could never pass.
const SLICE_RULE = { full: 'beat', clearCut: 'hold' };

// scores: { [arm]: { [run]: { full, clearCut } } }, each a scoreAlertLabels result.
// beat: the primary arm's worst run has higher precision than the relay's best run.
// hold: the primary arm's worst run has precision at least the relay's worst run.
// Both: the primary arm's worst run misses no more alerts than the relay's worst run.
export function verdict(scores) {
  const slices = {};
  for (const slice of SLICES) {
    const rule = SLICE_RULE[slice];
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
    const relayKnown = relayPrecision.filter((p) => p !== null);
    const relayBestPrecision = Math.max(...relayKnown, 0);
    const relayWorstPrecision = relayKnown.length ? Math.min(...relayKnown) : 0;
    const jevWorstMissed = Math.max(...jev.map((s) => s.missed));
    const relayWorstMissed = Math.max(...relay.map((s) => s.missed));
    if (jevWorstPrecision === null) reasons.push(`a ${PRIMARY_ARM} run flagged no alert`);
    else if (rule === 'beat' && !(jevWorstPrecision > relayBestPrecision)) reasons.push(`worst ${PRIMARY_ARM} precision ${pct(jevWorstPrecision)} is not above best ${RELAY_ARM} ${pct(relayBestPrecision)}`);
    else if (rule === 'hold' && jevWorstPrecision < relayWorstPrecision) reasons.push(`worst ${PRIMARY_ARM} precision ${pct(jevWorstPrecision)} is below worst ${RELAY_ARM} ${pct(relayWorstPrecision)}`);
    if (jevWorstMissed > relayWorstMissed) reasons.push(`worst ${PRIMARY_ARM} run missed ${jevWorstMissed}, worst ${RELAY_ARM} run ${relayWorstMissed}`);
    slices[slice] = {
      rule, pass: reasons.length === 0, jevWorstPrecision, relayBestPrecision, relayWorstPrecision, jevWorstMissed, relayWorstMissed, reasons,
    };
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

// The Nouls go in their own request, as they were measured; production's level request
// is sent unchanged beside it.
export const buildNoulRequest = (title, maxTextChars = 200) => ({
  model: JEV_MODEL,
  state: { headline: sanitizeHeadline(title, maxTextChars) },
  questions: NOUL_QUESTIONS,
});

export function parseNoulAnswers(body) {
  const noul = {};
  for (const key of Object.keys(NOUL_QUESTIONS)) {
    const p = body?.answers?.[key]?.noul;
    if (typeof p !== 'number' || !Number.isFinite(p)) return null;
    noul[key] = p;
  }
  return noul;
}

// The relay's per-attempt deadline (jev-classify-relay.cjs): a slower answer is no answer there.
const JEV_TIMEOUT_MS = 5_000;
const JEV_RETRY_STATUSES = new Set([429, 529]);

async function postJev(request, { apiKey, fetchFn, usage, retryDelayMs }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetchFn(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor-Eval/1.0' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
      if (resp.ok) {
        const body = await resp.json();
        usage.inputTokens += body?.usage?.input_tokens ?? 0;
        return body;
      }
      resp.body?.cancel?.().catch(() => {});
      if (!JEV_RETRY_STATUSES.has(resp.status) && resp.status < 500) break;
    } catch { /* timeout or network error: retry */ }
    await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
  }
  usage.failedRequests += 1;
  return null;
}

// JevAnswer for one title, or null when either request has no valid answer.
export async function askJev(title, { apiKey, fetchFn = (...args) => globalThis.fetch(...args), usage, retryDelayMs = 1000 }) {
  const transport = { apiKey, fetchFn, usage, retryDelayMs };
  const [level] = parseJevAnswers(await postJev(buildJevRequest([title], { levelOnly: true }), transport), 1, { levelOnly: true });
  if (!level) return null;
  const noul = parseNoulAnswers(await postJev(buildNoulRequest(title), transport));
  return noul && { l: level.l, levelConf: level.levelConf, pAlert: level.pAlert, noul };
}

// A capture is trusted only for the frozen questions, the pinned model and exactly the
// held-out Latin titles in fixture order.
export function readCapture(file, rows) {
  const capture = JSON.parse(readFileSync(file, 'utf8'));
  if (capture.questionSetSha !== QUESTION_SET_SHA) throw new Error(`${file}: questionSetSha ${capture.questionSetSha} is not the frozen ${QUESTION_SET_SHA}`);
  if (capture.model !== JEV_MODEL) throw new Error(`${file}: model ${capture.model} is not ${JEV_MODEL}`);
  const titles = latinRows(rows).map((r) => r.title);
  if (JSON.stringify(capture.titles) !== JSON.stringify(titles)) throw new Error(`${file}: titles are not the held-out Latin titles in order`);
  for (const [name, run] of Object.entries(capture.runs ?? {})) {
    if (run.answers?.length !== titles.length) throw new Error(`${file}: runs["${name}"] has ${run.answers?.length} answers for ${titles.length} titles`);
  }
  return capture;
}
