// Run: node --test 'scripts/test/*.test.mjs'
// Verify that adult-incompatible ad networks (like Amazon Associates)
// never appear in any page, script or style to protect associate compliance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

import { fileURLToPath } from 'node:url';

const PROHIBITED_PARTNERS = /amazon-adsystem|amazon\.com.*tag=|photoid03-20/i;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.wrangler', '.unlighthouse', 'reports', 'tmp', 'scripts', 'ops']);
const EXTS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.txt', '.xml']);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (EXTS.has(extname(name)) || name.toLowerCase().match(PROHIBITED_PARTNERS)) yield p;
  }
}

test('no page, script, style or asset references prohibited adult-incompatible partners', () => {
  const hits = [...files(ROOT)].filter(f => PROHIBITED_PARTNERS.test(f.slice(ROOT.length)) || PROHIBITED_PARTNERS.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map(f => f.slice(ROOT.length)), []);
});
