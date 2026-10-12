#!/usr/bin/env node
/**
 * Writes every listed and queued URL to a JSON file for scripts/scout-v3.js to
 * de-duplicate against. Fails rather than writing an empty list: a scout run with
 * nothing to compare against would queue sites that are already listed.
 *
 * Usage: node scripts/export-existing-urls.mjs /tmp/existing_urls_scout.json
 */
import { writeFileSync } from 'node:fs';
import { d1 } from './lib/d1.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: export-existing-urls.mjs <out.json>'); process.exit(2); }

let lastError;
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    const { results } = await d1('SELECT url FROM sites UNION SELECT url FROM queue');
    const urls = results.map(r => r.url).filter(Boolean);
    if (!urls.length) throw new Error('D1 returned no URLs');
    writeFileSync(out, JSON.stringify(urls));
    console.log(`Existing URLs loaded for spidering/dedup: ${urls.length}`);
    process.exit(0);
  } catch (e) {
    lastError = e;
    console.error(`attempt ${attempt} failed: ${e.message}`);
    await new Promise(r => setTimeout(r, 2000 * 2 ** (attempt - 1)));
  }
}
console.error(`could not load existing URLs: ${lastError.message}`);
process.exit(1);
