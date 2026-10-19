import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Roll } from './roll';

@Component({
  imports: [Roll],
  template: `<p><cn-roll expr="1d20+5">1d20+5</cn-roll> <cn-roll [standalone]="true" expr="1d6">🎲 roll 1d6</cn-roll> <cn-roll expr="not dice">x</cn-roll></p>`,
})
class Host {}

describe('Roll', () => {
  it('inline rolls are dotted text, standalone ones are buttons, bad expressions are plain', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const spans = [...(fixture.nativeElement as HTMLElement).querySelectorAll('cn-roll > span')];
    expect(spans[0]!.classList.contains('cn-roll')).toBe(true);
    expect(spans[0]!.classList.contains('cn-roll-btn')).toBe(false);
    expect(spans[1]!.classList.contains('cn-roll-btn')).toBe(true);
    expect(spans[2]!.classList.contains('cn-roll')).toBe(false);
    expect(spans[2]!.classList.contains('cn-roll-btn')).toBe(false);
  });
});
