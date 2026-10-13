import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'cn-not-found',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="mx-auto max-w-xl p-8 text-center">
    <h1 class="font-display text-2xl font-bold">Page not found</h1>
    <p class="mt-2 text-muted"><a class="cn-link" routerLink="/reference">Back to the reference</a></p>
  </div>`,
})
export class NotFound {}
