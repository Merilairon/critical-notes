import { uuidv7 } from 'uuidv7';

/** Time-ordered random id (UUIDv7). */
export function newId(): string {
  return uuidv7();
}
