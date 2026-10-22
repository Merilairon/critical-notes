import { ConfirmService } from '../core/confirm.service';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { TemplateTrashItemDto } from '@cn/shared';
import { TemplateTrash } from './template-trash';

const settle = () => new Promise((r) => setTimeout(r));
async function tick(f: ComponentFixture<unknown>) {
  await settle();
  f.detectChanges();
  await settle();
  f.detectChanges();
}
const DAY = 86_400_000;
const item = (id: string, name: string, extra: Partial<TemplateTrashItemDto> = {}): TemplateTrashItemDto => ({
  id,
  kind: 'page',
  scope: 'user',
  builtinKey: null,
  name,
  description: '',
  icon: null,
  tags: [],
  version: 1,
  pageType: null,
  campaign: null,
  ownerName: null,
  canEdit: true,
  updatedAt: 0,
  deletedAt: Date.now(),
  ...extra,
});
const err = (r: TestRequest, status: number, body: object = {}) => r.flush(body, { status, statusText: String(status) });

async function mount(items: TemplateTrashItemDto[] | number = [], campaignId?: string) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(TemplateTrash);
  if (campaignId) fixture.componentRef.setInput('campaignId', campaignId);
  const changed = vi.fn();
  fixture.componentInstance.changed.subscribe(changed);
  const http = TestBed.inject(HttpTestingController);
  document.body.append(fixture.nativeElement);
  fixture.detectChanges();
  const req = http.expectOne((r) => r.url === '/api/templates/trash');
  expect(req.request.params.get('campaignId')).toBe(campaignId ?? null);
  if (typeof items === 'number') err(req, items, { error: 'Forbidden' });
  else req.flush({ templates: items });
  await tick(fixture);
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, http, changed, rows: () => Array.from(el.querySelectorAll('li')), btn: (row: number, a: string) => el.querySelectorAll('li')[row].querySelector<HTMLButtonElement>(`[data-action="${a}"]`)! };
}

describe('TemplateTrash', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('shows nothing when there is nothing deleted (a player)', async () => {
    const { el } = await mount([]);
    expect(el.querySelector('h2')).toBeNull();
    expect(el.querySelector('ul')).toBeNull();
    expect(el.textContent!.trim()).toBe('');
  });

  it('passes the campaign id and lists newest first with scope and age text', async () => {
    const { rows } = await mount([
      item('a', 'Old', { deletedAt: Date.now() - 28 * DAY, scope: 'campaign', campaign: { id: 'c1', name: 'Doom' } }),
      item('b', 'New', { kind: 'block' }),
    ], 'c1');
    expect(rows().map((r) => r.querySelector('p')!.textContent!.trim())).toEqual(['🧩 New', '📄 Old']);
    expect(rows()[0].textContent).toContain('Block template · Personal');
    expect(rows()[0].textContent).toContain('purged in 30 days');
    expect(rows()[1].textContent).toContain('Campaign: Doom');
    expect(rows()[1].textContent).toContain('Deleted 28 days ago');
    expect(rows()[1].textContent).toContain('purged in 2 days');
    expect(rows()[1].querySelector('p.text-accent')).not.toBeNull();
    expect(rows()[0].querySelector('p.text-accent')).toBeNull();
  });

  it('requests the campaign scope and keeps only personal items outside a campaign', async () => {
    const { rows } = await mount([item('a', 'Mine'), item('b', 'Theirs', { scope: 'campaign', campaign: { id: 'c9', name: 'Other' } })]);
    expect(rows().length).toBe(1);
    expect(rows()[0].textContent).toContain('Mine');
  });

  it('shows the error with Try again, and focuses the heading afterwards', async () => {
    const { el, http, fixture } = await mount(500);
    expect(Array.from(el.querySelectorAll('[role="alert"]')).map((a) => a.textContent).join()).toContain('Forbidden');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again')) as HTMLButtonElement).click();
    http.expectOne((r) => r.url === '/api/templates/trash').flush({ templates: [item('a', 'A')] });
    await tick(fixture);
    expect(el.querySelectorAll('li').length).toBe(1);
    expect(document.activeElement).toBe(el.querySelector('h2'));
  });

  it('restores a row without a confirm, tells the library and moves focus to the next row', async () => {
    const { el, http, fixture, btn, rows, changed } = await mount([item('a', 'Trap'), item('b', 'Room', { deletedAt: Date.now() - DAY })]);
    const confirmSpy = vi.spyOn(TestBed.inject(ConfirmService), 'ask');
    btn(0, 'restore').click();
    const req = http.expectOne('/api/templates/a/restore');
    expect(req.request.method).toBe('POST');
    req.flush({ id: 'a', name: 'Trap' });
    await tick(fixture);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(rows().length).toBe(1);
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Restored "Trap"');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(btn(0, 'restore'));
  });

  it('asks before deleting permanently; cancel does nothing; the last row hands focus to the heading', async () => {
    const { http, fixture, btn, rows, el } = await mount([item('a', 'Trap')]);
    const confirmSpy = vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    btn(0, 'purge').click();
    await settle();
    expect(confirmSpy).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Permanently delete "Trap"? This cannot be undone.' }));
    http.expectNone('/api/templates/a/purge');
    btn(0, 'purge').click();
    await settle();
    const req = http.expectOne('/api/templates/a/purge');
    expect(req.request.method).toBe('DELETE');
    req.flush({ purged: ['a'] });
    await tick(fixture);
    expect(rows().length).toBe(0);
    expect(el.textContent).toContain('Permanently deleted "Trap".');
    expect(el.textContent).toContain('No deleted templates.');
    expect(document.activeElement).toBe(el.querySelector('h2'));
  });

  it('treats 404 on restore as no longer in the trash and refreshes silently', async () => {
    const { el, http, fixture, btn, rows } = await mount([item('a', 'Trap'), item('b', 'Room', { deletedAt: Date.now() - DAY })]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/templates/a/restore'), 404, { error: 'Not found' });
    await settle();
    expect(el.querySelector('ul')).not.toBeNull();
    http.expectOne((r) => r.url === '/api/templates/trash').flush({ templates: [item('b', 'Room', { deletedAt: Date.now() - DAY })] });
    await tick(fixture);
    expect(rows().length).toBe(1);
    expect(document.activeElement).toBe(btn(0, 'restore'));
    expect(el.textContent).toContain('"Trap" is no longer in the trash.');
    expect(el.querySelector('[role="alert"]')!.textContent!.trim()).toBe('');
  });

  it('treats 404 on purge as no longer in the trash', async () => {
    const { el, http, fixture, btn, rows } = await mount([item('a', 'Trap')]);
    vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(true);
    btn(0, 'purge').click();
    await settle();
    err(http.expectOne('/api/templates/a/purge'), 404, { error: 'Not found' });
    await settle();
    http.expectOne((r) => r.url === '/api/templates/trash').flush({ templates: [] });
    await tick(fixture);
    expect(rows().length).toBe(0);
    expect(el.textContent).toContain('"Trap" is no longer in the trash.');
  });

  it('keeps the row and shows an alert on other failures', async () => {
    const { el, http, fixture, btn, rows } = await mount([item('a', 'Trap')]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/templates/a/restore'), 500, { error: 'Boom' });
    await tick(fixture);
    expect(rows().length).toBe(1);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Boom');
  });

  it('shows the busy state and ignores a second click while a request runs', async () => {
    const { http, fixture, btn, el } = await mount([item('a', 'Trap'), item('b', 'Room', { deletedAt: Date.now() - DAY })]);
    btn(0, 'restore').click();
    fixture.detectChanges();
    expect(btn(0, 'restore').getAttribute('aria-disabled')).toBe('true');
    expect(btn(0, 'restore').getAttribute('aria-busy')).toBe('true');
    expect(btn(0, 'restore').textContent).toContain('Restoring…');
    btn(1, 'restore').click();
    btn(0, 'restore').click();
    http.expectOne('/api/templates/a/restore').flush({ id: 'a', name: 'Trap' });
    http.expectNone('/api/templates/b/restore');
    await tick(fixture);
    expect(el.querySelectorAll('li').length).toBe(1);
  });

  it('ignores a second purge click while the first one runs', async () => {
    const { http, fixture, btn } = await mount([item('a', 'Trap'), item('b', 'Room', { deletedAt: Date.now() - DAY })]);
    const confirmSpy = vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(true);
    btn(0, 'purge').click();
    await settle();
    btn(0, 'purge').click();
    btn(1, 'purge').click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    http.expectOne('/api/templates/a/purge').flush({ purged: ['a'] });
    http.expectNone('/api/templates/b/purge');
    await tick(fixture);
  });

  it('treats 400 on restore as no longer in the trash and still tells the library', async () => {
    const { el, http, fixture, btn, changed } = await mount([item('a', 'Trap')]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/templates/a/restore'), 400, { error: 'Not deleted' });
    await settle();
    http.expectOne((r) => r.url === '/api/templates/trash').flush({ templates: [] });
    await tick(fixture);
    expect(el.textContent).toContain('"Trap" is no longer in the trash.');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows when a silent reload fails', async () => {
    const { el, http, fixture, btn, rows } = await mount([item('a', 'Trap'), item('b', 'Room', { deletedAt: Date.now() - DAY })]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/templates/a/restore'), 404, { error: 'Not found' });
    await settle();
    err(http.expectOne((r) => r.url === '/api/templates/trash'), 500, { error: 'Boom' });
    await tick(fixture);
    expect(rows().length).toBe(1);
    expect(Array.from(el.querySelectorAll('[role="alert"]')).map((a) => a.textContent!.trim()).join('')).toBe('');
  });

  it('does not let a silent reload bring back a row restored meanwhile', async () => {
    const { http, fixture, btn, rows } = await mount([item('a', 'Trap'), item('b', 'Room', { deletedAt: Date.now() - DAY })]);
    btn(0, 'restore').click();
    err(http.expectOne('/api/templates/a/restore'), 404, { error: 'Not found' });
    await settle();
    const reload = http.expectOne((r) => r.url === '/api/templates/trash');
    fixture.detectChanges();
    // Another action starts before the reload answers
    btn(0, 'restore').click();
    reload.flush({ templates: [item('b', 'Room'), item('c', 'Stale')] });
    http.expectOne('/api/templates/b/restore').flush({ id: 'b', name: 'Room' });
    await tick(fixture);
    expect(rows().length).toBe(0);
  });

  it('resets on a campaign change and ignores the stale response', async () => {
    const { fixture, http, el, rows } = await mount([item('a', 'Trap')], 'cA');
    fixture.componentRef.setInput('campaignId', 'cB');
    fixture.detectChanges();
    expect(rows().length).toBe(0);
    const slowB = http.expectOne((r) => r.params.get('campaignId') === 'cB');
    fixture.componentRef.setInput('campaignId', 'cC');
    fixture.detectChanges();
    const c = http.expectOne((r) => r.params.get('campaignId') === 'cC');
    c.flush({ templates: [item('c', 'Third', { scope: 'campaign' })] });
    await tick(fixture);
    slowB.flush({ templates: [item('b', 'Second', { scope: 'campaign' })] });
    await tick(fixture);
    expect(rows().length).toBe(1);
    expect(el.textContent).toContain('Third');
    expect(el.textContent).not.toContain('Second');
  });

  it('clears messages and busy state when the campaign changes mid-action', async () => {
    const { fixture, http, el, btn } = await mount([item('a', 'Trap')], 'cA');
    btn(0, 'restore').click();
    const pending = http.expectOne('/api/templates/a/restore');
    fixture.componentRef.setInput('campaignId', 'cB');
    fixture.detectChanges();
    http.expectOne((r) => r.params.get('campaignId') === 'cB').flush({ templates: [item('b', 'Other', { scope: 'campaign' })] });
    pending.flush({ id: 'a', name: 'Trap' });
    await tick(fixture);
    expect(el.textContent).not.toContain('Restored "Trap"');
    expect(el.querySelectorAll('li').length).toBe(1);
    expect(btn(0, 'restore').getAttribute('aria-busy')).toBeNull();
  });

  it('shows no loading line or margin on the first load, but a loading line on Try again', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(TemplateTrash);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Loading');
    expect(fixture.nativeElement.querySelector('section').classList.contains('mt-8')).toBe(false);
    err(http.expectOne((r) => r.url === '/api/templates/trash'), 500, { error: 'Boom' });
    await tick(fixture);
    (Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((b) => b.textContent?.includes('Try again')) as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Loading deleted templates…');
    http.expectOne((r) => r.url === '/api/templates/trash').flush({ templates: [] });
    await tick(fixture);
  });

  it('names buttons with the visible text first, also while busy, and separates the facts for screen readers', async () => {
    const { fixture, btn, el } = await mount([item('a', 'Trap')]);
    expect(btn(0, 'purge').getAttribute('aria-label')).toBe('Delete permanently: Trap');
    expect(btn(0, 'restore').getAttribute('aria-label')).toBe('Restore: Trap');
    const sep = el.querySelector('li .sr-only')!;
    expect(sep.textContent).toBe(', ');
    // Present at every width: never hidden by a breakpoint class
    expect(sep.className).not.toContain('hidden');
    vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(true);
    btn(0, 'purge').click();
    await settle();
    fixture.detectChanges();
    expect(btn(0, 'purge').getAttribute('aria-label')).toBe('Deleting…: Trap');
    expect(btn(0, 'restore').getAttribute('aria-label')).toBe('Restore: Trap');
  });

  it('appends a warning when the restored template reports a missing parent', async () => {
    const { el, http, fixture, btn } = await mount([item('a', 'Kid')]);
    btn(0, 'restore').click();
    http.expectOne('/api/templates/a/restore').flush({ id: 'a', name: 'Kid', issues: ['The parent template "p1" was not found'] });
    await tick(fixture);
    expect(el.querySelector('div[role="status"]')!.textContent).toContain('Restored "Kid". Its parent no longer exists: choose a new parent when you edit it.');
  });

  it.each([
    ['Templates extend each other in a loop'],
    ['Templates can extend at most 5 levels deep'],
    ['Default for {{x}}: bad parent value'],
  ])('uses the generic sentence for the issue "%s"', async (issue) => {
    const { el, http, fixture, btn } = await mount([item('a', 'Kid')]);
    btn(0, 'restore').click();
    http.expectOne('/api/templates/a/restore').flush({ id: 'a', name: 'Kid', issues: [issue] });
    await tick(fixture);
    const text = el.querySelector('div[role="status"]')!.textContent!;
    expect(text).toContain('Restored "Kid". It has a problem: open it to review.');
    expect(text).not.toContain('parent no longer exists');
  });

  it('counts several problems and keeps the parent sentence only for the missing parent', async () => {
    const { el, http, fixture, btn } = await mount([item('a', 'Kid')]);
    btn(0, 'restore').click();
    http.expectOne('/api/templates/a/restore').flush({ id: 'a', name: 'Kid', issues: ['x', 'y'] });
    await tick(fixture);
    expect(el.querySelector('div[role="status"]')!.textContent).toContain('It has 2 problems: open it to review.');
  });

  it('Try again keeps the button (disabled, busy) while loading and lands on the heading, with a named region', async () => {
    const { el, http, fixture } = await mount(500);
    const retry = () => el.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
    retry().focus();
    retry().click();
    fixture.detectChanges();
    expect(retry().getAttribute('aria-disabled')).toBe('true');
    expect(retry().getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(retry());
    expect(el.querySelector('section')!.getAttribute('aria-label')).toBe('Deleted templates');
    retry().click();
    http.expectOne((r) => r.url === '/api/templates/trash').flush({ templates: [item('a', 'A')] });
    await tick(fixture);
    expect(document.activeElement).toBe(el.querySelector('h2'));
  });

  it('keeps focus on Try again when the retry fails again', async () => {
    const { el, http, fixture } = await mount(500);
    el.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
    err(http.expectOne((r) => r.url === '/api/templates/trash'), 500, { error: 'Still down' });
    await tick(fixture);
    expect(document.activeElement).toBe(el.querySelector('[data-action="retry"]'));
    expect(el.textContent).toContain('Still down');
  });

  it('leaves an empty section unnamed (no empty landmark for a player)', async () => {
    const { el } = await mount([]);
    expect(el.querySelector('section')!.hasAttribute('aria-label')).toBe(false);
  });

  describe('parent in the trash (409)', () => {
    const blocked = (r: TestRequest) => err(r, 409, { error: 'This template extends "Base", which is in the trash. Restore that one first.', details: { templateId: 'p' } });

    it('shows the server message and restores the parent first, then offers the child again', async () => {
      const { el, http, fixture, btn, rows, changed } = await mount([item('k', 'Kid'), item('p', 'Base', { deletedAt: Date.now() - DAY })]);
      btn(0, 'restore').click();
      blocked(http.expectOne('/api/templates/k/restore'));
      await tick(fixture);
      expect(rows().length).toBe(2);
      expect(rows()[0].textContent).toContain('This template extends "Base", which is in the trash.');
      const parentBtn = btn(0, 'parent');
      expect(parentBtn.textContent).toContain('Restore the parent first');
      expect(document.activeElement).toBe(parentBtn);
      expect(parentBtn.getAttribute('aria-label')).toBe('Restore the parent first: Base');
      expect(el.querySelector(`#${parentBtn.getAttribute('aria-describedby')}`)!.textContent).toContain('which is in the trash');
      expect(el.querySelector('[role="status"]')!.textContent).toContain('which is in the trash');
      expect(changed).not.toHaveBeenCalled();

      parentBtn.click();
      fixture.detectChanges();
      expect(parentBtn.getAttribute('aria-label')).toBe('Restoring…: Base');
      http.expectOne('/api/templates/p/restore').flush({ id: 'p', name: 'Base' });
      await tick(fixture);
      expect(rows().length).toBe(1);
      expect(rows()[0].querySelector('[data-action="parent"]')).toBeNull();
      expect(rows()[0].textContent).not.toContain('which is in the trash');
      expect(el.querySelector('[role="status"]')!.textContent).toContain('Restored the parent "Base". You can restore "Kid" now.');
      expect(document.activeElement).toBe(btn(0, 'restore'));
      expect(changed).toHaveBeenCalledTimes(1);

      btn(0, 'restore').click();
      http.expectOne('/api/templates/k/restore').flush({ id: 'k', name: 'Kid' });
      await tick(fixture);
      expect(rows().length).toBe(0);
    });

    it('follows a parent that is itself blocked, and recovers when the parent is gone', async () => {
      const { el, http, fixture, btn } = await mount([item('k', 'Kid')]);
      btn(0, 'restore').click();
      blocked(http.expectOne('/api/templates/k/restore'));
      await tick(fixture);
      btn(0, 'parent').click();
      err(http.expectOne('/api/templates/p/restore'), 409, { error: 'This template extends "Root", which is in the trash. Restore that one first.', details: { templateId: 'r' } });
      await tick(fixture);
      expect(el.textContent).toContain('extends "Root"');
      btn(0, 'parent').click();
      err(http.expectOne('/api/templates/r/restore'), 404, { error: 'Not found' });
      await settle();
      http.expectOne((r) => r.url === '/api/templates/trash').flush({ templates: [item('k', 'Kid')] });
      await tick(fixture);
      expect(btn(0, 'parent')).toBeNull();
      expect(el.textContent).toContain('The parent is no longer in the trash.');
      expect(document.activeElement).toBe(btn(0, 'restore'));
    });

    it('walks a 3-level chain and names the template that really blocks', async () => {
      // G extends C extends P, all in the trash
      const { el, http, fixture, btn, rows, changed } = await mount([item('g', 'Grand'), item('c', 'Child', { deletedAt: Date.now() - DAY }), item('p', 'Root', { deletedAt: Date.now() - 2 * DAY })]);
      const row = () => rows().find((r) => r.dataset['id'] === 'g')!;
      const parentBtn = () => row().querySelector<HTMLButtonElement>('[data-action="parent"]')!;
      row().querySelector<HTMLButtonElement>('[data-action="restore"]')!.click();
      err(http.expectOne('/api/templates/g/restore'), 409, { error: 'This template extends "Child", which is in the trash. Restore that one first.', details: { templateId: 'c' } });
      await tick(fixture);
      parentBtn().click();
      err(http.expectOne('/api/templates/c/restore'), 409, { error: 'This template extends "Root", which is in the trash. Restore that one first.', details: { templateId: 'p' } });
      await tick(fixture);
      expect(row().textContent).toContain('"Child" is blocked too.');
      expect(parentBtn().getAttribute('aria-label')).toBe('Restore the parent first: Root');
      expect(rows().length).toBe(3);

      parentBtn().click();
      http.expectOne('/api/templates/p/restore').flush({ id: 'p', name: 'Root' });
      await tick(fixture);
      const status = () => el.querySelector('div[role="status"]')!.textContent!;
      expect(status()).toContain('Now restore "Child"');
      expect(status()).not.toContain('You can restore "Grand" now');
      expect(row().textContent).toContain('"Child" is needed before "Grand" can come back.');
      expect(parentBtn().getAttribute('aria-label')).toBe('Restore the parent first: Child');
      expect(document.activeElement).toBe(parentBtn());

      parentBtn().click();
      http.expectOne('/api/templates/c/restore').flush({ id: 'c', name: 'Child' });
      await tick(fixture);
      expect(status()).toContain('You can restore "Grand" now');
      expect(row().querySelector('[data-action="parent"]')).toBeNull();
      expect(rows().length).toBe(1);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(btn(0, 'restore')).toBe(document.activeElement);
    });

    it('keeps the block and shows the alert when restoring the parent fails', async () => {
      const { el, http, fixture, btn, rows } = await mount([item('k', 'Kid')]);
      btn(0, 'restore').click();
      blocked(http.expectOne('/api/templates/k/restore'));
      await tick(fixture);
      btn(0, 'parent').click();
      err(http.expectOne('/api/templates/p/restore'), 500, { error: 'Boom' });
      await tick(fixture);
      expect(rows().length).toBe(1);
      expect(btn(0, 'parent')).not.toBeNull();
      expect(Array.from(el.querySelectorAll('[role="alert"]')).map((a) => a.textContent).join()).toContain('Boom');
    });

    it('treats a 409 without a parent id as a plain error', async () => {
      const { el, http, fixture, btn } = await mount([item('k', 'Kid')]);
      btn(0, 'restore').click();
      err(http.expectOne('/api/templates/k/restore'), 409, { error: 'Conflict' });
      await tick(fixture);
      expect(btn(0, 'parent')).toBeNull();
      expect(el.querySelector('[role="alert"]')!.textContent).toContain('Conflict');
    });
  });
});
