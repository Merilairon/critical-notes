import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { requestError } from './http.interceptor';

const tooMany = (retryAfter?: string) => new HttpErrorResponse({ status: 429, headers: new HttpHeaders(retryAfter ? { 'Retry-After': retryAfter } : {}), error: { error: 'x' } });

describe('requestError', () => {
  it('adds a retry hint to a 429', () => {
    expect(requestError(tooMany('42'))).toBe('Too many attempts. Try again in 42 s.');
    expect(requestError(tooMany('120'))).toBe('Too many attempts. Try again in 2 min.');
    expect(requestError(tooMany())).toBe('Too many attempts. Try again in a minute.');
  });

  it('passes other errors through errorMessage', () => {
    expect(requestError(new HttpErrorResponse({ status: 409, error: { error: 'Nope' } }))).toBe('Nope');
  });
});
