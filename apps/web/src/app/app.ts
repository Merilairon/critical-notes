import { ChangeDetectionStrategy, Component, effect, HostListener, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { RULESET_IDS, type RulesetId } from '@cn/fivetools';
import { filter, map } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from './core/auth.service';
import { ContextService } from './core/context.service';
import { DiceService } from './core/dice.service';
import { ThemeService } from './core/theme.service';
import { HoverPreviewService } from './reference/render/hover-preview.service';
import { CommandPalette } from './shell/command-palette';
import { SourcesPanel } from './shell/sources-panel';

@Component({
  selector: 'cn-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommandPalette, SourcesPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  host: { class: 'flex h-dvh flex-col' },
})
export class App {
  protected readonly context = inject(ContextService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeService);
  protected readonly dice = inject(DiceService);
  private readonly preview = inject(HoverPreviewService);
  protected readonly rulesets = RULESET_IDS;

  protected readonly paletteOpen = signal(false);
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
  protected readonly toastVisible = signal(false);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.preview.close());
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
      event.preventDefault();
      this.paletteOpen.set(true);
    } else if (event.key === 'Escape') {
      this.preview.close();
    }
  }

  protected async logout() {
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
