import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { UserDto } from '@cn/shared';
import { App } from './app';
import { AuthService } from './core/auth.service';

function header(user: UserDto | null) {
  TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user: signal(user) } }] });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}
const usersLink = (el: HTMLElement) => el.querySelector('a[href="/admin/users"]');

describe('header', () => {
  it('shows the Users link to admins only', () => {
    expect(usersLink(header({ id: 'a', username: 'a', displayName: 'A', isAdmin: true }))?.textContent?.trim()).toBe('Users');
    TestBed.resetTestingModule();
    expect(usersLink(header({ id: 'p', username: 'p', displayName: 'P', isAdmin: false }))).toBeNull();
    TestBed.resetTestingModule();
    expect(usersLink(header(null))).toBeNull();
  });
});
