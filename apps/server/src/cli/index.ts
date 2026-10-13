/**
 * `pnpm index [--force]` — build or incrementally update the reference index from the local 5etools clone.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEditionListsFromPackage } from '@cn/fivetools/node';
import { ensureDataDirs, loadConfig } from '../config';
import { openIndexDb } from '../reference/index-db';
import { runIndexer } from '../reference/indexer';

const config = loadConfig();
const force = process.argv.includes('--force');

if (!existsSync(join(config.fivetoolsSrcPath, 'data'))) {
  console.error(`5etools data not found at ${config.fivetoolsSrcPath}. Run "pnpm data:clone" or set FIVETOOLS_SRC_PATH.`);
  process.exit(1);
}

ensureDataDirs(config);
const db = openIndexDb(config.indexDbPath);
try {
  const report = await runIndexer({
    srcPath: config.fivetoolsSrcPath,
    db,
    editionLists: loadEditionListsFromPackage(),
    force,
    log: (msg) => console.log(`  ${msg}`),
  });
  console.log(
    `Index ${report.status} in ${report.durationMs} ms — ${report.files} files, ${report.entities || 'unchanged'} entities ` +
      `(+${report.inserted} ~${report.updated} -${report.deleted})${report.dataVersion ? `, data ${report.dataVersion}` : ''}`,
  );
  if (report.changedFiles.length) console.log(`  changed: ${report.changedFiles.slice(0, 10).join(', ')}${report.changedFiles.length > 10 ? ', …' : ''}`);
  if (report.warnings.length) {
    console.log(`  ${report.warnings.length} warning(s):`);
    for (const w of report.warnings.slice(0, 20)) console.log(`    - ${w}`);
  }
} finally {
  db.close();
}
