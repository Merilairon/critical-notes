/**
 * 5etools homebrew schema validation (the `brew-fast` schemas shipped in the MIT-licensed `5etools-utils`
 * package), set up the way 5etools' own tester does (`UtilAjv`). Compiled once, on first use.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { homebrewEditionToMeta } from '@cn/fivetools';
import type { HomebrewEdition, HomebrewIssue } from '@cn/shared';

// ajv-formats ships CommonJS with a default export
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

/** Schemas that 5etools references by URL (Foundry scene data). Stubbed so validation never goes online. */
const REMOTE_STUBS = ['https://raw.githubusercontent.com/TheGiddyLimit/plutonium-scenes/main/test/schema/shared.json'];

const MAX_ISSUES = 12;

export function schemaDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('5etools-utils/package.json')), 'schema', 'brew-fast');
}

function listJson(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? listJson(p) : d.name.endsWith('.json') ? [p] : [];
  });
}

let compiled: ValidateFunction | null = null;

function createAjv() {
  const ajv = new Ajv2020({ allowUnionTypes: true, strict: false, allErrors: false });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'version', validate: false } as never);
  ajv.addKeyword({ keyword: 'markdownDescription', validate: false } as never);
  ajv.addFormat('date', { validate: (s: string) => /^\d\d\d\d-\d\d-\d\d$/.test(s) });
  // Like 5etools: floating-point safe multipleOf (0.1 steps on weights, etc.)
  ajv.removeKeyword('multipleOf');
  ajv.addKeyword({
    keyword: 'multipleOf',
    type: 'number',
    errors: false,
    metaSchema: { type: 'number' },
    compile: (factor: number) => (data: number) => {
      const q = data / factor;
      return Math.abs(q - Math.round(q)) < 1e-9;
    },
  });
  return ajv;
}

/** The compiled validator for a whole homebrew document. */
export function homebrewValidator(): ValidateFunction {
  if (compiled) return compiled;
  const dir = schemaDir();
  const ajv = createAjv();
  for (const file of listJson(dir)) {
    const id = relative(dir, file).replace(/\\/g, '/');
    ajv.addSchema(JSON.parse(readFileSync(file, 'utf8')) as object, id);
  }
  for (const url of REMOTE_STUBS) ajv.addSchema({ $defs: { lightArray: {}, wallArray: {} } }, url);
  compiled = ajv.getSchema('homebrew.json') ?? null;
  if (!compiled) throw new Error('5etools homebrew schema not found');
  return compiled;
}

export const editionToMeta = (edition: HomebrewEdition) => homebrewEditionToMeta(edition);

export interface MetaSource {
  json: string;
  abbreviation: string;
  full: string;
  authors: string[];
  version: string;
  url?: string;
  color?: string;
}

export function syntheticMeta(source: MetaSource, edition: HomebrewEdition) {
  return {
    sources: [{ ...source, authors: source.authors.length ? source.authors : ['Unknown'], convertedBy: source.authors.length ? source.authors : ['Unknown'] }],
    dateAdded: 0,
    dateLastModified: 0,
    edition: editionToMeta(edition),
  };
}

/** Validates a full homebrew document. Paths are returned as written (e.g. "/monster/0/hp"). */
export function validateHomebrewDocument(doc: unknown): HomebrewIssue[] {
  const validate = homebrewValidator();
  if (validate(doc)) return [];
  return toIssues(validate.errors ?? [], '');
}

/** Validates one entity of a data array (e.g. prop "monster"). Paths are relative to the entity. */
export function validateHomebrewEntity(prop: string, entity: unknown, source: MetaSource, edition: HomebrewEdition): HomebrewIssue[] {
  const validate = homebrewValidator();
  const doc = { _meta: syntheticMeta(source, edition), [prop]: [entity] };
  if (validate(doc)) return [];
  const issues = toIssues(validate.errors ?? [], `/${prop}/0`);
  // Entity schemas are a union of "full entity" and "`_copy` variant": drop the other branch's requirements
  const isCopy = !!entity && typeof entity === 'object' && '_copy' in entity;
  const relevant = issues.filter((i) => !(i.path === '' && i.message.startsWith('Missing required property') && (isCopy || i.message.includes('"_copy"'))));
  return relevant.length ? relevant : issues;
}

function toIssues(errors: ErrorObject[], prefix: string): HomebrewIssue[] {
  // Union types report one error per branch plus the union itself; keep the most specific ones
  const specific = errors.filter((e) => !['anyOf', 'oneOf', 'if', 'then', 'else', 'not'].includes(e.keyword));
  const pool = specific.length ? specific : errors;
  const seen = new Set<string>();
  const out: HomebrewIssue[] = [];
  for (const e of pool) {
    const path = e.instancePath.startsWith(prefix) ? e.instancePath.slice(prefix.length) : e.instancePath;
    const message = describe(e);
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, message });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

function describe(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case 'additionalProperties':
      return `Unknown property "${String(p.additionalProperty)}"`;
    case 'required':
      return `Missing required property "${String(p.missingProperty)}"`;
    case 'enum':
      return `Must be one of: ${(p.allowedValues as unknown[]).slice(0, 12).map(String).join(', ')}`;
    case 'type':
      return `Must be ${String(p.type)}`;
    case 'const':
      return `Must be ${JSON.stringify(p.allowedValue)}`;
    default:
      return e.message ?? e.keyword;
  }
}
