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

export function createPopupRenderer() {
  return () => {
    let el: HTMLDivElement | null = null;
    let items: SuggestionItem[] = [];
    let active = 0;
    let props: SuggestionProps<SuggestionItem> | null = null;

    const choose = (ix: number) => {
      const item = items[ix];
      if (item && props) item.run(props);
    };

    const draw = () => {
      if (!el) return;
      el.replaceChildren();
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'cn-suggest-empty';
        empty.textContent = 'No matches';
        el.append(empty);
        return;
      }
      items.forEach((item, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `cn-suggest-item${i === active ? ' is-active' : ''}`;
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

    return {
      onStart(p: SuggestionProps<SuggestionItem>) {
        props = p;
        items = p.items;
        active = 0;
        el = document.createElement('div');
        el.className = 'cn-suggest';
        el.setAttribute('role', 'listbox');
        document.body.append(el);
        draw();
        place();
      },
      onUpdate(p: SuggestionProps<SuggestionItem>) {
        props = p;
        items = p.items;
        active = Math.min(active, Math.max(0, items.length - 1));
        draw();
        place();
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
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
          el?.remove();
          el = null;
          return true;
        }
        return false;
      },
      onExit() {
        el?.remove();
        el = null;
        props = null;
      },
    };
  };
}
