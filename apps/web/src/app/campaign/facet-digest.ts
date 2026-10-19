/** The one-line summary of a character sheet shown on the collapsed section: `HP 24/31 · AC 16 · Speed 30 ft`. Parts with no value are left out. */
export function pcDigest(facet: Record<string, unknown> | null | undefined): string {
  const f = facet ?? {};
  const num = (k: string): number | null => (typeof f[k] === 'number' ? (f[k] as number) : null);
  const parts: string[] = [];
  const [current, max] = [num('hpCurrent'), num('hpMax')];
  if (current !== null || max !== null) parts.push(`HP ${current ?? '?'}/${max ?? '?'}`);
  if (num('ac') !== null) parts.push(`AC ${num('ac')}`);
  if (num('speed') !== null) parts.push(`Speed ${num('speed')} ft`);
  return parts.join(' · ');
}
