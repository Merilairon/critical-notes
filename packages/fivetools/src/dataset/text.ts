/** Plain-text extraction from entities for search indexing and previews. */
import { stripTags } from '../tags/tokenize';
import { isObject } from '../util/object';

const TEXT_KEYS = new Set([
  'entries', 'entry', 'items', 'headerEntries', 'footerEntries', 'rows', 'caption', 'colLabels',
  'trait', 'action', 'bonus', 'reaction', 'legendary', 'mythic', 'spellcasting', 'variant', 'lairActions', 'regionalEffects',
  'additionalEntries', 'entriesHigherLevel', 'by', 'text',
]);

const MAX_TEXT = 40_000;

/** Collects human-readable text from an entity's descriptive props (tags stripped). */
export function entityText(entity: Record<string, unknown>, maxLength = MAX_TEXT): string {
  const parts: string[] = [];
  let length = 0;
  const push = (s: string) => {
    if (length >= maxLength) return;
    const clean = stripTags(s).replace(/\s+/g, ' ').trim();
    if (!clean) return;
    parts.push(clean);
    length += clean.length + 1;
  };
  const visit = (value: unknown, inText: boolean) => {
    if (length >= maxLength) return;
    if (typeof value === 'string') {
      if (inText) push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, inText);
      return;
    }
    if (isObject(value)) {
      if (inText && typeof value.name === 'string') push(value.name);
      for (const [k, v] of Object.entries(value)) if (TEXT_KEYS.has(k)) visit(v, true);
    }
  };
  for (const [k, v] of Object.entries(entity)) if (TEXT_KEYS.has(k)) visit(v, true);
  return parts.join(' ').slice(0, maxLength);
}
