#!/usr/bin/env node
// Fails if web code renders raw HTML. All user/5etools content must go through the structured renderers.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const targets = ['apps/web/src'];
const banned = [
  { re: /\[innerHTML\]|\[outerHTML\]/, msg: 'innerHTML/outerHTML binding' },
  { re: /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/, msg: 'DOM HTML assignment' },
  { re: /bypassSecurityTrust\w*\s*\(/, msg: 'DomSanitizer bypass' },
  { re: /document\.write\s*\(/, msg: 'document.write' },
];
const problems = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|html)$/.test(name)) {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const b of banned) if (b.re.test(line)) problems.push(`${relative(root, p)}:${i + 1}: ${b.msg}`);
        });
    }
  }
};
for (const t of targets) walk(join(root, t));
if (problems.length) {
  console.error(`Raw HTML rendering is not allowed:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('check-no-raw-html: ok');
