#!/usr/bin/env node
// Prints the CHANGELOG.md section of one version (the text under "## [X.Y.Z] - date", without the heading).
//   node scripts/changelog-section.mjs 1.2.0 [CHANGELOG.md]
// Used by .github/workflows/release.yml for the GitHub Release notes. Exit 1 with a clear message when the file or the
// section is missing or empty, so a release without notes fails before anything is published.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The body of the `## [version]` section, trimmed, or null when there is no such heading. */
export function extractSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const isHeading = (l) => /^## /.test(l);
  const wanted = (l) => {
    const m = /^##\s+\[?([^\]\s]+)\]?(?:\s|$)/.exec(l);
    return m !== null && m[1] === version;
  };
  const start = lines.findIndex((l) => isHeading(l) && wanted(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && isHeading(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  // Keep a Changelog ends the file with link definitions ("[1.0.0]: https://..."): they are not part of the last section
  while (body.length > 0 && /^\s*(\[[^\]]+\]:\s*\S.*)?$/.test(body[body.length - 1])) body.pop();
  return body.join('\n').trim();
}

function main() {
  const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error('usage: node scripts/changelog-section.mjs <X.Y.Z[-pre]> [CHANGELOG.md]');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`error: cannot read ${file}`);
    process.exit(1);
  }
  const section = extractSection(text, version);
  if (section === null) {
    console.error(`error: ${file} has no "## [${version}]" section. Add it (see docs/RELEASE.md) before tagging v${version}.`);
    process.exit(1);
  }
  if (section === '') {
    console.error(`error: the "## [${version}]" section of ${file} is empty.`);
    process.exit(1);
  }
  process.stdout.write(section + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
