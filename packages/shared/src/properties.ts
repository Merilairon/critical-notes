import * as z from 'zod';
import { PAGE_TYPES, type PageSummaryDto, type PageType } from './pages';

export const PROPERTY_TYPES = ['text', 'number', 'select', 'multiselect', 'date', 'checkbox', 'pageLink', 'refLink', 'url'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const createPropertyInput = z.object({
  label: z.string().trim().min(1).max(60),
  type: z.enum(PROPERTY_TYPES),
  options: z.array(z.string().trim().min(1).max(60)).max(50).nullable().default(null),
  appliesTo: z.array(z.enum(PAGE_TYPES)).max(10).nullable().default(null),
  dmOnly: z.boolean().default(false),
  /** For refLink properties: reference kind (e.g. monster). */
  refKind: z.string().max(40).nullable().default(null),
});
export type CreatePropertyInput = z.input<typeof createPropertyInput>;

export const updatePropertyInput = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(50).nullable().optional(),
  appliesTo: z.array(z.enum(PAGE_TYPES)).max(10).nullable().optional(),
  dmOnly: z.boolean().optional(),
});
export type UpdatePropertyInput = z.input<typeof updatePropertyInput>;

export interface PropertyDefDto {
  id: string;
  key: string;
  label: string;
  type: PropertyType;
  options: string[] | null;
  appliesTo: PageType[] | null;
  dmOnly: boolean;
  refKind: string | null;
}

/** Validates a property value for a definition. Returns the normalized value or throws a message. */
export function normalizePropertyValue(def: Pick<PropertyDefDto, 'type' | 'options'>, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (def.type) {
    case 'text':
      return z.string().max(2000).parse(value);
    case 'url':
      return z.string().max(2048).regex(/^(https?:|mailto:)/i, 'Only http(s) and mailto links').parse(value);
    case 'number':
      return z.number().finite().parse(typeof value === 'string' ? Number(value) : value);
    case 'checkbox':
      return z.boolean().parse(value);
    case 'date':
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').parse(value);
    case 'select': {
      const v = z.string().max(60).parse(value);
      if (def.options && !def.options.includes(v)) throw new Error(`"${v}" is not one of the options`);
      return v;
    }
    case 'multiselect': {
      const arr = z.array(z.string().max(60)).max(50).parse(value);
      const bad = arr.filter((v) => def.options && !def.options.includes(v));
      if (bad.length) throw new Error(`Not an option: ${bad.join(', ')}`);
      return [...new Set(arr)];
    }
    case 'pageLink':
      return z.string().max(64).parse(value);
    case 'refLink':
      return z.string().max(300).parse(value);
    default:
      return null;
  }
}

export interface BacklinkDto extends PageSummaryDto {
  kinds: ('mention' | 'embed' | 'property')[];
}

export interface QueryRowDto extends PageSummaryDto {
  createdAt: number;
  tags: string[];
  facet: Record<string, unknown> | null;
  props: Record<string, unknown>;
}

export interface PageSearchHitDto {
  pageId: string;
  type: PageType;
  icon: string | null;
  title: string;
  snippet: string | null;
}

export interface UploadDto {
  id: string;
  url: string;
  mime: string;
  size: number;
  filename: string;
}
