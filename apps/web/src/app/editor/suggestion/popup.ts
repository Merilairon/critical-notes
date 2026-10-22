/**
 * A small keyboard-driven popup for TipTap suggestions (slash menu, [[page links]], {@references}).
 * Plain DOM (text only, never innerHTML), positioned with floating-ui.
 */
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

export interface SuggestionItem {
  title: string;
  subtitle?: string;
  icon?: string;
  /** Runs when chosen. Receives the suggestion props (editor + range). */
  run(props: SuggestionProps<SuggestionItem>): void;
}

let nextPopupId = 0;

/** The words a screen reader hears for the result count. */
export function resultsStatus(count: number): string {
  return count ? `${count} ${count === 1 ? 'result' : 'results'}. Use the up and down arrow keys, Enter to choose.` : 'No results';
}

export function createPopupRenderer() {
  return () => {
    const id = `cn-suggest-${++nextPopupId}`;
    let el: HTMLDivElement | null = null;
    let status: HTMLDivElement | null = null;
    /** The editing area while the popup is open, and the role it had before. */
    let field: HTMLElement | null = null;
    let fieldRole: string | null = null;
    /** Escape closes the popup, but the suggestion stays active until the text changes: it must not eat keys meanwhile. */
    let dismissed = false;
    let announceTimer: ReturnType<typeof setTimeout> | undefined;

    let items: SuggestionItem[] = [];
    let active = 0;
    let props: SuggestionProps<SuggestionItem> | null = null;

    const choose = (ix: number) => {
      const item = items[ix];
      if (item && props) item.run(props);
    };

    const ARIA = ['aria-multiline', 'aria-expanded', 'aria-controls', 'aria-activedescendant', 'aria-autocomplete', 'aria-haspopup'];

    /** A text field that owns a popup list is a combobox; the role is on only while the popup is open. */
    const syncField = () => {
      if (!field) return;
      const open = !!el && items.length > 0;
      if (!open) {
        for (const a of ARIA) field.removeAttribute(a);
        if (fieldRole === null) field.removeAttribute('role');
        else field.setAttribute('role', fieldRole);
        return;
      }
      field.setAttribute('role', 'combobox');
      field.setAttribute('aria-multiline', 'true');
      field.setAttribute('aria-expanded', 'true');
      field.setAttribute('aria-controls', id);
      field.setAttribute('aria-activedescendant', `${id}-${active}`);
      field.setAttribute('aria-autocomplete', 'list');
      field.setAttribute('aria-haspopup', 'listbox');
    };

    const announce = (text: string) => {
      if (status && status.textContent !== text) status.textContent = text;
    };

    const draw = () => {
      if (!el) return;
      el.replaceChildren();
      el.id = id;
      if (items.length) el.setAttribute('role', 'listbox');
      else el.removeAttribute('role');
      announce(resultsStatus(items.length));
      syncField();
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'cn-suggest-empty';
        empty.textContent = 'No results';
        el.append(empty);
        return;
      }
      items.forEach((item, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.tabIndex = -1;
        btn.className = `cn-suggest-item${i === active ? ' is-active' : ''}`;
        btn.id = `${id}-${i}`;
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', String(i === active));
        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = 'cn-suggest-icon';
          icon.textContent = item.icon;
          btn.append(icon);
        }
        const title = document.createElement('span');
        title.className = 'cn-suggest-title';
        title.textContent = item.title;
        btn.append(title);
        if (item.subtitle) {
          const sub = document.createElement('span');
          sub.className = 'cn-suggest-sub';
          sub.textContent = item.subtitle;
          btn.append(sub);
        }
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => choose(i));
        el!.append(btn);
      });
      el.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    };

    const place = () => {
      const rect = props?.clientRect?.();
      if (!el || !rect) return;
      const virtual = { getBoundingClientRect: () => rect };
      computePosition(virtual, el, { placement: 'bottom-start', middleware: [offset(6), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
        if (el) Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
      });
    };

    const teardown = () => {
      clearTimeout(announceTimer);
      el?.remove();
      el = null;
      syncField();
      status?.remove();
      status = null;
      field = null;
    };

    return {
      onStart(p: SuggestionProps<SuggestionItem>) {
        props = p;
        items = p.items;
        active = 0;
        dismissed = false;
        el = document.createElement('div');
        el.className = 'cn-suggest';
        field = p.editor.view.dom as HTMLElement;
        // Inside the page's landmark (it is positioned with `fixed`), so no content sits outside a landmark
        const host = field.closest('main') ?? document.body;
        host.append(el);
        fieldRole = field.getAttribute('role');
        // A live region has to exist before its text changes, or the first text is not announced.
        status = document.createElement('div');
        status.className = 'sr-only';
        status.setAttribute('role', 'status');
        host.append(status);
        draw();
        status.textContent = '';
        // The results may change before the timer fires (the first list often arrives a moment later): say the current count
        announceTimer = setTimeout(() => announce(resultsStatus(items.length)), 50);
        place();
      },
      onUpdate(p: SuggestionProps<SuggestionItem>) {
        props = p;
        items = p.items;
        if (dismissed) return;
        active = Math.min(active, Math.max(0, items.length - 1));
        draw();
        place();
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (dismissed) return false;
        if (event.key === 'ArrowDown') {
          active = (active + 1) % Math.max(1, items.length);
          draw();
          return true;
        }
        if (event.key === 'ArrowUp') {
          active = (active - 1 + items.length) % Math.max(1, items.length);
          draw();
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (!items.length) return false;
          choose(active);
          return true;
        }
        if (event.key === 'Escape') {
          dismissed = true;
          teardown();
          return true;
        }
        return false;
      },
      onExit() {
        teardown();
        props = null;
      },
    };
  };
}
