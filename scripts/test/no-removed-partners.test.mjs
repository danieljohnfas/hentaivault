// Run: node --test 'scripts/test/*.test.mjs'
// Partners the owner removed from the site must not come back (old ad-patch
// scripts used to re-inject them into every page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const REMOVED = /pcloud|purevpn/i;
const ROOT = new URL('../..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', '.wrangler', '.unlighthouse', 'reports', 'tmp', 'scripts', 'ops']);
const EXTS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.xml']);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (EXTS.has(extname(name)) || name.toLowerCase().match(REMOVED)) yield p;
  }
}

test('no page, script, style or asset references a removed partner', () => {
  const hits = [...files(ROOT)].filter(f => REMOVED.test(f.slice(ROOT.length)) || REMOVED.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map(f => f.slice(ROOT.length)), []);
});
