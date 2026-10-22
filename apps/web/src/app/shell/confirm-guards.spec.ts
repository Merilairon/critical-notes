/**
 * What the app's confirm dialog guards: Cancel keeps the item (no request, no state change) at every call site
 * without a mounted spec, and the unsaved-changes route guards (`canLeave`) with the real ConfirmService and dialog.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { RULESET_IDS } from '@cn/fivetools';
import { AuthService } from '../core/auth.service';
import { ContextService } from '../core/context.service';
import { ConfirmService } from '../core/confirm.service';
import { CampaignStore } from '../campaign/campaign.store';
import { EditionMigrationPanel } from '../campaign/edition-migration';
import { MembersPanel } from '../campaign/members-panel';
import { PropertiesPanel } from '../campaign/properties-panel';
import { HomebrewApi } from '../homebrew/homebrew-api';
import { HomebrewEntityEditor } from '../homebrew/entity-editor';
import { HomebrewSourcePage } from '../homebrew/source-page';
import { EncounterBuilder } from '../play/encounter-builder';
import { PlayApi } from '../play/play-api';
import { TrackerPage } from '../play/tracker-page';
import { TemplateApi } from '../templates/template-api';
import { TemplateEditor } from '../templates/template-editor';
import { ConfirmDialog } from './confirm-dialog';

const settle = () => new Promise<void>((r) => setTimeout(r));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The component without rendering it: its methods are what the guarded actions call. */
function make<T>(cls: Type<T>, providers: unknown[] = []): T {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), ...(providers as never[])] });
  return TestBed.runInInjectionContext(() => new cls());
}
const cancelled = () => vi.spyOn(TestBed.inject(ConfirmService), 'ask').mockResolvedValue(false);
const navigate = () => vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

describe('Cancel keeps the item', () => {
  it('members: remove and leave send nothing', async () => {
    const store = { id: signal('c1'), myId: signal('u1'), members: signal([]), isGm: signal(false), loadMembers: vi.fn(async () => undefined) };
    const panel = make(MembersPanel, [{ provide: CampaignStore, useValue: store }]) as Any;
    const http = TestBed.inject(HttpTestingController);
    const ask = cancelled();
    const nav = navigate();
    await panel.remove({ userId: 'u2', displayName: 'Pia' });
    await panel.leave();
    expect(ask).toHaveBeenCalledTimes(2);
    http.expectNone(() => true);
    expect(nav).not.toHaveBeenCalled();
  });

  it('properties: the definition is not deleted', async () => {
    const deleteProperty = vi.fn();
    const panel = make(PropertiesPanel, [{ provide: CampaignStore, useValue: { propertyDefs: signal([]), id: signal('c1'), pages: signal([]), deleteProperty } }]) as Any;
    const ask = cancelled();
    await panel.removeDef({ id: 'd1', label: 'Mood' });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete the property "Mood" from every page in this campaign?' }));
    expect(deleteProperty).not.toHaveBeenCalled();
  });

  it('homebrew source: nothing is deleted and the page stays', async () => {
    const api = { deleteSource: vi.fn() };
    const page = make(HomebrewSourcePage, [{ provide: HomebrewApi, useValue: api }, { provide: AuthService, useValue: { user: signal(null) } }]) as Any;
    page.source.set({ id: 's1', fullName: 'My Book', entityCount: 3 });
    const ask = cancelled();
    const nav = navigate();
    await page.deleteSource();
    expect(ask).toHaveBeenCalled();
    expect(api.deleteSource).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it('encounter: not deleted', async () => {
    const api = { deleteEncounter: vi.fn() };
    const page = make(EncounterBuilder, [{ provide: PlayApi, useValue: api }, { provide: CampaignStore, useValue: { id: signal('c1') } }, { provide: ContextService, useValue: {} }]) as Any;
    page.enc.set({ id: 'e1', name: 'Ambush' });
    const ask = cancelled();
    await page.remove();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete the encounter "Ambush"?' }));
    expect(api.deleteEncounter).not.toHaveBeenCalled();
  });

  it('tracker: combat is not ended and the tracker is not deleted', async () => {
    const api = { act: vi.fn(), deleteTracker: vi.fn() };
    const page = make(TrackerPage, [{ provide: PlayApi, useValue: api }, { provide: CampaignStore, useValue: { id: signal('c1') } }, { provide: ContextService, useValue: {} }]) as Any;
    const ask = cancelled();
    await page.end();
    await page.remove();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(api.act).not.toHaveBeenCalled();
    expect(api.deleteTracker).not.toHaveBeenCalled();
  });

  it('edition change: no request is sent', async () => {
    const panel = make(EditionMigrationPanel, [{ provide: CampaignStore, useValue: { id: signal('c1'), campaign: signal({ ruleset: RULESET_IDS[0] }) } }]) as Any;
    const http = TestBed.inject(HttpTestingController);
    const ask = cancelled();
    await panel.apply();
    expect(ask).toHaveBeenCalled();
    http.expectNone(() => true);
    expect(panel.busy()).toBe(false);
  });
});

@Component({ selector: 'cn-guard-host', imports: [ConfirmDialog], template: `@if (confirm.request(); as req) {<cn-confirm-dialog [request]="req" />}` })
class Host {
  protected readonly confirm = inject(ConfirmService);
}

describe('unsaved-changes route guards (canLeave)', () => {
  const editors: [string, () => Any][] = [
    ['HomebrewEntityEditor', () => make(HomebrewEntityEditor, [{ provide: HomebrewApi, useValue: {} }, { provide: ContextService, useValue: { effectiveRulesetId: () => '2024' } }])],
    ['TemplateEditor', () => make(TemplateEditor, [{ provide: TemplateApi, useValue: {} }])],
  ];
  for (const [name, build] of editors) {
    const run = async (answer: 'Stay' | 'Leave' | 'Escape') => {
      const editor = build();
      const fixture = TestBed.createComponent(Host);
      document.body.append(fixture.nativeElement);
      fixture.detectChanges();
      expect(editor.canLeave()).toBe(true); // clean: no question
      editor.dirty.set(true);
      const result = editor.canLeave() as Promise<boolean>;
      expect(result).toBeInstanceOf(Promise);
      let state = 'pending';
      void result.then(() => (state = 'done'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      await settle();
      expect(state).toBe('pending');
      const dialog = document.querySelector('[role="alertdialog"]')!;
      expect(dialog.textContent).toContain('You have unsaved changes. Leave anyway?');
      if (answer === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else [...dialog.querySelectorAll('button')].find((b) => b.textContent === answer)!.click();
      return result;
    };
    it(`${name}: Stay resolves false`, async () => expect(await run('Stay')).toBe(false));
    it(`${name}: Escape resolves false`, async () => expect(await run('Escape')).toBe(false));
    it(`${name}: Leave resolves true`, async () => expect(await run('Leave')).toBe(true));
  }
});
