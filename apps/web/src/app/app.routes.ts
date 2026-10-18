import type { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { gmGuard } from './campaign/gm.guard';
import { adminGuard } from './admin/admin.guard';

const leaveGuard = (c: { canLeave(): boolean }) => c.canLeave();

const templateRoutes: Routes = [
  { path: '', loadComponent: () => import('./templates/template-library').then((m) => m.TemplateLibrary), title: 'Templates — Critical Notes' },
  { path: 'new/:kind', loadComponent: () => import('./templates/template-editor').then((m) => m.TemplateEditor), canDeactivate: [leaveGuard] },
  { path: ':templateId', loadComponent: () => import('./templates/template-editor').then((m) => m.TemplateEditor), canDeactivate: [leaveGuard] },
];

const referenceRoutes: Routes = [
  { path: '', loadComponent: () => import('./reference/reference-home').then((m) => m.ReferenceHome), title: 'Reference — Critical Notes' },
  { path: ':kind', loadComponent: () => import('./reference/reference-list').then((m) => m.ReferenceList) },
  { path: ':kind/:uid', loadComponent: () => import('./reference/entity-page').then((m) => m.EntityPage) },
];

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'campaigns' },
  { path: 'login', loadComponent: () => import('./auth/login').then((m) => m.Login), title: 'Sign in — Critical Notes' },
  { path: 'reset', loadComponent: () => import('./auth/reset').then((m) => m.ResetPage), title: 'Reset password — Critical Notes' },
  { path: 'setup', loadComponent: () => import('./auth/setup').then((m) => m.Setup), title: 'Welcome — Critical Notes' },
  { path: 'invite/:token', loadComponent: () => import('./invites/invite-page').then((m) => m.InvitePage), title: 'Invitation — Critical Notes' },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: 'campaigns', loadComponent: () => import('./campaigns/campaign-list').then((m) => m.CampaignList), title: 'Campaigns — Critical Notes' },
      { path: 'account', loadComponent: () => import('./account/account-page').then((m) => m.AccountPage), title: 'Account — Critical Notes' },
      { path: 'admin/users', loadComponent: () => import('./admin/users-page').then((m) => m.UsersPage), title: 'Users — Critical Notes', canActivate: [adminGuard] },
      { path: 'admin/backups', loadComponent: () => import('./admin/backups-page').then((m) => m.BackupsPage), title: 'Backups — Critical Notes', canActivate: [adminGuard] },
      { path: 'reference', children: referenceRoutes },
      { path: 'templates', children: templateRoutes },
      {
        path: 'homebrew',
        children: [
          { path: '', loadComponent: () => import('./homebrew/homebrew-home').then((m) => m.HomebrewHome), title: 'Homebrew — Critical Notes' },
          { path: 's/:sourceId', loadComponent: () => import('./homebrew/source-page').then((m) => m.HomebrewSourcePage) },
          {
            path: 's/:sourceId/new/:type',
            loadComponent: () => import('./homebrew/entity-editor').then((m) => m.HomebrewEntityEditor),
            canDeactivate: [leaveGuard],
          },
          { path: 'e/:entityId', loadComponent: () => import('./homebrew/entity-editor').then((m) => m.HomebrewEntityEditor), canDeactivate: [leaveGuard] },
        ],
      },
      // Full-screen player view for a second screen at the table (outside the campaign layout)
      { path: 'c/:campaignId/trackers/:trackerId/view', loadComponent: () => import('./play/tracker-player').then((m) => m.TrackerPlayerView) },
      {
        path: 'c/:campaignId',
        loadComponent: () => import('./campaign/campaign-shell').then((m) => m.CampaignShell),
        children: [
          { path: '', loadComponent: () => import('./campaign/views/overview').then((m) => m.CampaignOverview) },
          { path: 'npcs', loadComponent: () => import('./campaign/views/npcs').then((m) => m.NpcList), title: 'NPCs' },
          { path: 'locations', loadComponent: () => import('./campaign/views/locations').then((m) => m.LocationList), title: 'Locations' },
          { path: 'sessions', loadComponent: () => import('./campaign/views/sessions').then((m) => m.SessionLog), title: 'Sessions' },
          { path: 'quests', loadComponent: () => import('./campaign/views/quests').then((m) => m.QuestBoard), title: 'Quests' },
          { path: 'factions', loadComponent: () => import('./campaign/views/factions').then((m) => m.FactionList), title: 'Factions' },
          { path: 'party', loadComponent: () => import('./campaign/views/party').then((m) => m.Party), title: 'Party' },
          { path: 'encounters', loadComponent: () => import('./play/encounters-page').then((m) => m.EncountersPage), title: 'Encounters', canActivate: [gmGuard] },
          { path: 'encounters/:encounterId', loadComponent: () => import('./play/encounter-builder').then((m) => m.EncounterBuilder), title: 'Encounter', canActivate: [gmGuard] },
          { path: 'trackers/:trackerId', loadComponent: () => import('./play/tracker-page').then((m) => m.TrackerPage), title: 'Combat', canActivate: [gmGuard] },
          { path: 'inventory', loadComponent: () => import('./play/inventory-page').then((m) => m.InventoryPage), title: 'Inventory' },
          { path: 'settings', loadComponent: () => import('./campaign/settings').then((m) => m.CampaignSettings), title: 'Settings' },
          { path: 'p/:pageId', loadComponent: () => import('./campaign/page-editor').then((m) => m.PageEditor) },
          { path: 'reference', children: referenceRoutes },
          { path: 'templates', children: templateRoutes, canActivate: [gmGuard] },
          { path: 'trash', loadComponent: () => import('./campaign/trash').then((m) => m.CampaignTrash), title: 'Trash', canActivate: [gmGuard] },
        ],
      },
    ],
  },
  { path: '**', loadComponent: () => import('./shell/not-found').then((m) => m.NotFound), title: 'Not found — Critical Notes' },
];
