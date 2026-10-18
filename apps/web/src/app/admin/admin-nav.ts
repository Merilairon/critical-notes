import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Sections of the admin area. Backups is reached from here, not from the (already full) header. */
@Component({
  selector: 'cn-admin-nav',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<nav aria-label="Admin sections" class="mt-2 flex gap-2 text-sm">
    <a routerLink="/admin/users" class="rounded border px-3 py-1 font-medium" [class]="cls('users')" [attr.aria-current]="current() === 'users' ? 'page' : null">Users</a>
    <a routerLink="/admin/backups" class="rounded border px-3 py-1 font-medium" [class]="cls('backups')" [attr.aria-current]="current() === 'backups' ? 'page' : null">Backups</a>
  </nav>`,
})
export class AdminNav {
  readonly current = input.required<'users' | 'backups'>();
  protected cls(which: string) {
    return this.current() === which ? 'border-accent bg-panel-2 text-ink' : 'border-line text-muted hover:text-ink';
  }
}
