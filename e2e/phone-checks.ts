/**
 * The cheap, stable phone checks of docs/design/phone-layout.md section 9, as measurements on a page. Used by the
 * phone project only (players.spec.ts, combat.spec.ts). Emulation only: a real iPhone or Android is not covered
 * (Safari zooming into inputs below 16 px, the notch and safe areas, the on-screen keyboard changing the viewport).
 */
import { expect, type Page } from '@playwright/test';

/** Section 9.1: the page and `main` are not wider than the viewport, and nothing sticks out to the right. */
export async function expectNoSidewaysScroll(page: Page, where: string) {
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const main = document.querySelector('main');
    return {
      doc: [doc.scrollWidth, doc.clientWidth],
      main: main ? [main.scrollWidth, main.clientWidth] : [0, 0],
      // Elements past the right edge, except fixed ones and anything inside a deliberate horizontal scroller
      over: [...document.querySelectorAll('body *')].filter((e) => {
        if (getComputedStyle(e).position === 'fixed' || e.getBoundingClientRect().right <= innerWidth + 1) return false;
        for (let p = e.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth) return false;
        return true;
      }).length,
    };
  });
  expect(r.doc[0], `${where}: document scrollWidth vs clientWidth`).toBe(r.doc[1]);
  expect(r.main[0], `${where}: main scrollWidth vs clientWidth`).toBe(r.main[1]);
  expect(r.over, `${where}: elements past the right edge`).toBe(0);
}

/** Section 9.2: the compact header is one row of at most 56 px (portrait, 100 % text). */
export async function expectCompactHeader(page: Page, where: string) {
  const h = await page.evaluate(() => {
    const header = document.querySelector('body header');
    if (!header) return null;
    const items = [...header.querySelectorAll('a[href],button')].filter((e) => (e as HTMLElement).offsetParent !== null && !e.closest('#app-menu, #dice-log'));
    const tops = items.map((e) => e.getBoundingClientRect().top);
    return { height: header.getBoundingClientRect().height, spread: Math.max(...tops) - Math.min(...tops), vh: innerHeight };
  });
  expect(h, `${where}: the app header`).not.toBeNull();
  expect(h!.height, `${where}: header height`).toBeLessThanOrEqual(56);
  expect(h!.height / h!.vh, `${where}: header share of the viewport`).toBeLessThanOrEqual(0.15);
  expect(h!.spread, `${where}: header items in one row`).toBeLessThanOrEqual(8);
}

/**
 * Section 9.3: what is visible, tappable and smaller than 44 x 44 px. Prose links and inline dice are measured
 * elsewhere. `skip` is a CSS selector for a known gap that is listed in docs/STATUS.md (never a way to hide new ones).
 */
export async function smallTargets(page: Page, skip = ''): Promise<string[]> {
  return page.evaluate((skip) =>
    [...document.querySelectorAll<HTMLElement>('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=menuitem],summary,label:has(input[type=checkbox],input[type=radio])')]
      .filter((e) => e.offsetParent !== null && !(skip && e.closest(skip)) && !e.closest('.cn-prose') && !e.closest('[aria-hidden=true]') && !e.classList.contains('sr-only'))
      // A checkbox or radio may be 24 px when its label box is 44 px (the label is measured as its own entry)
      .filter((e) => !(e instanceof HTMLInputElement && /^(checkbox|radio)$/.test(e.type) && e.closest('label')))
      .map((e) => ({ t: `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)}"`, r: e.getBoundingClientRect() }))
      .filter((x) => x.r.width < 44 || x.r.height < 44)
      .map((x) => `${x.t} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  skip);
}

/** Section 9.4: every visible text-like field is at least 16 px (no iOS zoom) and 44 px tall. */
export async function smallFields(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]),select,textarea')]
      .filter((e) => e.offsetParent !== null && !e.closest('[aria-hidden=true]'))
      .map((e) => ({ t: `${e.tagName.toLowerCase()} "${e.getAttribute('aria-label') || e.getAttribute('name') || ''}"`, fs: parseFloat(getComputedStyle(e).fontSize), h: e.getBoundingClientRect().height }))
      .filter((x) => x.fs < 16 || x.h < 44)
      .map((x) => `${x.t} font ${x.fs}px height ${Math.round(x.h)}px`),
  );
}
