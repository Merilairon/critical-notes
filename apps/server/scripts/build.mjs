/**
 * Bundles the server into `dist/` so it runs on plain Node (no tsx): `main.mjs` (the server), `THIRD_PARTY_LICENSES.txt`, `index.mjs`
 * (`node dist/index.mjs [--force]` rebuilds the reference index) and `admin.mjs` (`node dist/admin.mjs reset-link <user>`). Native modules and 5etools-utils (which reads
 * its JSON schemas from its own folder) stay external; `dist/package.json` lists them at the installed versions,
 * so `npm install` in `dist/` is all a deployment needs. The SQLite migrations are copied next to the bundle.
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { writeLicenses } from './licenses.mjs';

const EXTERNAL = ['better-sqlite3', '@node-rs/argon2', 'sharp', '5etools-utils'];

rmSync('dist', { recursive: true, force: true });
const result = await build({
  entryPoints: { main: 'src/main.ts', index: 'src/cli/index.ts', admin: 'src/cli/admin.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: EXTERNAL,
  sourcemap: true,
  legalComments: 'linked',
  // Bundled CommonJS dependencies call `require`, which ES modules do not have
  banner: { js: "import { createRequire as __cnCreateRequire } from 'node:module';\nglobalThis.require ??= __cnCreateRequire(import.meta.url);" },
  metafile: true,
  logLevel: 'warning',
});
// The full license text of every bundled package (Apache-2.0 NOTICE files included)
const licenses = writeLicenses(result.metafile, 'dist/THIRD_PARTY_LICENSES.txt');
if (licenses.withoutLicenseFile.length) console.warn(`No license file in: ${licenses.withoutLicenseFile.join(', ')}`);
cpSync('drizzle', 'dist/drizzle', { recursive: true });

const version = (name) => JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8')).version;
const pkg = { name: 'critical-notes-server', private: true, type: 'module', dependencies: Object.fromEntries(EXTERNAL.map((n) => [n, version(n)])) };
writeFileSync('dist/package.json', `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Server bundle written to dist/ (external: ${EXTERNAL.join(', ')})`);
