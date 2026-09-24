import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_MODAL_SELECTOR,
  RELOAD_BLOCKING_MODAL_SELECTOR,
  RELOAD_SAFE_ATTR,
  findReloadBlockingModal,
  isModalOpen,
  type ModalDocumentLike,
  type VisibleElementLike,
} from '../src/utils/open-modal.ts';

// ---------------------------------------------------------------------------
// Fake document
//
// Elements declare whether they carry the reload opt-out. The fake applies the
// `:not([data-reload-safe])` clause itself, which is what a real DOM does when
// handed RELOAD_BLOCKING_MODAL_SELECTOR.
// ---------------------------------------------------------------------------

interface FakeEl {
  rendered: boolean;
  reloadSafe?: boolean;
  className?: string;
  role?: string;
  tagName?: string;
  /** false models Safari 17.0-17.3 / Firefox <125 (no checkVisibility). */
  supportsCheckVisibility?: boolean;
}

function makeDoc(els: FakeEl[]): ModalDocumentLike {
  return {
    querySelectorAll: (sel: string) => {
      const excludeOptOuts = sel === RELOAD_BLOCKING_MODAL_SELECTOR;
      return els
        .filter((e) => !(excludeOptOuts && e.reloadSafe))
        .map((e) => {
          const el: VisibleElementLike = {
            getClientRects: () => ({ length: e.rendered ? 1 : 0 }),
            className: e.className,
            tagName: e.tagName ?? 'DIV',
            getAttribute: (name: string) => (name === 'role' ? (e.role ?? null) : null),
          };
          if (e.supportsCheckVisibility !== false) el.checkVisibility = () => e.rendered;
          return el as Element & VisibleElementLike;
        });
    },
  };
}

describe('OPEN_MODAL_SELECTOR / RELOAD_BLOCKING_MODAL_SELECTOR', () => {
  it('derives the reload-blocking selector from the same clause list', () => {
    const base = OPEN_MODAL_SELECTOR.split(', ');
    const blocking = RELOAD_BLOCKING_MODAL_SELECTOR.split(', ');
    assert.equal(
      blocking.length,
      base.length,
      'a clause added to one list must appear in the other — that drift is the whole reason these are derived',
    );
    for (const [i, clause] of base.entries()) {
      assert.equal(blocking[i], `${clause}:not([${RELOAD_SAFE_ATTR}])`);
    }
  });

  it('still matches the Clerk backdrop, which is what #8577 turned on', () => {
    assert.ok(OPEN_MODAL_SELECTOR.includes('.cl-modalBackdrop'));
    assert.ok(RELOAD_BLOCKING_MODAL_SELECTOR.includes('.cl-modalBackdrop'));
  });
});

describe('isModalOpen', () => {
  it('reports a rendered overlay', () => {
    assert.equal(isModalOpen(makeDoc([{ rendered: true }])), true);
  });

  it('ignores a mounted-but-hidden overlay (UnifiedSettings at rest)', () => {
    assert.equal(isModalOpen(makeDoc([{ rendered: false }])), false);
  });

  it('keeps reporting a reload-safe overlay — accessibility still sees a dialog', () => {
    // The passkey prompt must not mount under ANY overlay, opt-out or not.
    assert.equal(isModalOpen(makeDoc([{ rendered: true, reloadSafe: true }])), true);
  });

  it('falls back to getClientRects when checkVisibility is unavailable', () => {
    assert.equal(isModalOpen(makeDoc([{ rendered: true, supportsCheckVisibility: false }])), true);
    assert.equal(isModalOpen(makeDoc([{ rendered: false, supportsCheckVisibility: false }])), false);
  });
});

describe('findReloadBlockingModal', () => {
  it('returns null when the only overlay opted out (WORLDMONITOR-15X)', () => {
    // The onboarding popover auto-opens for every preset-less user. Treating it
    // as work worth protecting deferred stale-bundle reloads for a broad
    // population rather than the sign-up case the guard exists for.
    const doc = makeDoc([{ rendered: true, reloadSafe: true, className: 'mission-preset-popover', role: 'dialog' }]);
    assert.equal(findReloadBlockingModal(doc), null);
  });

  it('names the blocking overlay when one is not opted out', () => {
    const doc = makeDoc([{ rendered: true, className: 'cl-modalBackdrop cl-internal-a6z71v' }]);
    assert.equal(findReloadBlockingModal(doc), 'cl-modalBackdrop');
  });

  it('looks past an opted-out overlay to find a real one behind it', () => {
    const doc = makeDoc([
      { rendered: true, reloadSafe: true, className: 'mission-preset-popover' },
      { rendered: true, className: 'cl-modalBackdrop' },
    ]);
    assert.equal(findReloadBlockingModal(doc), 'cl-modalBackdrop');
  });

  it('looks past a hidden persistent overlay to find the visible one', () => {
    const doc = makeDoc([
      { rendered: false, className: 'modal-overlay' },
      { rendered: true, className: 'cl-modalBackdrop' },
    ]);
    assert.equal(findReloadBlockingModal(doc), 'cl-modalBackdrop');
  });

  it('returns null when nothing is rendered', () => {
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: false, className: 'modal-overlay' }])), null);
  });

  it('falls back to role, then tagName, when an overlay carries no class', () => {
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: true, role: 'dialog' }])), 'dialog');
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: true, tagName: 'DIALOG' }])), 'DIALOG');
  });

  it('sanitises and bounds the label — it ships as a Sentry tag', () => {
    const doc = makeDoc([{ rendered: true, className: '🔒️weird/class name' }]);
    const label = findReloadBlockingModal(doc);
    assert.equal(label, 'weirdclass', 'strips anything outside [A-Za-z0-9_-]');

    const long = makeDoc([{ rendered: true, className: 'a'.repeat(120) }]);
    assert.equal(findReloadBlockingModal(long)?.length, 40, 'truncates so tag cardinality stays bounded');
  });

  it('never returns an empty label', () => {
    // A class of only stripped characters must not produce '' — an empty tag
    // reads as "no overlay" to anyone querying Sentry by blocked_by.
    assert.equal(findReloadBlockingModal(makeDoc([{ rendered: true, className: '🔒️' }])), 'unknown');
  });
});
