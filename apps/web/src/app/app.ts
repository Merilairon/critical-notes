import type { ElementRef } from '@angular/core';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NavigationEnd, NavigationStart, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { RULESET_IDS, type RulesetId } from '@cn/fivetools';
import { filter, map } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from './core/auth.service';
import { ContextService } from './core/context.service';
import { DiceService } from './core/dice.service';
import { LayoutService } from './core/layout.service';
import { ThemeService } from './core/theme.service';
import { HoverPreviewService } from './reference/render/hover-preview.service';
import { ConfirmService } from './core/confirm.service';
import { CommandPalette } from './shell/command-palette';
import { ConfirmDialog } from './shell/confirm-dialog';
import { SourcesPanel } from './shell/sources-panel';

@Component({
  selector: 'cn-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommandPalette, ConfirmDialog, SourcesPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  host: { class: 'flex h-dvh flex-col' },
})
export class App {
  protected readonly context = inject(ContextService);
  protected readonly auth = inject(AuthService);
  protected readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeService);
  protected readonly dice = inject(DiceService);
  private readonly preview = inject(HoverPreviewService);
  protected readonly rulesets = RULESET_IDS;
  protected readonly layout = inject(LayoutService);
  private readonly injector = inject(Injector);

  /** One list for the inline nav (lg and up) and the app menu (below lg), so the two cannot drift. */
  private readonly allNavLinks = [
    { label: 'Campaigns', path: '/campaigns', adminOnly: false },
    { label: 'Reference', path: '/reference', adminOnly: false },
    { label: 'Homebrew', path: '/homebrew', adminOnly: false },
    { label: 'Templates', path: '/templates', adminOnly: false },
    { label: 'Users', path: '/admin/users', adminOnly: true },
  ];
  /** The links everyone sees, plus Users for admins (the inline nav). */
  protected readonly navLinks = computed(() =>
    this.allNavLinks.filter((l) => !l.adminOnly || this.auth.user()?.isAdmin),
  );
  /** The app menu lists the person's links and the admin pages in their own group. */
  protected readonly menuLinks = computed(() => this.allNavLinks.filter((l) => !l.adminOnly));
  protected readonly adminLinks = computed(() =>
    this.auth.user()?.isAdmin
      ? [...this.allNavLinks.filter((l) => l.adminOnly), { label: 'Backups', path: '/admin/backups', adminOnly: true }]
      : [],
  );

  protected readonly paletteOpen = signal(false);
  /** The skip link: move focus to <main> without touching the URL (a plain "#main" would be resolved against the router's base). */
  protected skipToMain(event: Event) {
    event.preventDefault();
    document.getElementById('main')?.focus();
  }

  /** Screens meant for the table (the tracker's player view) show no app chrome. */
  protected readonly bare = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => /^\/c\/[^/]+\/trackers\/[^/]+\/view/.test(e.urlAfterRedirects)),
    ),
    { initialValue: false },
  );
  protected readonly sourcesOpen = signal(false);
  protected readonly diceLogOpen = signal(false);
  protected readonly menuOpen = signal(false);
  private readonly header = viewChild<ElementRef<HTMLElement>>('appHeader');
  private readonly menuBtn = viewChild<ElementRef<HTMLElement>>('menuBtn');
  private readonly diceBtn = viewChild<ElementRef<HTMLElement>>('diceBtn');
  private readonly drawerBtn = viewChild<ElementRef<HTMLElement>>('drawerBtn');
  protected readonly toastVisible = signal(false);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** Polite status text for a page that has no heading to focus (the page title). */
  protected readonly announcement = signal('');
  private lastPath: string | undefined;
  private focusBefore: Element | null = null;
  private focusObserver: MutationObserver | undefined;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * SPA focus management: after a real page change focus moves to the main heading (or <main>), so keyboard and
   * screen-reader users start at the new page. Not on the first load, not for query or fragment changes on the same
   * path, not on bare screens, and not when the new page already placed focus itself.
   */
  private focusNewPage(url: string, bare: boolean) {
    const path = url.split(/[?#]/)[0];
    const previous = this.lastPath;
    this.lastPath = path;
    this.focusObserver?.disconnect();
    clearTimeout(this.focusTimer);
    if (previous === undefined || previous === path || bare) return;
    const main = document.getElementById('main');
    if (!main) return;
    const start = this.focusBefore;
    const settle = () => {
      this.focusObserver?.disconnect();
      clearTimeout(this.focusTimer);
      const active = document.activeElement;
      // The page (or the user) moved focus on purpose: leave it
      // (the drawer button gets focus back when the drawer closes after a tap on a link: that is not the page's choice)
      if (active && active !== document.body && active !== start && active !== this.drawerBtn()?.nativeElement) return;
      // Never pull focus out of a field the person is typing in
      if (active instanceof HTMLElement && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
      const heading = main.querySelector<HTMLElement>('h1');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: false });
      } else {
        main.focus();
        this.announcement.set('');
        afterNextRender(() => this.announcement.set(document.title.replace(/ — Critical Notes$/, '') || document.title), { injector: this.injector });
      }
    };
    // Lazy routes and data load after NavigationEnd: wait for an h1, but not longer than 1.5 s
    afterNextRender(
      () => {
        if (main.querySelector('h1')) return settle();
        this.focusObserver = new MutationObserver(() => {
          if (main.querySelector('h1')) settle();
        });
        this.focusObserver.observe(main, { childList: true, subtree: true });
        this.focusTimer = setTimeout(settle, 1500);
      },
      { injector: this.injector },
    );
  }

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationStart)).subscribe(() => {
      this.focusBefore = document.activeElement;
    });
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => {
      this.preview.close();
      this.closePopovers(false);
      this.focusNewPage(e.urlAfterRedirects, this.bare());
    });
    // The drawer takes over: close the header popovers when it opens; on close focus returns to the header's menu button
    // (the header is un-inerted first, so wait for the next render)
    // A menu left open when the window grows past lg would leave its invisible backdrop behind
    effect(() => {
      if (!this.layout.compact()) untracked(() => this.closePopovers(false));
    });
    let drawerWasOpen = false;
    effect(() => {
      const open = this.layout.drawerOpen();
      untracked(() => {
        if (open) this.closePopovers(false);
        else if (drawerWasOpen)
          afterNextRender(() => this.drawerBtn()?.nativeElement.focus(), { injector: this.injector });
        drawerWasOpen = open;
      });
    });
    effect(() => {
      if (!this.dice.latest()) return;
      this.toastVisible.set(true);
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.toastVisible.set(false), 4000);
    });
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && this.auth.user()) {
      // Always swallow the shortcut (Firefox would focus its location-bar search), but only open the palette when no dialog is up.
      event.preventDefault();
      if (this.confirm.request()) return;
      this.paletteOpen.set(true);
    } else if (event.key === 'Escape' && !event.defaultPrevented) {
      this.preview.close();
    }
  }

  protected toggleMenu() {
    const open = !this.menuOpen();
    this.diceLogOpen.set(false);
    this.menuOpen.set(open);
    if (open)
      afterNextRender(
        () =>
          this.header()
            ?.nativeElement.querySelector<HTMLElement>('#app-menu a, #app-menu button, #app-menu select')
            ?.focus(),
        { injector: this.injector },
      );
  }

  protected toggleDiceLog() {
    this.menuOpen.set(false);
    this.diceLogOpen.update((v) => !v);
  }

  /** Close the menu and the dice log. With `restoreFocus`, focus goes back to the button that opened it. */
  protected closePopovers(restoreFocus: boolean) {
    const target = this.menuOpen() ? this.menuBtn() : this.diceLogOpen() ? this.diceBtn() : undefined;
    this.menuOpen.set(false);
    this.diceLogOpen.set(false);
    if (restoreFocus) target?.nativeElement.focus();
  }

  /**
   * Focus left the header: close only when it went to a real element outside it. A null target (native pickers,
   * taps on non-focusable areas) never closes; the backdrop handles those taps.
   */
  protected onHeaderFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || this.header()?.nativeElement.contains(next)) return;
    this.menuOpen.set(false);
    // The dice log stays open when focus goes to a roll target, and from lg it is non-modal
    const roll = next instanceof Element && !!next.closest('.cn-roll');
    if (this.layout.compact() && !roll) this.diceLogOpen.set(false);
  }

  private sourcesFromMenu = false;

  protected openSources() {
    this.closePopovers(false);
    this.sourcesFromMenu = true;
    this.sourcesOpen.set(true);
  }

  /** Closing the Sources panel opened from the menu returns focus to the Menu button (not BODY). */
  protected closeSources() {
    this.sourcesOpen.set(false);
    if (this.sourcesFromMenu) {
      this.sourcesFromMenu = false;
      afterNextRender(() => this.menuBtn()?.nativeElement.focus(), { injector: this.injector });
    }
  }

  /**
   * Below lg a tap outside the header closes the dice log. A dice roll target passes through (it must roll and keep the
   * log open); from lg the log is non-modal and stays until closed.
   */
  @HostListener('document:pointerdown', ['$event'])
  protected onPointerDown(event: PointerEvent) {
    if (!this.diceLogOpen() || !this.layout.compact()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (this.header()?.nativeElement.contains(target) || target.closest('.cn-roll')) return;
    this.diceLogOpen.set(false);
  }

  protected async logout() {
    this.closePopovers(false);
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }

  protected setRuleset(id: string) {
    if ((RULESET_IDS as readonly string[]).includes(id)) this.context.rulesetId.set(id as RulesetId);
  }

  protected themeIcon(): string {
    const mode = this.theme.mode();
    return mode === 'dark' ? '☾' : mode === 'light' ? '☀' : '◐';
  }
}
