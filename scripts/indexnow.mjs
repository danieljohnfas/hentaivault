#!/usr/bin/env node
/**
 * Daily drip-feed and IndexNow (Bing, Yandex, Seznam, Naver), run by
 * .github/workflows/indexnow.yml:
 *   1. Release: up to DAILY_RELEASE_LIMIT listings that meet every sitemap condition
 *      but are not yet released get data_json.releasedAt = today, best-rated first.
 *      Only released listings are in the sitemap and indexable (src/listing-rules.js).
 *   2. Diff the sitemap's URL set against what IndexNow was last told (D1 table
 *      indexnow_sent) and send every added and removed URL.
 *   3. Record the new set, only once IndexNow has accepted the batch.
 *
 * Usage: node scripts/indexnow.mjs [--dry-run]
 * Logs are public: counts and listing IDs only.
 */
import { isIndexable, isIndexCandidate, DAILY_RELEASE_LIMIT, SITEMAP_STATIC_PAGES } from '../src/listing-rules.js';
import { d1 as d1FromEnv, sqlString, chunks } from './lib/d1.mjs';

export const HOST = 'hentaivault.me';
export const INDEXNOW_KEY = '45598f4e24eb4bdf9891e4a106e23298';
const listingUrl = id => `https://${HOST}/site?id=${encodeURIComponent(id)}`;

const LISTING_COLUMNS = `id, url, category, rating, added_at,
  json_extract(data_json, '$.name') AS name, json_extract(data_json, '$.description') AS description,
  json_extract(data_json, '$.isUp') AS isUp, json_extract(data_json, '$.isDeadFlagged') AS isDeadFlagged,
  json_extract(data_json, '$.tags') AS tags, json_extract(data_json, '$.releasedAt') AS releasedAt`;

export async function runIndexNow({ d1, post, dryRun = false, today = new Date().toISOString().slice(0, 10), log = console.log }) {
  await d1('CREATE TABLE IF NOT EXISTS indexnow_sent (url TEXT PRIMARY KEY, sent_at TEXT NOT NULL)');
  const rows = (await d1(`SELECT ${LISTING_COLUMNS} FROM sites`)).results;

  // 1. Release the best-rated waiting listings.
  const waiting = rows.filter(r => !r.releasedAt && isIndexCandidate(r))
    .sort((a, b) => Number(b.rating) - Number(a.rating) || String(a.added_at).localeCompare(String(b.added_at)));
  const release = waiting.slice(0, DAILY_RELEASE_LIMIT);
  log(`release: ${release.length} today | still waiting: ${waiting.length - release.length}`);
  for (const r of release) log(`  release ${r.id} (${r.rating})`);
  if (!dryRun) {
    for (const part of chunks(release.map(r => r.id), 100)) {
      await d1(`UPDATE sites SET data_json = json_set(data_json, '$.releasedAt', ?) WHERE id IN (${part.map(sqlString).join(', ')})`, [today]);
    }
  }
  for (const r of release) r.releasedAt = today;

  // 2. What the sitemap holds now vs what IndexNow was last told.
  const current = new Set([
    ...SITEMAP_STATIC_PAGES.map(p => `https://${HOST}${p}`),
    ...rows.filter(isIndexable).map(r => listingUrl(r.id)),
  ]);
  const sent = new Set((await d1('SELECT url FROM indexnow_sent')).results.map(r => r.url));
  const added = [...current].filter(u => !sent.has(u));
  const removed = [...sent].filter(u => !current.has(u));
  log(`sitemap: ${current.size} URLs | new: ${added.length} | removed: ${removed.length}`);
  const changed = [...added, ...removed];
  if (!changed.length) { log('nothing to send'); return { release, added, removed }; }
  if (dryRun) { log('dry run: nothing sent or changed'); return { release, added, removed }; }

  // 3. Send (10,000 URLs per request at most) and record.
  for (const urlList of chunks(changed, 10000)) {
    const status = await post({ host: HOST, key: INDEXNOW_KEY, keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`, urlList });
    log(`IndexNow: HTTP ${status} for ${urlList.length} URLs`);
    if (status !== 200 && status !== 202) throw new Error(`IndexNow rejected the batch (HTTP ${status}); will retry next run`);
  }
  for (const part of chunks(added, 100)) {
    await d1(`INSERT OR REPLACE INTO indexnow_sent (url, sent_at) VALUES ${part.map(u => `(${sqlString(u)}, ${sqlString(today)})`).join(', ')}`);
  }
  for (const part of chunks(removed, 100)) {
    await d1(`DELETE FROM indexnow_sent WHERE url IN (${part.map(sqlString).join(', ')})`);
  }
  return { release, added, removed };
}

async function postIndexNow(body) {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
  });
  return res.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexNow({ d1: d1FromEnv, post: postIndexNow, dryRun: process.argv.includes('--dry-run') })
    .catch(e => { console.error(`indexnow failed: ${e.message}`); process.exit(1); });
}
