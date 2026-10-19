import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AutosizeTitle, singleLine } from './autosize-title';

@Component({ imports: [AutosizeTitle], template: `<textarea rows="1" [cnAutosizeTitle]="text()" aria-label="Page title"></textarea>` })
class Host {
  readonly text = signal('A long title');
}

describe('AutosizeTitle', () => {
  it('turns line breaks into spaces', () => {
    expect(singleLine('a\nb\r\nc\n\nd')).toBe('a b c d');
    expect(singleLine('plain')).toBe('plain');
  });

  it('removes line breaks that are typed or pasted', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const area = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'one\ntwo';
    area.dispatchEvent(new Event('input'));
    expect(area.value).toBe('one two');
  });

  it('refuses the Enter key (a title is one line)', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const area = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    area.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('sets the height from the content', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    const area = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(area.style.height).toMatch(/px$/);
  });
});
