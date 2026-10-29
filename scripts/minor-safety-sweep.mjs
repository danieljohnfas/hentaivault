#!/usr/bin/env node
/**
 * Minor-safety sweep: re-checks every listing (every stored field, not only the
 * name and description) and every queued submission against src/prohibited.js and
 * removes anything blocked or restricted, automatically (no manual approvals): the
 * listing, its reviews, and matching queue entries.
 *
 * Runs twice a day and whenever the rules change (.github/workflows/minor-safety.yml),
 * so rows written by any path (including manual SQL) are removed within hours; the
 * Worker also refuses to render or link a matching listing in the meantime.
 *
 * Circuit breaker: if one run would remove more than MAX_SHARE of all listings, it
 * changes nothing and fails (the failed run emails the owner), since that points to
 * a broken rule rather than bad listings.
 *
 * Usage: node scripts/minor-safety-sweep.mjs [--dry-run]
 * Logs are public: listing IDs and rule names only.
 */
import { checkMinorSafety } from '../src/prohibited.js';
import { d1 as d1FromEnv, sqlString, chunks } from './lib/d1.mjs';

const MAX_SHARE = Number(process.env.MINOR_SAFETY_MAX_SHARE || 0.25);

const sqlList = ids => ids.map(sqlString).join(', ');

export async function runSweep({ d1, dryRun = false, log = console.log }) {
  const sites = (await d1(`SELECT id, url, data_json FROM sites`)).results;
  const remove = [];
  for (const s of sites) {
    const { verdict, rule } = checkMinorSafety(s.url, s.data_json);
    if (verdict !== 'ok') remove.push({ id: s.id, verdict, rule });
  }

  const queue = (await d1(`SELECT id, url, name FROM queue`)).results;
  const queueRemove = queue.filter(q => checkMinorSafety(q.url, q.name).verdict !== 'ok').map(q => q.id);

  log(`listings: ${sites.length} | remove: ${remove.length} | queue: ${queue.length} | remove from queue: ${queueRemove.length}`);
  for (const r of remove) log(`  remove ${r.id} (${r.verdict}: ${r.rule})`);

  const share = remove.length / Math.max(sites.length, 1);
  if (share > MAX_SHARE) {
    throw new Error(`circuit breaker: would remove ${(share * 100).toFixed(1)}% of listings (limit ${MAX_SHARE * 100}%); nothing changed`);
  }
  if (dryRun) { log('dry run: nothing changed'); return { remove, queueRemove }; }

  for (const ids of chunks(remove.map(r => r.id), 100)) {
    await d1(`DELETE FROM reviews WHERE site_id IN (${sqlList(ids)})`);
    await d1(`DELETE FROM sites WHERE id IN (${sqlList(ids)})`);
  }
  for (const ids of chunks(queueRemove, 100)) await d1(`DELETE FROM queue WHERE id IN (${sqlList(ids)})`);
  log('sweep applied');
  return { remove, queueRemove };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSweep({ d1: d1FromEnv, dryRun: process.argv.includes('--dry-run') })
    .catch(e => { if (/daily row read limit/i.test(e.message)) { console.warn(`sweep skipped (D1 daily quota reached): ${e.message}`); process.exit(0); } console.error(`sweep failed: ${e.message}`); process.exit(1); });
}
