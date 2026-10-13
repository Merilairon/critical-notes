import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { parseDice } from '@cn/fivetools';
import { DiceService } from '../../core/dice.service';

/**
 * Clickable dice expression ({@dice}, {@damage}, {@hit}, …). Uses a single <ng-content> (content can only
 * be projected once), toggling button semantics when the expression is not rollable.
 */
@Component({
  selector: 'cn-roll',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span
    [class.cn-roll]="rollable()"
    [attr.role]="rollable() ? 'button' : null"
    [attr.tabindex]="rollable() ? 0 : null"
    [attr.title]="rollable() ? 'Roll ' + expr() : null"
    (click)="roll($event)"
    (keydown.enter)="roll($event)"
    (keydown.space)="roll($event)"
    ><ng-content
  /></span>`,
  host: { class: 'contents' },
})
export class Roll {
  readonly expr = input.required<string>();
  readonly label = input<string | undefined>();
  private readonly dice = inject(DiceService);
  protected readonly rollable = computed(() => !!parseDice(this.expr()));

  protected roll(event: Event) {
    if (!this.rollable()) return;
    event.preventDefault();
    event.stopPropagation();
    this.dice.roll(this.expr(), this.label());
  }
}
