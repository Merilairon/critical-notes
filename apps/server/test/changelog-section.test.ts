import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/changelog-section.mjs feeds the GitHub Release notes (.github/workflows/release.yml)
const script = resolve(__dirname, '../../../scripts/changelog-section.mjs');
const dir = mkdtempSync(join(tmpdir(), 'cn-changelog-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHANGELOG = `# Changelog

## [Unreleased]

- Not yet.

## [1.1.0] - 2026-11-01

### Added

- Thing B.

## [1.0.0-rc.1] - 2026-10-20

- Release candidate.

## [1.0.0] - 2026-10-25

### Added

- Thing A.

[Unreleased]: https://example.org/compare/v1.1.0...HEAD
[1.1.0]: https://example.org/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.org/releases/tag/v1.0.0
`;

function run(version: string, text: string = CHANGELOG) {
  const file = join(dir, 'CHANGELOG.md');
  writeFileSync(file, text);
  return spawnSync(process.execPath, [script, version, file], { encoding: 'utf8' });
}

describe('changelog-section', () => {
  it('prints the body of one version without heading, neighbours or link definitions', () => {
    const r = run('1.0.0');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('### Added\n\n- Thing A.\n');
  });

  it('keeps prerelease versions apart from their release', () => {
    expect(run('1.0.0-rc.1').stdout).toBe('- Release candidate.\n');
  });

  it('fails clearly when the version has no section', () => {
    const r = run('2.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('has no "## [2.0.0]" section');
  });

  it('fails on an empty section and does not match a longer version', () => {
    expect(run('1.2.0', '## [1.2.0] - 2026-12-01\n\n## [1.1.0]\n- x\n').status).toBe(1);
    expect(run('1.0', CHANGELOG).status).toBe(2);
    expect(run('1.0.1', CHANGELOG.replace('[1.0.0] - 2026-10-25', '[1.0.10] - 2026-10-25')).status).toBe(1);
  });

  it('fails on a missing file and on a bad argument', () => {
    expect(spawnSync(process.execPath, [script, '1.0.0', join(dir, 'nope.md')], { encoding: 'utf8' }).status).toBe(1);
    expect(spawnSync(process.execPath, [script, 'v1.0'], { encoding: 'utf8' }).status).toBe(2);
  });
});
