import { SEEN_MS } from '../campaign/live/live.service';

/**
 * Calls `onSeen(id)` for each element once it has been in view for SEEN_MS: half of it, or (for a block taller than two
 * screens) half a screen of it. Returns a function that stops watching. Without IntersectionObserver (old browsers, jsdom)
 * nothing is watched, so the marks stay until the page is left.
 */
export function watchSeen(marked: Map<Element, string>, onSeen: (id: string, el: Element) => void): () => void {
  if (!marked.size || typeof IntersectionObserver === 'undefined') return () => undefined;
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const screen = e.rootBounds?.height ?? window.innerHeight;
        const inView = e.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= screen / 2);
        if (!inView) {
          clearTimeout(timers.get(e.target));
          timers.delete(e.target);
          continue;
        }
        if (timers.has(e.target)) continue;
        timers.set(
          e.target,
          setTimeout(() => {
            io.unobserve(e.target);
            onSeen(marked.get(e.target) ?? '', e.target);
          }, SEEN_MS),
        );
      }
    },
    // Fine steps: a very tall block never reaches a ratio of 0.5, so it must report smaller changes too
    { threshold: Array.from({ length: 51 }, (_, i) => i / 50) },
  );
  for (const el of marked.keys()) io.observe(el);
  return () => {
    io.disconnect();
    for (const t of timers.values()) clearTimeout(t);
  };
}
