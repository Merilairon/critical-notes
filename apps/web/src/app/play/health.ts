import type { HealthWord } from '@cn/shared';

const LABELS: Record<HealthWord, string> = { healthy: 'Unhurt', wounded: 'Wounded', bloodied: 'Bloodied', down: 'Down' };

export function healthWordLabel(word: HealthWord | null): string {
  return word ? LABELS[word] : '';
}
