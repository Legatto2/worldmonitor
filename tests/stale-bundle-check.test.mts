import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStaleBundleCheck } from '../src/bootstrap/stale-bundle-check.ts';
import { OPEN_MODAL_SELECTOR, type VisibleElementLike } from '../src/utils/open-modal.ts';

// ---------------------------------------------------------------------------
// Fake environment
// ---------------------------------------------------------------------------

interface FakeEnv {
  focusListeners: Array<EventListener>;
  visibilityListeners: Array<EventListener>;
  intervalCallbacks: Array<() => void>;
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  fetchResponse: { ok: boolean; status: number; body: string };
  reloadCalls: number;
  clock: { value: number; tick(ms: number): void };
  visibilityState: 'visible' | 'hidden';
  /**
   * What OPEN_MODAL_SELECTOR finds in the fake document. 'mounted-hidden'
   * models UnifiedSettings at rest: the overlay is in the DOM for the whole
   * session but display:none, so it must NOT suppress a reload.
   */
  modal: 'none' | 'open' | 'mounted-hidden';
  /** When set, the fetch fake awaits it before answering (in-flight race). */
  fetchGate: Promise<void> | null;
  /**
   * false models Safari 17.0-17.3 / Firefox <125, where isModalOpen falls back
   * to getClientRects. That is the mobile cohort #8577 was reported on.
   */
  supportsCheckVisibility: boolean;
  /** Deferral episodes observed, for the once-per-episode report. */
  deferralReports: Array<{ current: string; deployed: string }>;
}

function makeEnv(initial: Partial<{ ok: boolean; status: number; body: string }> = {}): FakeEnv {
  const focusListeners: Array<EventListener> = [];
  const visibilityListeners: Array<EventListener> = [];
  const intervalCallbacks: Array<() => void> = [];
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    focusListeners,
    visibilityListeners,
    intervalCallbacks,
    fetchCalls,
    fetchResponse: {
      ok: initial.ok ?? true,
      status: initial.status ?? 200,
      body: initial.body ?? '',
    },
    reloadCalls: 0,
    clock: {
      value: 1_000_000,
      tick(ms: number) { this.value += ms; },
    },
    visibilityState: 'visible',
    modal: 'none',
    fetchGate: null,
    supportsCheckVisibility: true,
    deferralReports: [],
  };
}

function install(env: FakeEnv, currentHash = 'sha-running-bundle', minIntervalMs = 60_000) {
  return installStaleBundleCheck({
    currentHash,
    minIntervalMs,
    eventTarget: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'focus') env.focusListeners.push(listener as EventListener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'focus') {
          const i = env.focusListeners.indexOf(listener as EventListener);
          if (i !== -1) env.focusListeners.splice(i, 1);
        }
      },
    },
    documentTarget: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') env.visibilityListeners.push(listener as EventListener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') {
          const i = env.visibilityListeners.indexOf(listener as EventListener);
          if (i !== -1) env.visibilityListeners.splice(i, 1);
        }
      },
      get visibilityState() { return env.visibilityState; },
      querySelectorAll: (sel: string) => {
        // Pin the selector: a regression that queries the wrong one must not
        // leave this suite green (mirrors tests/sw-update.test.mts).
        if (sel !== OPEN_MODAL_SELECTOR) return [];
        if (env.modal === 'none') return [];
        const el = (visible: boolean): Element & VisibleElementLike => ({
          getClientRects: () => ({ length: visible ? 1 : 0 }),
          ...(env.supportsCheckVisibility ? { checkVisibility: () => visible } : {}),
        } as unknown as Element & VisibleElementLike);
        if (env.modal === 'mounted-hidden') return [el(false)];
        // UnifiedSettings' overlay is mounted and hidden for the whole session
        // and precedes the Clerk backdrop in DOM order.
        return [el(false), el(true)];
      },
    },
    setInterval: (cb: () => void, _ms: number) => {
      env.intervalCallbacks.push(cb);
      return env.intervalCallbacks.length; // dummy handle
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      env.fetchCalls.push({ url, init });
      if (env.fetchGate) await env.fetchGate;
      const { ok, status, body } = env.fetchResponse;
      return new Response(body, { status, statusText: ok ? 'OK' : 'Error' });
    },
    reload: () => { env.reloadCalls++; },
    reportDeferral: (current: string, deployed: string) => { env.deferralReports.push({ current, deployed }); },
    now: () => env.clock.value,
  });
}

async function fireFocus(env: FakeEnv): Promise<void> {
  for (const listener of [...env.focusListeners]) {
    listener(new Event('focus'));
  }
  // Drain microtasks so fetch/reload assertions observe the inner async work.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fireVisibilityChange(env: FakeEnv, state: 'visible' | 'hidden'): Promise<void> {
  env.visibilityState = state;
  for (const listener of [...env.visibilityListeners]) {
    listener(new Event('visibilitychange'));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fireInterval(env: FakeEnv): Promise<void> {
  for (const cb of [...env.intervalCallbacks]) {
    cb();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installStaleBundleCheck', () => {
  let env: FakeEnv;
  beforeEach(() => { env = makeEnv(); });

  it('reloads when /build-hash.txt returns a different hash', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy\n' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 1);
  });

  it('does NOT reload when the deployed hash matches the running bundle', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 0);
  });

  it('skips entirely when currentHash is the "dev" marker (no fetch, no reload)', async () => {
    install(env, 'dev');
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 0, 'must not fetch when running a dev bundle');
    assert.equal(env.reloadCalls, 0);
  });

  it('does NOT reload when /build-hash.txt returns the "dev" marker', async () => {
    // Local previews / non-Vercel builds emit 'dev' as the hash. A production
    // tab fetching this must not force-reload itself into the dev bundle.
    env.fetchResponse = { ok: true, status: 200, body: 'dev' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 0);
  });

  it('does NOT reload when the fetch fails (offline / non-OK)', async () => {
    env.fetchResponse = { ok: false, status: 500, body: 'oops' };
    install(env);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.reloadCalls, 0);
  });

  it('dedupes focus events within minIntervalMs (single fetch per window)', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env, 'sha-running-bundle', 60_000);
    await fireFocus(env);
    env.clock.tick(30_000); // < 60s
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1, 'second focus inside 60s window must not refetch');
  });

  it('refetches after the dedupe window elapses', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env, 'sha-running-bundle', 60_000);
    await fireFocus(env);
    env.clock.tick(60_001);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 2, 'focus past 60s must trigger a fresh fetch');
  });

  it('uses /build-hash.txt with cache-bust query param and no-store', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env);
    await fireFocus(env);
    const call = env.fetchCalls[0];
    assert.match(call.url, /^\/build-hash\.txt\?t=\d+$/);
    assert.equal(call.init?.cache, 'no-store');
  });

  it('trims whitespace from the deployed hash before comparing', async () => {
    // build-hash.txt is plain text; trailing newlines from various build
    // systems must not produce false-positive reloads.
    env.fetchResponse = { ok: true, status: 200, body: '  sha-running-bundle  \n' };
    install(env);
    await fireFocus(env);
    assert.equal(env.reloadCalls, 0, 'trimmed hash equals current → no reload');
  });

  // PR #3499 follow-up — installStaleBundleCheck initially listened on
  // window 'focus' only. One stuck-bundle user (Sentry user_3Cu7uZZJ...)
  // hammered setPreferences with constant actualSyncVersion=20 because
  // their tab was pinned in the background and never received focus →
  // stale-bundle-check never fired → bundle never reloaded. Adding
  // visibilitychange + setInterval closes that gap.

  it('reloads when document becomes visible (background-tab safety net)', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    install(env);
    await fireVisibilityChange(env, 'visible');
    assert.equal(env.fetchCalls.length, 1, 'visibilitychange to visible should trigger check');
    assert.equal(env.reloadCalls, 1);
  });

  it('does NOT trigger check on visibilitychange when going to hidden', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    install(env);
    // Tab going INTO background — useless to check (reload would be lost).
    // Only the visible transition should fire the check.
    await fireVisibilityChange(env, 'hidden');
    assert.equal(env.fetchCalls.length, 0, 'hidden transition must not fetch');
  });

  it('reloads when periodic interval fires (catches background tabs that never visibility-change)', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    install(env);
    // Simulate the setInterval firing.
    await fireInterval(env);
    assert.equal(env.fetchCalls.length, 1, 'periodic timer should trigger check');
    assert.equal(env.reloadCalls, 1);
  });

  it('all three triggers (focus / visibility / interval) collapse via the same dedupe window', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    install(env, 'sha-running-bundle', 60_000);
    await fireFocus(env);
    env.clock.tick(10_000); // <60s
    await fireVisibilityChange(env, 'visible');
    env.clock.tick(10_000);
    await fireInterval(env);
    assert.equal(env.fetchCalls.length, 1, 'all three triggers within dedupe window must collapse to one fetch');
  });

  it('disposer fully removes focus + visibilitychange + interval (no orphaned listeners on double-install)', async () => {
    // Greptile P2 fix: production calls installStaleBundleCheck once at
    // boot. But hot-reload, test-helper reuse, or future code paths could
    // double-install. The disposer must remove ALL three trigger paths so
    // a re-install starts from a clean slate.
    env.fetchResponse = { ok: true, status: 200, body: 'sha-running-bundle' };
    const dispose = install(env);
    assert.equal(env.focusListeners.length, 1, 'focus listener attached on install');
    assert.equal(env.visibilityListeners.length, 1, 'visibility listener attached on install');
    assert.equal(env.intervalCallbacks.length, 1, 'interval scheduled on install');

    dispose();
    assert.equal(env.focusListeners.length, 0, 'disposer removed focus listener');
    assert.equal(env.visibilityListeners.length, 0, 'disposer removed visibility listener');
    // intervalCallbacks isn't drained (clearInterval doesn't pop from our
    // fake's callback array), but firing it post-disposal would still
    // invoke it. The real `clearInterval` does prevent firing — and the
    // production timer is the only thing the disposer needs to actually
    // stop, since events past the disposal point can't reach removed
    // listeners.

    // After disposal, firing focus/visibility should NOT trigger fetch.
    await fireFocus(env);
    await fireVisibilityChange(env, 'visible');
    assert.equal(env.fetchCalls.length, 0, 'no fetch after disposal — listeners truly removed');
  });

  // --- open-modal guard (#8577) ---------------------------------------------
  // A user signing up on mobile must leave the app to read the emailed Clerk
  // code. Returning fires `focus`, and before this guard the stale-bundle
  // reload destroyed the modal they had to type the code into.

  it('does NOT reload while a modal is visibly open', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    env.modal = 'open';
    install(env);

    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1, 'the hash check still runs');
    assert.equal(env.reloadCalls, 0, 'reload deferred while the modal is open');
  });

  it('reloads on the next trigger after the modal closes, without refetching or waiting out the dedupe window', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    env.modal = 'open';
    install(env);

    await fireFocus(env);
    assert.equal(env.reloadCalls, 0, 'deferred under the modal');

    env.modal = 'none';
    env.clock.tick(1_000); // well inside minIntervalMs
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 1, 'staleness is terminal knowledge — no second fetch');
    assert.equal(env.reloadCalls, 1, 'reload fires on the first clear trigger');
  });

  it('does NOT reload when the modal opens while the hash fetch is in flight', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    let releaseFetch: () => void = () => {};
    env.fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    install(env);

    await fireFocus(env);
    assert.equal(env.reloadCalls, 0, 'fetch still gated');

    // The modal mounts after the trigger fired but before the hash answer lands.
    env.modal = 'open';
    releaseFetch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(env.reloadCalls, 0, 'the modal that opened mid-fetch is still seen');

    env.modal = 'none';
    env.fetchGate = null;
    await fireInterval(env);
    assert.equal(env.reloadCalls, 1, 'the deferred reload lands once the modal is gone');
    assert.equal(env.fetchCalls.length, 1, 'and it lands without a second fetch');
  });

  it('DOES reload over a mounted-but-hidden dialog (persistent overlay case)', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    env.modal = 'mounted-hidden';
    install(env);

    await fireFocus(env);
    assert.equal(env.reloadCalls, 1, 'a hidden overlay is not an open modal');
  });

  it('reloads when no document is available (nothing to protect)', async () => {
    // `documentTarget: undefined` only reaches the no-document branch because
    // this runner has no global `document` to fall back to. Assert that, or the
    // test would silently exercise the real-document branch under jsdom and
    // still pass (no modal -> reload) for the wrong reason.
    assert.equal(typeof document, 'undefined', 'precondition: runner must have no global document');
    const focusListeners: Array<EventListener> = [];
    let reloadCalls = 0;
    installStaleBundleCheck({
      currentHash: 'sha-running-bundle',
      eventTarget: {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
          if (type === 'focus') focusListeners.push(listener as EventListener);
        },
        removeEventListener: () => {},
      },
      documentTarget: undefined,
      setInterval: () => 1,
      fetch: async () => new Response('sha-newer-deploy', { status: 200 }),
      reload: () => { reloadCalls++; },
      now: () => 1_000_000,
    });

    for (const listener of [...focusListeners]) listener(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reloadCalls, 1, 'no document means no modal to preserve');
  });

  it('reloads at once when the modal closes before the hash answer lands', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    env.modal = 'open';
    let releaseFetch: () => void = () => {};
    env.fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    install(env);

    await fireFocus(env);
    // The modal closes while the request is still outstanding, so the probe --
    // which runs when the answer arrives -- must see a clear document.
    env.modal = 'none';
    releaseFetch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(env.reloadCalls, 1, 'no deferral when the modal is already gone');
    assert.equal(env.deferralReports.length, 0, 'nothing was deferred');
  });

  it('retries without refetching across repeated triggers while the modal stays open', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    env.modal = 'open';
    install(env);

    await fireFocus(env);
    for (let i = 0; i < 4; i++) {
      env.clock.tick(5 * 60_000); // well past the dedupe window each time
      await fireInterval(env);
      await fireFocus(env);
    }
    assert.equal(env.reloadCalls, 0, 'still deferred after nine triggers');
    assert.equal(env.fetchCalls.length, 1, 'and never refetched');
    assert.equal(env.deferralReports.length, 1, 'reported once per episode, not per trigger');
  });

  it('returns to fetching after a deferred reload finally lands', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    env.modal = 'open';
    install(env);

    await fireFocus(env);
    env.modal = 'none';
    env.clock.tick(1_000);
    await fireFocus(env);
    assert.equal(env.reloadCalls, 1, 'deferred reload landed');

    // Navigation can be cancelled (a declined beforeunload), so the module must
    // drop the pending debt and go back to asking the network.
    env.clock.tick(61_000);
    await fireFocus(env);
    assert.equal(env.fetchCalls.length, 2, 'pending state cleared — the check resumes fetching');
  });

  it('falls back to getClientRects when checkVisibility is unavailable', async () => {
    env.fetchResponse = { ok: true, status: 200, body: 'sha-newer-deploy' };
    env.supportsCheckVisibility = false;
    env.modal = 'open';
    install(env);

    await fireFocus(env);
    assert.equal(env.reloadCalls, 0, 'older engines still see the open modal');

    env.modal = 'mounted-hidden';
    env.clock.tick(1_000);
    await fireFocus(env);
    assert.equal(env.reloadCalls, 1, 'and still reload over a hidden persistent overlay');
  });
});
