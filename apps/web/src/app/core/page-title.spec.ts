import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, TitleStrategy, type Route } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { routes } from '../app.routes';
import { AppTitleStrategy, pageTitle } from './page-title';

@Component({ template: '' })
class Blank {}

describe('pageTitle', () => {
  it('joins the parts and ends with the app name once', () => {
    expect(pageTitle('Trash')).toBe('Trash — Critical Notes');
    expect(pageTitle('Bazaar', 'Lost Mine')).toBe('Bazaar — Lost Mine — Critical Notes');
    expect(pageTitle('Trash — Critical Notes', undefined, '')).toBe('Trash — Critical Notes');
    expect(pageTitle(undefined)).toBe('Critical Notes');
    expect(pageTitle('Critical Notes')).toBe('Critical Notes');
  });
});

describe('AppTitleStrategy', () => {
  it('adds the suffix to a route title, and leaves the title alone when a route has none', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'trash', component: Blank, title: 'Trash' },
          { path: 'campaigns', component: Blank, title: 'Campaigns — Critical Notes' },
          { path: 'own', component: Blank },
        ]),
        { provide: TitleStrategy, useExisting: AppTitleStrategy },
      ],
    });
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/trash');
    expect(document.title).toBe('Trash — Critical Notes');
    await router.navigateByUrl('/campaigns');
    expect(document.title).toBe('Campaigns — Critical Notes');
    document.title = 'Set by the component — Critical Notes';
    await router.navigateByUrl('/own');
    expect(document.title).toBe('Set by the component — Critical Notes');
  });
});

describe('route titles', () => {
  /** Routes without a static title set it themselves from loaded data (checked by hand in the browser). */
  const SETS_OWN_TITLE = [
    'c/:campaignId/trackers/:trackerId/view',
    'c/:campaignId/ (overview)',
    'c/:campaignId/p/:pageId',
    'reference/:kind',
    'reference/:kind/:uid',
    'c/:campaignId/reference/:kind',
    'c/:campaignId/reference/:kind/:uid',
    'templates/new/:kind',
    'templates/:templateId',
    'c/:campaignId/templates/new/:kind',
    'c/:campaignId/templates/:templateId',
    'homebrew/s/:sourceId',
    'homebrew/s/:sourceId/new/:type',
    'homebrew/e/:entityId',
  ];

  function leaves(list: Route[], prefix = ''): { path: string; title: boolean }[] {
    return list.flatMap((r) => {
      const path = [prefix, r.path].filter(Boolean).join('/');
      const kids = r.children ? leaves(r.children, path) : [];
      if (kids.length && !r.loadComponent) return kids;
      return [{ path: r.path === '' && prefix.endsWith(':campaignId') ? `${prefix}/ (overview)` : path, title: r.title !== undefined }, ...kids.filter((k) => k.path !== path)];
    });
  }

  it('every route has a title, or is on the list of pages that set their own', () => {
    const all = leaves(routes).filter((l) => l.path !== '' && l.path !== 'c/:campaignId');
    const missing = all.filter((l) => !l.title && !SETS_OWN_TITLE.includes(l.path)).map((l) => l.path);
    expect(missing).toEqual([]);
  });
});
