/**
 * Heading levels that never skip (WCAG 1.3.1, axe `heading-order`) without changing what is stored or how
 * it looks: a heading deeper than one level below the heading before it gets `aria-level` = previous + 1.
 * The tag (and so the styling) stays as it is; only the exposed level changes.
 *
 * One rule everywhere (also in the editor, see table-names.ts): the level before the first heading is 1,
 * so with no `h1` on the page the first heading is at most level 2.
 *
 * Reference embeds and statblocks are levelled too (their headings sit in the same outline) but are not
 * used to name tables (see table-names.ts), because they are not part of the page's own content.
 */
const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const MARK = 'data-cn-levels';
export const BASE_LEVEL = 1;

/** The level a heading is exposed with after the pass: never more than one below the previous one. */
export function clampLevel(natural: number, previous: number): number {
  return Math.min(natural, previous + 1);
}

/** Hidden headings are not in the outline. */
function isHidden(h: HTMLElement): boolean {
  if (h.closest('[hidden],[aria-hidden="true"]')) return true;
  return typeof h.checkVisibility === 'function' ? !h.checkVisibility() : false;
}

/** Walks every visible heading of the document in order (so the page `h1` before a root counts) and sets or clears `aria-level` on those that `covered` accepts. */
function applyLevels(covered: (h: HTMLElement) => boolean): void {
  let previous = BASE_LEVEL;
  for (const h of document.querySelectorAll<HTMLElement>(HEADINGS)) {
    if (isHidden(h)) continue;
    const natural = Number(h.tagName[1]);
    if (!covered(h)) {
      previous = Number(h.getAttribute('aria-level')) || natural;
      continue;
    }
    const level = clampLevel(natural, previous);
    if (level !== natural) {
      if (h.getAttribute('aria-level') !== String(level)) h.setAttribute('aria-level', String(level));
    } else if (h.hasAttribute('aria-level')) h.removeAttribute('aria-level');
    previous = level;
  }
}

/** One pass over the headings inside `root` (idempotent: it starts from the tag each time). */
export function fixHeadingLevels(root: HTMLElement): void {
  applyLevels((h) => root.contains(h));
}

// ---- one owner for every watched root ----

const roots = new Set<HTMLElement>();
let observer: MutationObserver | null = null;
let queued = false;

const frame = (fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

function schedule() {
  if (queued) return;
  queued = true;
  frame(() => {
    queued = false;
    if (roots.size) applyLevels((h) => !!h.closest(`[${MARK}]`));
  });
}

/**
 * Keeps the headings inside `root` levelled while the page changes. All roots share one document-wide
 * observer and one coalesced pass per frame, so a title or a route that renders later, and neighbouring
 * roots, are always read in the same walk. Returns the stop function.
 */
export function watchHeadingLevels(root: HTMLElement): () => void {
  root.setAttribute(MARK, '');
  roots.add(root);
  if (!observer) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  schedule();
  return () => {
    roots.delete(root);
    root.removeAttribute(MARK);
    if (!roots.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}
