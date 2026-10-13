import { Injectable, signal } from '@angular/core';
import { parseDice, rollDice, type DiceRoll } from '@cn/fivetools';

export interface RollLogEntry {
  id: number;
  label: string;
  roll: DiceRoll;
  at: Date;
}

const cryptoRandomInt = (max: number): number => {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  let v: number;
  do {
    globalThis.crypto.getRandomValues(buf);
    v = buf[0]!;
  } while (v >= limit);
  return 1 + (v % max);
};

@Injectable({ providedIn: 'root' })
export class DiceService {
  private nextId = 1;
  readonly log = signal<RollLogEntry[]>([]);
  readonly latest = signal<RollLogEntry | null>(null);

  roll(expr: string, label?: string): RollLogEntry | null {
    const parsed = parseDice(expr);
    if (!parsed) return null;
    const entry: RollLogEntry = { id: this.nextId++, label: label || expr, roll: rollDice(parsed, cryptoRandomInt), at: new Date() };
    this.log.update((l) => [entry, ...l].slice(0, 50));
    this.latest.set(entry);
    return entry;
  }

  clear() {
    this.log.set([]);
    this.latest.set(null);
  }
}
