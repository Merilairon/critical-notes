import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { Inline } from './inline';

function render(text: string): HTMLElement {
  TestBed.configureTestingModule({ imports: [Inline], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Inline);
  fixture.componentRef.setInput('text', text);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('Inline renderer', () => {
  it('renders entity links, rolls and formatting', () => {
    const el = render('Cast {@spell fireball|xphb|Fireball} for {@damage 8d6} {@b fire} damage');
    const link = el.querySelector('a.cn-link')!;
    expect(link.textContent).toBe('Fireball');
    expect(link.getAttribute('href')).toBe('/reference/spell/spell:fireball%7Cxphb');
    expect(el.querySelector('.cn-roll')!.textContent).toBe('8d6');
    expect(el.querySelector('.cn-s-bold')!.textContent).toBe('fire');
    expect(el.textContent).toBe('Cast Fireball for 8d6 fire damage');
  });

  it('treats markup-looking text as text (no HTML injection)', () => {
    const el = render('<img src=x onerror=alert(1)> {@b <script>alert(1)</script>}');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('drops unsafe links but keeps their text', () => {
    const el = render('{@link click me|javascript:alert(1)}');
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toBe('click me');
  });
});
