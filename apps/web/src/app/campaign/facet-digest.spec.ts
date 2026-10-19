import { pcDigest } from './facet-digest';

describe('pcDigest', () => {
  it('summarises hit points, armour class and speed', () => {
    expect(pcDigest({ hpCurrent: 24, hpMax: 31, ac: 16, speed: 30 })).toBe('HP 24/31 · AC 16 · Speed 30 ft');
  });

  it('leaves out what is missing', () => {
    expect(pcDigest({ ac: 14 })).toBe('AC 14');
    expect(pcDigest({ hpMax: 10 })).toBe('HP ?/10');
    expect(pcDigest({})).toBe('');
    expect(pcDigest(null)).toBe('');
    expect(pcDigest({ ac: '16' })).toBe('');
  });
});
