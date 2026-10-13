/** Reference API payloads (`/api/reference/*`). */
import type { EditionBadge, EditionOrAny, EntityKind, SourceInfo } from '@cn/fivetools';

export interface SourceDto extends SourceInfo {
  origin: 'official' | 'homebrew';
  entityCount: number;
}

export interface KindCountDto {
  kind: EntityKind;
  label: string;
  count: number;
}

export interface ListItemDto {
  uid: string;
  name: string;
  source: string;
  page: string | null;
  edition: EditionOrAny;
  badge: EditionBadge;
  summary: Record<string, unknown>;
  hasImage: boolean;
  hasToken: boolean;
  origin: 'official' | 'homebrew';
  /** Other members of the reprint group hidden from this list. */
  alsoPrintedAs: string[];
}

export interface ReprintMemberDto {
  uid: string;
  name: string;
  source: string;
  edition: EditionOrAny;
  visible: boolean;
}

export interface RelatedEntityDto {
  uid: string;
  kind: string;
  name: string;
  source: string;
  data: Record<string, unknown>;
}

export interface EntityDto {
  uid: string;
  kind: EntityKind;
  name: string;
  source: string;
  sourceInfo: SourceDto | null;
  page: string | null;
  edition: EditionOrAny;
  badge: EditionBadge;
  visible: boolean;
  origin: 'official' | 'homebrew';
  homebrewEntityId: string | null;
  /** 5etools data prop the entity came from (`baseitem`, `item`, `monster`, …). */
  prop?: string;
  /** Soft-deleted homebrew: still shown where it is referenced, with a "deleted" badge. */
  deleted?: boolean;
  data: Record<string, unknown>;
  raw: Record<string, unknown> | null;
  fluff: Record<string, unknown> | null;
  imagePath: string | null;
  tokenPath: string | null;
  summary: Record<string, unknown>;
  generatedFrom: string | null;
  reprintedAs: { uid: string; exists: boolean }[];
  reprintGroup: ReprintMemberDto[];
  /** uid this campaign lists for the entity's reprint group (may be the entity itself). */
  preferredUid: string;
  /** For classes/subclasses: resolved feature entities (and subclasses), by uid. */
  related?: Record<string, RelatedEntityDto>;
}

export interface SearchHitDto {
  uid: string;
  kind: EntityKind;
  name: string;
  source: string;
  edition: EditionOrAny;
  badge: EditionBadge;
  summary: Record<string, unknown>;
  snippet: string | null;
}
