import { describe, expect, it } from 'vitest';
import { path } from '../src/mcp/api';

describe('mcp api path helper', () => {
  it('encodes values', () => {
    expect(path`/campaigns/${'a b/c'}/pages/${7}`).toBe('/campaigns/a%20b%2Fc/pages/7');
  });
  it('rejects dot segments in any position', () => {
    for (const bad of ['.', '..']) {
      expect(() => path`/campaigns/${bad}`).toThrow('Invalid id');
      expect(() => path`/campaigns/${'ok'}/pages/${bad}/x`).toThrow('Invalid id');
    }
    expect(path`/x/${'..a'}/${'a.b'}`).toBe('/x/..a/a.b');
  });
});
