#!/usr/bin/env node
/**
 * daily-deadlink-checker.js — HentaiVault Daily Deadlink Checker
 *
 * Usage:
 *   node scripts/daily-deadlink-checker.js --existing-urls /tmp/d1_sites.json --output-sql /tmp/deadlinks.sql
 *
 * What it does:
 *   1. Takes a JSON of existing sites (with id and url)
 *   2. Pings them concurrently to check liveness
 *   3. If definitively dead, generates a DELETE SQL statement
 *   4. Outputs to the specified SQL file
 */

'use strict';

const fs = require('fs');
const path = require('path');
const isSiteLive = require('./ping-site');

const args = process.argv.slice(2);

const existingFlag = args.findIndex(a => a === '--existing-urls');
const EXISTING_FILE = existingFlag !== -1 ? args[existingFlag + 1] : null;

const outputSqlFlag = args.findIndex(a => a === '--output-sql');
const OUTPUT_SQL_FILE = outputSqlFlag !== -1 ? args[outputSqlFlag + 1] : null;

async function run() {
  console.log(`\n🔍 HentaiVault Weekly Deadlink Checker — ${new Date().toISOString().split('T')[0]}`);

  if (!EXISTING_FILE || !fs.existsSync(EXISTING_FILE)) {
    console.error(`❌ Error: Could not find existing URLs file at ${EXISTING_FILE}`);
    process.exit(1);
  }

  const sites = JSON.parse(fs.readFileSync(EXISTING_FILE, 'utf8'));
  console.log(`📦 Loaded ${sites.length} sites from database.`);

  const deadSites = [];
  const CONCURRENCY = 40;

  console.log(`\n🌐 Pinging sites to verify liveness (Concurrency: ${CONCURRENCY})...`);

  // Worker pool: a slow or timing-out site only holds up its own slot,
  // instead of stalling a whole fixed-size batch until it finishes.
  let next = 0;
  async function worker() {
    while (next < sites.length) {
      const site = sites[next++];
      const status = await isSiteLive(site.url);
      if (status === 'dead') {
        console.log(`   ❌ DEAD: ${site.url} (ID: ${site.id})`);
        deadSites.push(site);
      } else if (status === 'error') {
        // We log errors, but DO NOT delete them, as they could be temporary issues.
        console.log(`   ⚠️ ERROR/TIMEOUT: ${site.url} - Skipping to avoid false positive.`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));

  console.log(`\n✅ Scan complete. Found ${deadSites.length} definitively dead sites.`);

  if (deadSites.length === 0) {
    console.log('🎉 No dead links to remove!');
    if (OUTPUT_SQL_FILE) fs.writeFileSync(OUTPUT_SQL_FILE, '', 'utf8');
    process.exit(0);
  }

  // Generate SQL statements
  const sqlStatements = deadSites
    .map(s => `DELETE FROM sites WHERE id = '${String(s.id).replace(/'/g, "''")}';`)
    .join('\n');

  if (OUTPUT_SQL_FILE) {
    fs.mkdirSync(path.dirname(OUTPUT_SQL_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_SQL_FILE, sqlStatements, 'utf8');
    console.log(`💾 SQL written to ${OUTPUT_SQL_FILE} (${deadSites.length} DELETE statements)`);
  } else {
    console.log('\n--- SQL OUTPUT ---');
    console.log(sqlStatements);
    console.log('--- END SQL ---');
  }
}

run().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
