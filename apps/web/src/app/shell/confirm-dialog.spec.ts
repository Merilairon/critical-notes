import { Component, HostListener, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ConfirmService } from '../core/confirm.service';
import { ConfirmDialog } from './confirm-dialog';

/** Stands in for the drawer, the template dialogs and the hover preview: all close on a document Escape. */
@Component({ selector: 'cn-esc-listener', template: '' })
class EscListener {
  closed = 0;
  @HostListener('document:keydown.escape', ['$event'])
  protected onEsc(event: Event) {
    if (!event.defaultPrevented) this.closed++;
  }
}

@Component({
  selector: 'cn-host',
  imports: [ConfirmDialog, EscListener],
  template: `<cn-esc-listener /><main><button id="opener" type="button">Open</button></main>
    @if (confirm.request(); as req) {<cn-confirm-dialog [request]="req" />}`,
})
class Host {
  protected readonly confirm = inject(ConfirmService);
}

const settle = () => new Promise<void>((r) => setTimeout(r));

async function open() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const opener = el.querySelector<HTMLButtonElement>('#opener')!;
  opener.focus();
  const service = TestBed.inject(ConfirmService);
  const answer = service.ask({ title: 'Delete it?', message: 'Delete it for good?', confirmLabel: 'Delete' });
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const dialog = () => el.querySelector<HTMLElement>('[role="alertdialog"]');
  return { fixture, el, opener, answer, dialog };
}

describe('ConfirmDialog', () => {
  it('is a modal alertdialog, labelled and described, with Cancel focused first and the page inert', async () => {
    const { el, opener, dialog, answer } = await open();
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector(`#${d.getAttribute('aria-labelledby')}`)!.textContent).toBe('Delete it?');
    expect(el.querySelector(`#${d.getAttribute('aria-describedby')}`)!.textContent).toBe('Delete it for good?');
    expect(document.activeElement!.textContent).toBe('Cancel');
    expect(el.querySelector('main')!.hasAttribute('inert')).toBe(true);
    (document.activeElement as HTMLElement).click();
    expect(await answer).toBe(false);
    expect(opener.isConnected).toBe(true);
  });

  it('resolves true on the confirming button, removes the inert and returns focus to the opener', async () => {
    const { fixture, el, opener, dialog, answer } = await open();
    [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!.click();
    expect(await answer).toBe(true);
    fixture.detectChanges();
    expect(dialog()).toBeNull();
    expect(el.querySelector('main')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('Escape cancels and returns focus', async () => {
    const { fixture, opener, dialog, answer } = await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await answer).toBe(false);
    fixture.detectChanges();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a second question replaces the first: focus moves to the new Cancel and returns to the original opener', async () => {
    const { fixture, el, opener, dialog, answer } = await open();
    const second = TestBed.inject(ConfirmService).ask({ title: 'Again?', message: 'Again.' });
    fixture.detectChanges();
    expect(await answer).toBe(false);
    await fixture.whenStable();
    fixture.detectChanges();
    await settle();
    expect(dialog()!.textContent).toContain('Again?');
    expect(document.activeElement!.textContent).toBe('Cancel');
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    expect(el.querySelector('main')!.hasAttribute('inert')).toBe(true);
    (document.activeElement as HTMLElement).click();
    expect(await second).toBe(false);
    fixture.detectChanges();
    expect(document.activeElement).toBe(opener);
  });

  it('one Escape closes only the confirm, not the drawer or dialog under it', async () => {
    const { fixture, el, dialog, answer } = await open();
    const listener = fixture.debugElement.children.find((c) => c.componentInstance instanceof EscListener)!.componentInstance as EscListener;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await answer).toBe(false);
    fixture.detectChanges();
    expect(dialog()).toBeNull();
    expect(listener.closed).toBe(0);
    expect(el.querySelector('main')!.hasAttribute('inert')).toBe(false);
    // With no confirm open, the same Escape reaches it
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(listener.closed).toBe(1);
  });
});
