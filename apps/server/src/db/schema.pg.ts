/**
 * The Postgres mirror of the app database schema (`schema.ts` is the source of truth). Same tables, columns,
 * keys and indexes; booleans are `boolean`, JSON is `jsonb`, epoch-millisecond timestamps are `bigint`.
 * `test/pg-parity.test.ts` keeps the two in step: change both together, then `pnpm db:generate`.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey();
const createdAt = () => bigint('created_at', { mode: 'number' }).notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`);
const updatedAt = () => bigint('updated_at', { mode: 'number' }).notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`);

// region Users & sessions

export const users = pgTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  /** Set when an admin disables the account (epoch ms); null = enabled. */
  disabledAt: bigint('disabled_at', { mode: 'number' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the session token (the token itself only lives in the cookie). */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

// endregion

// region Campaigns

export const campaigns = pgTable('campaigns', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** '2014' | '2024' — immutable except through the "migrate edition" flow. */
  ruleset: text('ruleset').notNull(),
  crossEdition: boolean('cross_edition').notNull().default(false),
  houseRules: jsonb('house_rules'),
  coverImage: text('cover_image'),
  status: text('status').notNull().default('active'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const campaignMembers = pgTable(
  'campaign_members',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'dm' | 'player' */
    role: text('role').notNull(),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.userId] }), index('members_user').on(t.userId)],
);

export const campaignSourceOverrides = pgTable(
  'campaign_source_overrides',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    /** Lower-cased source id (official abbreviation or homebrew json id). */
    sourceId: text('source_id').notNull(),
    enabled: boolean('enabled').notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.sourceId] })],
);

// endregion

// region Pages & facets

export const pages = pgTable(
  'pages',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => pages.id, { onDelete: 'set null' }),
    /** Fractional index among siblings. */
    sortKey: text('sort_key').notNull(),
    /** generic | npc | location | session | quest | faction | item | lore | handout | pc */
    type: text('type').notNull().default('generic'),
    title: text('title').notNull(),
    icon: text('icon'),
    cover: text('cover'),
    /** dm | all | selected */
    visibility: text('visibility').notNull().default('dm'),
    body: jsonb('body'),
    revision: integer('revision').notNull().default(1),
    /** The page template this page was created from (and its version then). */
    fromTemplateId: text('from_template_id'),
    fromTemplateVersion: integer('from_template_version'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('pages_campaign_parent').on(t.campaignId, t.parentId), index('pages_campaign_type').on(t.campaignId, t.type)],
);

export const pageTags = pgTable(
  'page_tags',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.tag] }), index('page_tags_tag').on(t.tag)],
);

export const pageViewers = pgTable(
  'page_viewers',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.userId] })],
);

const facetPageId = () =>
  text('page_id')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' });
const pageRef = (name: string) => text(name).references((): AnyPgColumn => pages.id, { onDelete: 'set null' });

export const npcFacets = pgTable('npc_facets', {
  pageId: facetPageId(),
  statblockUid: text('statblock_uid'),
  statblockHomebrewEntityId: text('statblock_homebrew_entity_id'),
  factionPageId: pageRef('faction_page_id'),
  locationPageId: pageRef('location_page_id'),
  status: text('status').notNull().default('alive'),
  attitude: text('attitude').notNull().default('neutral'),
  role: text('role').notNull().default(''),
});

export const locationFacets = pgTable('location_facets', {
  pageId: facetPageId(),
  parentLocationPageId: pageRef('parent_location_page_id'),
  kind: text('kind').notNull().default('site'),
  mapImage: text('map_image'),
});

export const sessionFacets = pgTable('session_facets', {
  pageId: facetPageId(),
  number: integer('number'),
  date: text('date'),
  status: text('status').notNull().default('planned'),
  summary: text('summary').notNull().default(''),
});

export const questFacets = pgTable('quest_facets', {
  pageId: facetPageId(),
  status: text('status').notNull().default('rumor'),
  giverPageId: pageRef('giver_page_id'),
  priority: text('priority').notNull().default('normal'),
});

export const factionFacets = pgTable('faction_facets', {
  pageId: facetPageId(),
  status: text('status').notNull().default('active'),
  attitude: text('attitude').notNull().default('neutral'),
  headquartersPageId: pageRef('headquarters_page_id'),
});

export const characterFacets = pgTable('character_facets', {
  pageId: facetPageId(),
  playerUserId: text('player_user_id').references(() => users.id, { onDelete: 'set null' }),
  playerName: text('player_name').notNull().default(''),
  classes: jsonb('classes').notNull().default(sql`'[]'::jsonb`),
  speciesUid: text('species_uid'),
  backgroundUid: text('background_uid'),
  hpMax: integer('hp_max'),
  hpCurrent: integer('hp_current'),
  hpTemp: integer('hp_temp').notNull().default(0),
  ac: integer('ac'),
  speed: integer('speed'),
  abilities: jsonb('abilities'),
  passivePerception: integer('passive_perception'),
  inspiration: boolean('inspiration').notNull().default(false),
});

export const itemFacets = pgTable('item_facets', {
  pageId: facetPageId(),
  itemUid: text('item_uid'),
  itemHomebrewEntityId: text('item_homebrew_entity_id'),
});

// endregion

// region Homebrew

export const homebrewSources = pgTable(
  'homebrew_sources',
  {
    id: id(),
    /** 5etools `_meta.sources[].json` key; unique across official and homebrew sources. */
    jsonId: text('json_id').notNull(),
    jsonIdLower: text('json_id_lower').notNull().unique(),
    abbreviation: text('abbreviation').notNull(),
    fullName: text('full_name').notNull(),
    authors: jsonb('authors').notNull().default(sql`'[]'::jsonb`),
    version: text('version').notNull().default('1.0.0'),
    /** '2014' | '2024' | 'any' */
    edition: text('edition').notNull(),
    color: text('color'),
    url: text('url'),
    metaExtra: jsonb('meta_extra'),
    /** private | campaigns | instance | campaign (auto-created campaign-only source) */
    scope: text('scope').notNull().default('private'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('homebrew_sources_campaign').on(t.campaignId)],
);

export const homebrewSourceShares = pgTable(
  'homebrew_source_shares',
  {
    sourceId: text('source_id')
      .notNull()
      .references(() => homebrewSources.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.campaignId] })],
);

export const homebrewEntities = pgTable(
  'homebrew_entities',
  {
    id: id(),
    sourceId: text('source_id')
      .notNull()
      .references(() => homebrewSources.id, { onDelete: 'cascade' }),
    /** 5etools prop: monster, spell, item, baseitem, race, subrace, background, feat, … */
    entityType: text('entity_type').notNull(),
    name: text('name').notNull(),
    nameLower: text('name_lower').notNull(),
    /** Raw 5etools-format entity (may contain `_copy`). */
    data: jsonb('data').notNull(),
    fluff: jsonb('fluff'),
    currentRevision: integer('current_revision').notNull().default(1),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [
    index('homebrew_entities_source').on(t.sourceId),
    uniqueIndex('homebrew_entities_unique_live')
      .on(t.sourceId, t.entityType, t.nameLower)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const homebrewRevisions = pgTable(
  'homebrew_revisions',
  {
    id: id(),
    entityId: text('entity_id')
      .notNull()
      .references(() => homebrewEntities.id, { onDelete: 'cascade' }),
    revNo: integer('rev_no').notNull(),
    data: jsonb('data').notNull(),
    fluff: jsonb('fluff'),
    /** RFC 6902 patch from the previous revision (null for the first). */
    diff: jsonb('diff'),
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    message: text('message'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('homebrew_revisions_entity_rev').on(t.entityId, t.revNo)],
);

// endregion

// region Links, properties, uploads (milestone d)

/** Derived on page save: `[[links]]`, page embeds and page-link property values. Powers backlinks. */
export const pageLinks = pgTable(
  'page_links',
  {
    fromPageId: text('from_page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    toPageId: text('to_page_id').notNull(),
    /** mention | embed | property */
    kind: text('kind').notNull(),
  },
  (t) => [primaryKey({ columns: [t.fromPageId, t.toPageId, t.kind] }), index('page_links_to').on(t.toPageId)],
);

/** Derived: which reference/homebrew entities a page uses (for "used in" lists before deleting homebrew). */
export const entityReferences = pgTable(
  'entity_references',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    uid: text('uid').notNull(),
    /** tag | embed | facet */
    via: text('via').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.uid, t.via] }), index('entity_references_uid').on(t.uid)],
);

export const propertyDefs = pgTable(
  'property_defs',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** text | number | select | multiselect | date | checkbox | pageLink | refLink | url */
    type: text('type').notNull(),
    options: jsonb('options'),
    /** Page types this property applies to (null = all). */
    appliesTo: jsonb('applies_to'),
    dmOnly: boolean('dm_only').notNull().default(false),
    refKind: text('ref_kind'),
    sortKey: text('sort_key').notNull().default('a0'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('property_defs_key').on(t.campaignId, t.key)],
);

export const pagePropertyValues = pgTable(
  'page_property_values',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    defId: text('def_id')
      .notNull()
      .references(() => propertyDefs.id, { onDelete: 'cascade' }),
    value: jsonb('value'),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.defId] }), index('ppv_def').on(t.defId)],
);

export const uploads = pgTable(
  'uploads',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: createdAt(),
  },
  (t) => [index('uploads_campaign').on(t.campaignId)],
);

// endregion

// region Templates (milestone f)

/** Block and page templates. `definition` holds the kind-specific part (see @cn/templates). */
export const templates = pgTable(
  'templates',
  {
    id: id(),
    /** block | page */
    kind: text('kind').notNull(),
    /** global (built-in, read-only) | user | campaign */
    scope: text('scope').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    builtinKey: text('builtin_key').unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon'),
    tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),
    version: integer('version').notNull().default(1),
    schemaVersion: integer('schema_version').notNull().default(1),
    definition: jsonb('definition').notNull(),
    duplicatedFromId: text('duplicated_from_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('templates_owner').on(t.scope, t.ownerUserId), index('templates_campaign').on(t.campaignId)],
);

/** Every saved version of a template (linked instances re-render from the current one). */
export const templateVersions = pgTable(
  'template_versions',
  {
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
);

/** Where templates are used: linked block instances (derived on page save) and pages created from a page template. */
export const templateUsage = pgTable(
  'template_usage',
  {
    templateId: text('template_id').notNull(),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** Block id of a linked instance; '' for a page created from the template. */
    blockId: text('block_id').notNull(),
    version: integer('version').notNull(),
    /** linked | page */
    mode: text('mode').notNull(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.pageId, t.blockId] }), index('template_usage_page').on(t.pageId)],
);

/** The page template a campaign uses by default for new pages of a type. */
export const campaignTemplateDefaults = pgTable(
  'campaign_template_defaults',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    pageType: text('page_type').notNull(),
    templateId: text('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.pageType] })],
);

// endregion

// region Encounters, initiative, inventory (milestone g)

export const encounters = pgTable(
  'encounters',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    notes: text('notes').notNull().default(''),
    locationPageId: text('location_page_id'),
    /** [{ id, kind: monster|npc|custom, uid, pageId, name, count, lair, hidden, xp, hp, ac }] */
    creatures: jsonb('creatures').notNull().default(sql`'[]'::jsonb`),
    /** { mode: campaign|custom, levels } */
    party: jsonb('party').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => [index('encounters_campaign').on(t.campaignId)],
);

/** A running (or finished) combat. `state` is the tracker state (@cn/shared tracker). */
export const trackers = pgTable(
  'trackers',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    encounterId: text('encounter_id').references(() => encounters.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** active | ended */
    status: text('status').notNull().default('active'),
    state: jsonb('state').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('trackers_campaign').on(t.campaignId)],
);

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    /** Player character page; null for the party stash. */
    ownerPageId: text('owner_page_id').references(() => pages.id, { onDelete: 'set null' }),
    itemUid: text('item_uid'),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull().default(1),
    attuned: boolean('attuned').notNull().default(false),
    identified: boolean('identified').notNull().default(true),
    sessionPageId: text('session_page_id').references(() => pages.id, { onDelete: 'set null' }),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('inventory_campaign_owner').on(t.campaignId, t.ownerPageId)],
);

/** Coins per owner: "party" or a player character page id. */
export const currencies = pgTable(
  'currencies',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    ownerKey: text('owner_key').notNull(),
    cp: integer('cp').notNull().default(0),
    sp: integer('sp').notNull().default(0),
    ep: integer('ep').notNull().default(0),
    gp: integer('gp').notNull().default(0),
    pp: integer('pp').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.ownerKey] })],
);

/** Loot blocks already awarded (so the same loot is not handed out twice by accident). */
export const lootAwards = pgTable(
  'loot_awards',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    toKey: text('to_key').notNull(),
    awardedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.blockId] })],
);

// endregion

// region Members, invites, migrations (milestone h)

/** Invite links. Only a hash of the token is stored; the link itself is shown once. */
export const campaignInvites = pgTable(
  'campaign_invites',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** player | codm */
    role: text('role').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => [index('campaign_invites_campaign').on(t.campaignId)],
);

/** Log of edition migrations (what was mapped, by whom). */
export const campaignMigrations = pgTable(
  'campaign_migrations',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    fromRuleset: text('from_ruleset').notNull(),
    toRuleset: text('to_ruleset').notNull(),
    report: jsonb('report').notNull(),
    changed: integer('changed').notNull(),
    byUserId: text('by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('campaign_migrations_campaign').on(t.campaignId)],
);

// endregion

// region API tokens (MCP)

/** Personal access tokens for AI assistants (the /mcp endpoint). Only a hash is stored; the token is shown once. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** read | write */
    scope: text('scope').notNull(),
    createdAt: createdAt(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => [index('api_tokens_user').on(t.userId)],
);

/** Single-use password reset links. Only a hash of the token is stored; `usedAt` is set when consumed or superseded. */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Null when created from the command line. */
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    usedAt: bigint('used_at', { mode: 'number' }),
  },
  (t) => [index('password_resets_user').on(t.userId)],
);

// endregion
