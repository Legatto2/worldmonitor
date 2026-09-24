/**
 * "Is a real modal open right now?" — the shared answer.
 *
 * Two questions live here, and conflating them shipped a regression
 * (WORLDMONITOR-15X). They differ in what they are protecting:
 *
 *   1. `isModalOpen` — is ANY focus-trapping overlay on screen? The passkey
 *      offer prompt asks this, because it must not mount beneath a focus trap
 *      where assistive technology announces it but the keyboard cannot reach it.
 *      A non-modal onboarding popover still traps nothing but still overlays,
 *      so it counts.
 *   2. `findReloadBlockingModal` — would an automatic reload destroy work the
 *      user cannot get back? The service-worker updater and the stale-bundle
 *      check ask this. An onboarding prompt that re-appears on the next load
 *      answers no; a half-filled sign-up form answers yes.
 *
 * The second is a subset of the first, expressed by an opt-out attribute a
 * surface sets on itself (see `RELOAD_SAFE_ATTR`). Opting out is the surface's
 * own claim about its own state, which is the only place that knowledge lives.
 *
 * Extracted rather than copied. A second copy of the selector drifts the moment
 * someone adds a modal, and the two failure modes are both silent: a stale copy
 * either blocks forever or misses an overlay entirely.
 */

/** Element surface this module needs. Structural so tests need no real DOM. */
export interface VisibleElementLike {
  checkVisibility?: () => boolean;
  getClientRects?: () => { length: number };
  tagName?: string;
  className?: string;
  getAttribute?: (name: string) => string | null;
}

/** Document surface this module needs. */
export interface ModalDocumentLike {
  querySelectorAll: (sel: string) => Iterable<Element & VisibleElementLike>;
}

/**
 * Marks an overlay as holding nothing an automatic reload would destroy.
 *
 * Set it on surfaces that appear without the user asking and carry no entered
 * state — an onboarding prompt that re-opens on the next load is the case this
 * exists for. Do NOT set it on anything holding typed input, a multi-step flow,
 * or a confirmation the user is mid-way through: reloading those loses work.
 *
 * It narrows the reload guard only. `isModalOpen` still reports the surface,
 * because a reload-safe overlay is still an overlay for accessibility purposes.
 */
export const RELOAD_SAFE_ATTR = 'data-reload-safe';

/**
 * Selectors that identify a modal/dialog candidate.
 *
 * Matching alone is NOT enough. Many site modals mount at app startup and stay
 * in the DOM — `UnifiedSettings` builds its `.modal-overlay` and appends it to
 * `document.body` in its constructor, then only toggles `.active` on open and
 * close. A raw selector match would therefore be permanently true once Settings
 * has been instantiated. Visibility is what makes the predicate real; see
 * `isModalOpen` below.
 */
const MODAL_SELECTORS = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '.cl-modalBackdrop',
  '.modal-overlay',
  'dialog[open]',
] as const;

export const OPEN_MODAL_SELECTOR = MODAL_SELECTORS.join(', ');

/**
 * The same candidates minus anything that opted out of blocking a reload.
 * Derived rather than written out, so a new modal selector cannot be added to
 * one list and forgotten in the other.
 */
export const RELOAD_BLOCKING_MODAL_SELECTOR = MODAL_SELECTORS
  .map((sel) => `${sel}:not([${RELOAD_SAFE_ATTR}])`)
  .join(', ');

/**
 * Is this candidate actually rendered?
 *
 * Preferred: `element.checkVisibility()` (Chrome 105+, Safari 17.4+, FF 125+).
 * With default options it reports false for an element with no associated box
 * (`display: none`, detached) or under `content-visibility: hidden`, but NOT for
 * one hidden only by `opacity: 0` or `visibility: hidden` — so overlays must
 * hide by leaving layout.
 *
 * Fallback for older engines: `getClientRects().length > 0`. That returns 0 for
 * a `display: none` element — exactly how persistent overlays hide (`main.css`
 * `.modal-overlay { display: none }` / `.active { display: flex }`) — and
 * non-zero for rendered elements including `position: fixed` overlays.
 *
 * `offsetParent` is unusable here: MDN specifies it returns `null` for every
 * `position: fixed` element regardless of visibility, so it would
 * false-negative on the Story overlay, the active Country Intel overlay, and
 * `.modal-overlay` itself — all fixed-positioned.
 */
function isRendered(el: VisibleElementLike): boolean {
  const checkVisibility = el.checkVisibility;
  if (typeof checkVisibility === 'function') return checkVisibility.call(el);
  const getClientRects = el.getClientRects;
  return typeof getClientRects === 'function' && getClientRects.call(el).length > 0;
}

/**
 * A short, bounded label naming which overlay blocked a reload.
 *
 * Exists because the first production report of a deferral said only that
 * *something* was open, leaving the element to be inferred from the geographic
 * spread of the affected users. Sanitised and truncated: it is published as a
 * Sentry tag, so it must stay a stable low-cardinality token rather than
 * arbitrary DOM text.
 */
function describe(el: VisibleElementLike): string {
  const role = el.getAttribute?.('role') ?? '';
  const firstClass = (el.className ?? '').split(/\s+/).find((c) => c.length > 0) ?? '';
  const raw = firstClass || role || el.tagName || 'unknown';
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return safe.length > 0 ? safe : 'unknown';
}

/**
 * Any candidate that is actually rendered → a real open modal.
 *
 * Reload consumers want `findReloadBlockingModal` instead; this one answers the
 * broader "is an overlay on screen" question and deliberately ignores the
 * reload opt-out.
 */
export function isModalOpen(doc: ModalDocumentLike): boolean {
  for (const el of doc.querySelectorAll(OPEN_MODAL_SELECTOR)) {
    if (isRendered(el)) return true;
  }
  return false;
}

/**
 * The first rendered overlay that has NOT opted out of blocking a reload,
 * described for telemetry — or null when an automatic reload is safe.
 *
 * Returns a label rather than a boolean so the caller can report what it saw;
 * `null` is the "go ahead and reload" answer.
 */
export function findReloadBlockingModal(doc: ModalDocumentLike): string | null {
  for (const el of doc.querySelectorAll(RELOAD_BLOCKING_MODAL_SELECTOR)) {
    if (isRendered(el)) return describe(el);
  }
  return null;
}
