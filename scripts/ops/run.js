#!/usr/bin/env node
/**
 * One-off production operations, driven by ops/tasks.json and run from the
 * "Ops" workflow (which holds the Cloudflare / Search Console credentials).
 *
 * The repository and its Actions logs are public: tasks print status codes and
 * IDs only — never secrets, URLs of removed listings, or account details.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DB_ID = '3dc06028-c9b1-4e4a-a3c3-11f92209baab';
const WORKER = 'vault';
const ZONE_NAME = 'hentaivault.me';
const INDEXNOW_KEY = '45598f4e24eb4bdf9891e4a106e23298';

async function cf(p, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(raw ? {} : { 'Content-Type': 'application/json' }) },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: !!json.success, result: json.result, errors: (json.errors || []).map(e => `${e.code}:${e.message}`) };
}

async function d1(sql, params = []) {
  const r = await cf(`/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, { method: 'POST', body: { sql, params } });
  if (!r.ok) throw new Error(`D1 ${r.status} ${r.errors.join('; ')}`);
  return r.result[0];
}

async function zoneId() {
  const r = await cf(`/zones?name=${ZONE_NAME}`);
  return r.result && r.result[0] && r.result[0].id;
}

async function gscAuth(scopes) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GSC_SERVICE_ACCOUNT_JSON), scopes });
  return { google, auth };
}

const tasks = {
  // Read-only: which listings match the prohibited-content blocklist (IDs + matched term only).
  async 'report-prohibited'() {
    const { PROHIBITED_TERMS, isProhibited } = await import('../../src/prohibited.js');
    const where = PROHIBITED_TERMS.map(() => `instr(lower(url || ' ' || data_json), ?) > 0`).join(' OR ');
    const rows = (await d1(`SELECT id, url, category, data_json FROM sites WHERE ${where}`, PROHIBITED_TERMS)).results;
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data_json); } catch {}
      const visible = [r.url, d.name, d.description].join(' ').toLowerCase();
      const all = `${r.url} ${r.data_json}`.toLowerCase();
      const term = PROHIBITED_TERMS.find(t => visible.includes(t)) || PROHIBITED_TERMS.find(t => all.includes(t));
      const field = PROHIBITED_TERMS.some(t => r.url.toLowerCase().includes(t)) ? 'url'
        : isProhibited(r.url, d.name, d.description) ? 'name/description' : 'other-json';
      console.log(`  ${r.id} | ${r.category} | term="${term}" | matched in ${field}`);
    }
    console.log(`  total: ${rows.length}`);
  },

  // Deletes exactly the listing IDs given (after they were reviewed via report-prohibited).
  async 'delete-sites'({ ids }) {
    for (const id of ids) {
      const del = await d1('DELETE FROM sites WHERE id = ?', [id]);
      await d1('DELETE FROM reviews WHERE site_id = ?', [id]);
      console.log(`  ${id}: deleted ${del.meta.changes} row(s)`);
    }
  },

  // Executes a SQL file statement by statement (split on "-- statement-break").
  async 'apply-sql'({ file }) {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const statements = sql.split('-- statement-break').map(x => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    for (const st of statements) {
      await d1(st);
      console.log(`  ok: ${st.split('\n')[0].slice(0, 80)}`);
    }
  },

  async 'list-triggers'() {
    const r = await d1("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    console.log(`  triggers: ${r.results.map(x => x.name).join(', ')}`);
  },

  // Proves the database rule works: a prohibited queue insert must be ignored.
  async 'test-prohibited-rule'() {
    await d1(`INSERT OR IGNORE INTO queue (id, url, name, status) VALUES ('rule_selftest', 'https://jailbait-rule-selftest.invalid', 'rule selftest', 'rejected')`);
    const r = await d1(`SELECT COUNT(*) AS n FROM queue WHERE id = 'rule_selftest'`);
    console.log(`  prohibited test row present after insert: ${r.results[0].n} (expected 0)`);
    if (r.results[0].n !== 0) process.exitCode = 1;
  },

  // Read-only: which Cloudflare capabilities the CI token has (yes/no only).
  async 'token-capabilities'() {
    const z = await zoneId();
    const probes = {
      'turnstile:read (list widgets)': `/accounts/${ACCOUNT}/challenges/widgets`,
      'workers:read (list secrets)': `/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets`,
      'd1:read': `/accounts/${ACCOUNT}/d1/database/${DB_ID}`,
      'zone:read': `/zones/${z}`,
      'zone settings:read': `/zones/${z}/settings/ssl`,
      'dns:read': `/zones/${z}/dns_records?per_page=1`,
      'waf/rulesets:read': `/zones/${z}/rulesets`,
      'api tokens:read (self)': `/user/tokens/verify`,
    };
    for (const [label, p] of Object.entries(probes)) {
      const r = await cf(p);
      console.log(`  ${r.ok ? 'YES' : 'no '} ${label}${r.ok ? '' : ` (HTTP ${r.status})`}`);
    }
  },

  // Read-only: fingerprints the CI token (yes/no + counts) so it can be matched
  // to a row in the dashboard's API Tokens list.
  async 'token-fingerprint'() {
    const v = await cf('/user/tokens/verify');
    console.log(`  token id starts: ${v.ok ? String(v.result.id).slice(0, 8) : 'n/a'} | expires: ${v.ok ? v.result.expires_on || 'never' : 'n/a'}`);
    const accounts = await cf('/accounts?per_page=50');
    console.log(`  accounts visible: ${accounts.ok ? accounts.result.length : `no (HTTP ${accounts.status})`}`);
    const zones = await cf('/zones?per_page=50');
    console.log(`  zones visible: ${zones.ok ? zones.result.length : `no (HTTP ${zones.status})`}`);
    const z = await zoneId();
    const probes = {
      'Pages': `/accounts/${ACCOUNT}/pages/projects`,
      'Containers': `/accounts/${ACCOUNT}/containers/applications`,
      'Workers KV': `/accounts/${ACCOUNT}/storage/kv/namespaces?per_page=1`,
      'R2': `/accounts/${ACCOUNT}/r2/buckets`,
      'AI Search': `/accounts/${ACCOUNT}/autorag/rags`,
      'Security Center': `/accounts/${ACCOUNT}/intel/attack-surface-report/issues?per_page=1`,
      'Workers Routes (zone)': `/zones/${z}/workers/routes`,
      'User Details': `/user`,
      'Memberships': `/memberships`,
    };
    for (const [label, p] of Object.entries(probes)) {
      const r = await cf(p);
      console.log(`  ${r.ok ? 'YES' : 'no '} ${label}${r.ok ? '' : ` (HTTP ${r.status})`}`);
    }
  },

  async 'list-worker-secrets'() {
    const r = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets`);
    console.log(`  secrets: ${r.ok ? r.result.map(s => s.name).join(', ') : r.errors.join('; ')}`);
  },

  // Copies a Turnstile widget's secret onto the Worker, only if the widget covers
  // the site's domain. The secret itself is never printed.
  async 'set-turnstile-secret'({ sitekey, name = 'TURNSTILE_SECRET_KEY' }) {
    const w = await cf(`/accounts/${ACCOUNT}/challenges/widgets/${sitekey}`);
    if (!w.ok) throw new Error(`read widget: HTTP ${w.status} ${w.errors.join('; ')}`);
    const domains = w.result.domains || [];
    console.log(`  widget domains: ${domains.join(', ')}`);
    if (!domains.includes(ZONE_NAME)) throw new Error(`widget does not include ${ZONE_NAME}; secret not set`);
    if (!w.result.secret) throw new Error('widget response has no secret');
    const r = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets`, {
      method: 'PUT', body: { name, text: w.result.secret, type: 'secret_text' },
    });
    console.log(`  set ${name}: HTTP ${r.status} ${r.ok ? 'ok' : r.errors.join('; ')}`);
    if (!r.ok) process.exitCode = 1;
  },

  async 'delete-worker-secret'({ name }) {
    const r = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    console.log(`  delete ${name}: HTTP ${r.status} ${r.ok ? 'ok' : r.errors.join('; ')}`);
    if (!r.ok) process.exitCode = 1;
  },

  // Attaches a hostname to the Worker as a Custom Domain (creates DNS + certificate).
  async 'add-worker-domain'({ hostname }) {
    const z = await zoneId();
    const r = await cf(`/accounts/${ACCOUNT}/workers/domains`, {
      method: 'PUT', body: { hostname, service: WORKER, environment: 'production', zone_id: z },
    });
    console.log(`  attach ${hostname}: HTTP ${r.status} ${r.ok ? 'ok' : r.errors.join('; ')}`);
  },

  async 'list-worker-domains'() {
    const r = await cf(`/accounts/${ACCOUNT}/workers/domains`);
    console.log(`  domains: ${r.ok ? r.result.filter(d => d.service === WORKER).map(d => d.hostname).join(', ') : r.errors.join('; ')}`);
  },

  async 'gsc-submit-sitemap'({ sitemaps }) {
    const { google, auth } = await gscAuth(['https://www.googleapis.com/auth/webmasters']);
    const wm = google.webmasters({ version: 'v3', auth });
    for (const feedpath of sitemaps) {
      try {
        await wm.sitemaps.submit({ siteUrl: `sc-domain:${ZONE_NAME}`, feedpath });
        console.log(`  submitted ${feedpath}: ok`);
      } catch (e) {
        console.log(`  submit ${feedpath}: ${e.code || ''} ${e.message}`);
      }
    }
  },

  async 'gsc-sitemaps'() {
    const { google, auth } = await gscAuth(['https://www.googleapis.com/auth/webmasters.readonly']);
    const wm = google.webmasters({ version: 'v3', auth });
    const r = await wm.sitemaps.list({ siteUrl: `sc-domain:${ZONE_NAME}` });
    for (const s of r.data.sitemap || []) {
      console.log(`  ${s.path} | downloaded ${s.lastDownloaded} | errors ${s.errors} | ${(s.contents || []).map(c => `${c.submitted} submitted / ${c.indexed} indexed`).join(', ')}`);
    }
  },

  async 'gsc-inspect'({ urls }) {
    const { google, auth } = await gscAuth(['https://www.googleapis.com/auth/webmasters.readonly']);
    const sc = google.searchconsole({ version: 'v1', auth });
    for (const u of urls) {
      try {
        const r = await sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: `https://${ZONE_NAME}${u}`, siteUrl: `sc-domain:${ZONE_NAME}` } });
        const i = r.data.inspectionResult.indexStatusResult;
        console.log(`  ${u} | ${i.coverageState} | fetch ${i.pageFetchState} | last crawl ${i.lastCrawlTime}`);
      } catch (e) { console.log(`  ${u} | error ${e.message}`); }
    }
  },

  // Daily release + IndexNow (scripts/indexnow.mjs); dryRun only reports.
  async 'indexnow'({ dryRun = true }) {
    const { runIndexNow } = await import('../indexnow.mjs');
    const post = async body => (await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
    })).status;
    await runIndexNow({ d1, post, dryRun, log: m => console.log(`  ${m}`) });
  },

  // One-off for the drip-feed rollout: every existing listing counts as released.
  async 'backfill-released'({ before }) {
    const r = await d1(`UPDATE sites SET data_json = json_set(data_json, '$.releasedAt', substr(added_at, 1, 10))
      WHERE json_extract(data_json, '$.releasedAt') IS NULL AND added_at < ?`, [before]);
    console.log(`  released ${r.meta.changes} existing listings`);
  },

  // Read-only: every listing that passes the sitemap gate, for a quality review.
  async 'list-indexable'({ verbose = true } = {}) {
    const { isIndexable } = await import('../../src/listing-rules.js');
    const rows = (await d1(`SELECT id, url, category, rating,
        json_extract(data_json, '$.name') AS name, json_extract(data_json, '$.description') AS description,
        json_extract(data_json, '$.isUp') AS isUp, json_extract(data_json, '$.isDeadFlagged') AS isDeadFlagged,
        json_extract(data_json, '$.tags') AS tags, json_extract(data_json, '$.releasedAt') AS releasedAt FROM sites`)).results;
    const ok = rows.filter(isIndexable);
    console.log(`  total sites: ${rows.length} | indexable: ${ok.length}`);
    if (verbose) for (const r of ok) console.log(`  ${r.id} | ${r.category} | ${r.rating} | ${new URL(r.url).host} | ${String(r.name || '').slice(0, 50)}`);
  },

  // Minor-safety sweep (scripts/minor-safety-sweep.mjs); dryRun lists what it would remove.
  async 'minor-safety-sweep'({ dryRun = true }) {
    const { runSweep } = await import('../minor-safety-sweep.mjs');
    await runSweep({ d1, dryRun, log: m => console.log(`  ${m}`) });
  },

  // Read-only: minor-safety check over every stored field of every listing and queue
  // entry (the sweep checks url, name, description and tags). IDs and rules only.
  async 'minor-safety-deep-scan'() {
    const { checkMinorSafety } = await import('../../src/prohibited.js');
    const sites = (await d1('SELECT id, url, data_json FROM sites')).results;
    const hits = sites.map(s => ({ id: s.id, ...checkMinorSafety(s.url, s.data_json) })).filter(h => h.verdict !== 'ok');
    console.log(`  listings scanned: ${sites.length} | matches in any field: ${hits.length}`);
    for (const h of hits) console.log(`    ${h.id} (${h.verdict}: ${h.rule})`);
    const queue = (await d1('SELECT id, url, name, category, status FROM queue')).results;
    const qHits = queue.filter(q => checkMinorSafety(q.url, q.name).verdict !== 'ok');
    console.log(`  queue scanned: ${queue.length} | matches: ${qHits.length} (${[...new Set(qHits.map(q => q.status))].join(', ') || '-'})`);
    const reviews = (await d1('SELECT id, site_id, comment, user_name FROM reviews')).results;
    const rHits = reviews.filter(r => checkMinorSafety(r.comment, r.user_name).verdict !== 'ok');
    console.log(`  reviews scanned: ${reviews.length} | matches: ${rHits.length}`);
  },

  // Read-only Search Console audit: sitemap status, index status of a page sample
  // (static pages, random indexable listings, removed listings) and 90-day performance.
  async 'gsc-audit'({ listingSample = 25, removedIds = [] } = {}) {
    const { google, auth } = await gscAuth(['https://www.googleapis.com/auth/webmasters.readonly']);
    const siteUrl = `sc-domain:${ZONE_NAME}`;
    const wm = google.webmasters({ version: 'v3', auth });
    const sc = google.searchconsole({ version: 'v1', auth });

    const sm = await wm.sitemaps.list({ siteUrl });
    console.log('  -- sitemaps');
    for (const s of sm.data.sitemap || []) {
      console.log(`  ${s.path} | submitted ${s.lastSubmitted || '-'} | read ${s.lastDownloaded || '-'} | pending ${s.isPending} | errors ${s.errors} | warnings ${s.warnings} | ${(s.contents || []).map(c => `${c.submitted} submitted`).join(', ')}`);
    }

    const { isIndexable } = await import('../../src/listing-rules.js');
    const rows = (await d1(`SELECT id, url, category, rating,
        json_extract(data_json, '$.name') AS name, json_extract(data_json, '$.description') AS description,
        json_extract(data_json, '$.isUp') AS isUp, json_extract(data_json, '$.isDeadFlagged') AS isDeadFlagged,
        json_extract(data_json, '$.tags') AS tags, json_extract(data_json, '$.releasedAt') AS releasedAt FROM sites`)).results;
    const listings = rows.filter(isIndexable).sort(() => Math.random() - 0.5).slice(0, listingSample);
    const urls = [
      '/', '/blog/', '/blog/nhentai-alternatives-2026', '/blog/best-doujin-sites-2026',
      '/category/hentai-streaming', '/category/manga-doujin', '/category/images-boorus', '/about',
      ...listings.map(r => `/site?id=${encodeURIComponent(r.id)}`),
      ...removedIds.map(id => `/site?id=${encodeURIComponent(id)}`),
    ];
    console.log(`  -- index status (${urls.length} URLs)`);
    const tally = {};
    for (const u of urls) {
      try {
        const r = await sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: `https://${ZONE_NAME}${u}`, siteUrl } });
        const i = r.data.inspectionResult.indexStatusResult || {};
        tally[i.coverageState] = (tally[i.coverageState] || 0) + 1;
        const canon = i.googleCanonical && i.userCanonical && i.googleCanonical !== i.userCanonical ? ` | google canonical: ${i.googleCanonical}` : '';
        console.log(`  ${u} | ${i.verdict} | ${i.coverageState} | fetch ${i.pageFetchState || '-'} | robots ${i.robotsTxtState || '-'} | indexing ${i.indexingState || '-'} | crawled ${i.lastCrawlTime || 'never'}${canon}`);
      } catch (e) { console.log(`  ${u} | error ${e.message}`); }
    }
    console.log(`  -- tally: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);
    const start = fmt(new Date(today - 90 * 86400000)), end = fmt(today);
    const q = async (dimensions, rowLimit = 25) => (await sc.searchanalytics.query({
      siteUrl, requestBody: { startDate: start, endDate: end, dimensions, rowLimit, dataState: 'all' },
    })).data.rows || [];
    const byMonthDay = await q(['date'], 120);
    const weeks = {};
    for (const r of byMonthDay) { const w = r.keys[0].slice(0, 8) + (r.keys[0].slice(8) < '16' ? 'a' : 'b'); weeks[w] = weeks[w] || [0, 0]; weeks[w][0] += r.clicks; weeks[w][1] += r.impressions; }
    console.log(`  -- clicks/impressions by half-month (${start}..${end}): ${Object.entries(weeks).map(([k, v]) => `${k}:${v[0]}/${v[1]}`).join(' ')}`);
    console.log('  -- top pages by impressions');
    for (const r of (await q(['page'], 20))) console.log(`  ${r.keys[0].replace(`https://${ZONE_NAME}`, '')} | clicks ${r.clicks} | impr ${r.impressions} | pos ${r.position.toFixed(1)}`);
    console.log('  -- top queries by impressions');
    for (const r of (await q(['query'], 25))) console.log(`  "${r.keys[0]}" | clicks ${r.clicks} | impr ${r.impressions} | pos ${r.position.toFixed(1)}`);
    console.log('  -- countries');
    console.log('  ' + (await q(['country'], 10)).map(r => `${r.keys[0]}:${r.impressions}`).join(' '));
  },

  // Pending queue entries that duplicate a listed site or each other (language
  // editions such as de.example.com, mirrors on other TLDs) are marked rejected;
  // one per site is kept.
  async 'dedupe-queue'({ dryRun = true } = {}) {
    const { siteKey, hostKey, brandKey } = require('../lib/discovery.js');
    const keys = url => [siteKey(url), brandKey(url)].filter(Boolean);
    const listed = new Set((await d1('SELECT url FROM sites')).results.flatMap(r => keys(r.url)));
    const pending = (await d1("SELECT id, url FROM queue WHERE status = 'pending'")).results
      .sort((a, b) => (hostKey(a.url) === siteKey(a.url) ? 0 : 1) - (hostKey(b.url) === siteKey(b.url) ? 0 : 1));
    const seen = new Set(), reject = [];
    for (const q of pending) {
      const k = keys(q.url);
      if (!siteKey(q.url) || k.some(x => listed.has(x) || seen.has(x))) reject.push(q.id); else k.forEach(x => seen.add(x));
    }
    console.log(`  pending: ${pending.length} | duplicates to reject: ${reject.length}${dryRun ? ' (dry run)' : ''}`);
    if (dryRun) return;
    for (let i = 0; i < reject.length; i += 100) {
      const part = reject.slice(i, i + 100).map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      await d1(`UPDATE queue SET status = 'rejected' WHERE id IN (${part})`);
    }
  },

  // Read-only: listings and queue entries mentioning any of `terms`, with the
  // listing fields that contain them.
  async 'find-text'({ terms }) {
    for (const term of terms) {
      const t = String(term).toLowerCase().replace(/'/g, "''");
      const sites = (await d1(`SELECT id, url, data_json FROM sites WHERE instr(lower(url || ' ' || data_json), '${t}') > 0`)).results;
      console.log(`  "${term}": ${sites.length} listing(s)`);
      for (const r of sites) {
        let fields = [];
        try { fields = Object.entries(JSON.parse(r.data_json)).filter(([, v]) => JSON.stringify(v).toLowerCase().includes(term.toLowerCase())).map(([k]) => k); } catch {}
        let d = {}; try { d = JSON.parse(r.data_json); } catch {}
        console.log(`    ${r.id} | ${r.url} | name "${d.name}" | ${d.category} | rating ${d.rating} | released ${d.releasedAt || '-'} | fields: ${fields.join(', ') || '(url only)'}`);
      }
      const queue = (await d1(`SELECT id, status FROM queue WHERE instr(lower(url || ' ' || COALESCE(name, '')), '${t}') > 0`)).results;
      console.log(`  "${term}": ${queue.length} queue entr(ies) ${queue.map(q => `${q.id}:${q.status}`).join(' ')}`);
    }
  },

  // Listings whose stored link (data_json.url, what the Visit button uses) was
  // swapped for one containing any of `terms` get the listing's own URL back.
  async 'restore-listing-urls'({ terms }) {
    for (const term of terms) {
      const t = String(term).toLowerCase().replace(/'/g, "''");
      const where = `instr(lower(COALESCE(json_extract(data_json, '$.url'), '')), '${t}') > 0 AND instr(lower(url), '${t}') = 0`;
      const rows = (await d1(`SELECT id FROM sites WHERE ${where}`)).results;
      await d1(`UPDATE sites SET data_json = json_set(data_json, '$.url', url) WHERE ${where}`);
      console.log(`  "${term}": restored ${rows.length} link(s) ${rows.map(r => r.id).join(' ')}`);
    }
  },

  // Read-only: listings whose stored link differs from the listing URL.
  async 'url-mismatch'() {
    const rows = (await d1(`SELECT id, url, json_extract(data_json, '$.url') AS link FROM sites
      WHERE json_extract(data_json, '$.url') IS NOT NULL AND rtrim(json_extract(data_json, '$.url'), '/') != rtrim(url, '/')`)).results;
    console.log(`  ${rows.length} listing(s) link somewhere other than their URL`);
    const host = u => { try { return new URL(u).hostname; } catch { return String(u).slice(0, 40); } };
    for (const r of rows.slice(0, 40)) console.log(`    ${r.id} | ${host(r.url)} -> ${host(r.link)}`);
  },

  // Listing names cut down from SEO page titles to the brand, and sites filed under
  // Hentai Streaming moved to their real category when the signal is unambiguous
  // (cleanName / specificCategory in scripts/lib/discovery.js). Refuses if more than
  // maxShare of all listings would change: that points to a bad rule.
  // Only listings of a site's homepage: deep links (search results, articles, other
  // directories' pages) are reported for a separate decision, not renamed.
  async 'clean-listings'({ dryRun = true, maxShare = 0.4, sample = 60 } = {}) {
    const { cleanName, specificCategory, hostKey } = require('../lib/discovery.js');
    const { isHomepageUrl } = await import('../../src/listing-rules.js');
    const { execStatements } = await import('../d1-exec-file.mjs');
    const q = v => `'${String(v).replace(/'/g, "''")}'`;
    const all = (await d1(`SELECT id, url, category, json_extract(data_json, '$.name') AS name,
      json_extract(data_json, '$.description') AS description FROM sites`)).results;
    const rows = all.filter(r => isHomepageUrl(r.url));
    const deep = all.filter(r => !isHomepageUrl(r.url));
    const deepHosts = {};
    for (const r of deep) { const h = hostKey(r.url) || '?'; deepHosts[h] = (deepHosts[h] || 0) + 1; }
    console.log(`  deep-link listings (not a site homepage; left as they are): ${deep.length} of ${all.length}`);
    console.log(`  top deep-link hosts: ${Object.entries(deepHosts).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([h, n]) => `${h}=${n}`).join(' ')}`);
    const changes = [];
    for (const r of rows) {
      const name = cleanName(r.name, r.url);
      const category = (r.category === 'Hentai Streaming' && specificCategory(r.name, r.description, r.url)) || r.category;
      if (name === r.name && category === r.category) continue;
      let description = r.description;
      // Discovery's filler description names the category; keep it true.
      if (category !== r.category && /is a great resource for [^.]*\.$/.test(description || '')) {
        description = `${hostKey(r.url)} is a great resource for ${category.toLowerCase()}.`;
      }
      changes.push({ ...r, newName: name, newCategory: category, newDescription: description });
    }
    // A rename that would give two listings the same name (three "itch.io" entries
    // collapsed to the platform homepage) is skipped; the rest of the change stays.
    const taken = new Map();
    for (const r of all) taken.set(String(r.name || '').toLowerCase(), (taken.get(String(r.name || '').toLowerCase()) || 0) + 1);
    const proposed = new Map();
    for (const c of changes) if (c.newName !== c.name) proposed.set(c.newName.toLowerCase(), (proposed.get(c.newName.toLowerCase()) || 0) + 1);
    let skippedDuplicates = 0;
    for (const c of changes) {
      const key = c.newName.toLowerCase();
      if (c.newName !== c.name && (proposed.get(key) > 1 || (taken.get(key) || 0) > (key === String(c.name || '').toLowerCase() ? 1 : 0))) {
        c.newName = c.name;
        skippedDuplicates++;
      }
    }
    for (let i = changes.length - 1; i >= 0; i--) {
      if (changes[i].newName === changes[i].name && changes[i].newCategory === changes[i].category) changes.splice(i, 1);
    }
    console.log(`  renames skipped because the name would be shared: ${skippedDuplicates}`);
    const renamed = changes.filter(c => c.newName !== c.name);
    const spacingOnly = renamed.filter(c => c.newName === String(c.name || '').replace(/\s+/g, ' ').trim());
    const moved = changes.filter(c => c.newCategory !== c.category);
    const byTarget = {};
    for (const c of moved) byTarget[c.newCategory] = (byTarget[c.newCategory] || 0) + 1;
    console.log(`  homepage listings: ${rows.length} | renamed: ${renamed.length} (spacing only: ${spacingOnly.length}) | recategorised: ${moved.length}${dryRun ? ' (dry run)' : ''}`);
    console.log(`  moved out of Hentai Streaming: ${Object.entries(byTarget).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
    for (const c of renamed.filter(c => !spacingOnly.includes(c)).slice(0, sample)) console.log(`    rename ${c.id}: "${c.name}" -> "${c.newName}"`);
    for (const c of moved.slice(0, sample)) console.log(`    move ${c.id}: "${c.newName}" -> ${c.newCategory}`);
    if (changes.length > rows.length * maxShare) {
      throw new Error(`would change ${changes.length} of ${rows.length} listings (limit ${maxShare * 100}%); nothing changed`);
    }
    if (dryRun) return;
    const statements = changes.map(c => {
      const set = [`'$.name', ${q(c.newName)}`, `'$.category', ${q(c.newCategory)}`];
      if (c.newDescription !== c.description) set.push(`'$.description', ${q(c.newDescription)}`);
      return `UPDATE sites SET category = ${q(c.newCategory)}, data_json = json_set(data_json, ${set.join(', ')}) WHERE id = ${q(c.id)}`;
    });
    const r = await execStatements(statements);
    console.log(`  applied: ${r.statements} updates in ${r.requests} requests`);
  },

  // The generated review text (longReview, longReview_xx) still names a listing by
  // the page title it was scraped with and by the category it was first filed under.
  // A title is replaced only when cleanName turns it into the current name, and the
  // category only where the text says "Hentai Streaming" for a listing filed elsewhere.
  async 'clean-listing-text'({ dryRun = true, sample = 20 } = {}) {
    const { cleanName } = require('../lib/discovery.js');
    const { execStatements } = await import('../d1-exec-file.mjs');
    const q = v => `'${String(v).replace(/'/g, "''")}'`;
    const NAME_RES = [
      /^(.+?) (?:has quickly established|is a |is an |is one of|is listed|stands out|remains|has become)/,
      /, but (.+?) makes it/,
    ];
    const rows = (await d1('SELECT id, url, category, data_json FROM sites')).results;
    const updates = [];
    let names = 0, categories = 0;
    for (const r of rows) {
      let d;
      try { d = JSON.parse(r.data_json); } catch { continue; }
      const name = String(d.name || '');
      let oldName = null;
      for (const re of NAME_RES) {
        const m = re.exec(String(d.longReview || ''));
        // A page title, not a lead-in sentence ("Whether you're new to …, x.com offers …").
        const t = m && m[1];
        if (t && t !== name && t.length > name.length && t.length <= 60 && !/[.!?]\s/.test(t) &&
            !/^(?:if you|whether|our latest|when it comes|for fans|navigating|for those)/i.test(t) &&
            cleanName(t, r.url) === name) { oldName = t; break; }
      }
      const fixCategory = r.category !== 'Hentai Streaming';
      const set = {};
      for (const [k, v] of Object.entries(d)) {
        if (!/^longReview(_[a-z]{2})?$/.test(k) || typeof v !== 'string') continue;
        let t = v;
        if (oldName) t = t.split(oldName).join(name);
        if (fixCategory) t = t.split('Hentai Streaming').join(r.category);
        if (t !== v) set[k] = t;
      }
      if (!Object.keys(set).length) continue;
      if (oldName) names++;
      if (fixCategory && Object.values(set).some((t, i) => t.includes(r.category))) categories++;
      updates.push({ id: r.id, oldName, name, category: r.category, set });
    }
    console.log(`  listings with review text to fix: ${updates.length} | old title replaced: ${names}${dryRun ? ' (dry run)' : ''}`);
    for (const u of updates.slice(0, sample)) {
      console.log(`    ${u.id}: ${u.oldName ? `"${u.oldName}" -> "${u.name}"` : 'category wording'} | ${Object.keys(u.set).join(',')}`);
    }
    const first = updates.find(u => u.set.longReview);
    if (first) console.log(`  example after: ${first.set.longReview.slice(0, 220)}`);
    if (dryRun) return;
    const statements = updates.map(u => `UPDATE sites SET data_json = json_set(data_json, ${
      Object.entries(u.set).map(([k, v]) => `'$.${k}', ${q(v)}`).join(', ')}) WHERE id = ${q(u.id)}`);
    const res = await execStatements(statements);
    console.log(`  applied: ${res.statements} updates in ${res.requests} requests`);
  },

  // Deep-link listings (a search page, article or video rather than a site) and
  // off-topic auto-discovered listings. A deep link is deleted; when its site has
  // no homepage listing yet, the homepage is queued once so the daily intake adds
  // it as a proper listing (its own name and description, the usual gates). Links
  // on general platforms and other directories are not queued. Off-topic means an
  // auto-discovered homepage listing with nothing adult/hentai/anime about it;
  // hand-curated listings (plain slug ids) are never touched.
  async 'cleanup-deep-links'({ dryRun = true, sample = 40, maxShare = 0.45 } = {}) {
    const { siteKey, brandKey, hostKey, cleanName, isTopical } = require('../lib/discovery.js');
    const { isHomepageUrl } = await import('../../src/listing-rules.js');
    const { execStatements } = await import('../d1-exec-file.mjs');
    const q = v => `'${String(v).replace(/'/g, "''")}'`;
    const all = (await d1(`SELECT id, url, category, rating, json_extract(data_json, '$.name') AS name,
      json_extract(data_json, '$.description') AS description FROM sites`)).results;
    const queuedKeys = new Set((await d1('SELECT url FROM queue')).results.map(r => siteKey(r.url)).filter(Boolean));
    const homes = all.filter(r => isHomepageUrl(r.url));
    const homeKeys = new Set(homes.flatMap(r => [siteKey(r.url), brandKey(r.url)]).filter(Boolean));
    const PLATFORMS = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|twitter\.com|x\.com|reddit\.com|github\.com|scribd\.com|goodreads\.com|buzzfeed\.com|rottentomatoes\.com|gamesradar\.com|billboard\.com|wikipedia\.org|fandom\.com|medium\.com|quora\.com|pinterest\.com|tiktok\.com|imdb\.com|google\.[a-z.]+|bing\.com|wordpress\.com|blogspot\.com|livejournal\.com|theporndude\.com|pornsites\.com|porngeek\.com|tumblr\.com|9gag\.com|steamcommunity\.com|amazon\.[a-z.]+|similarsites\.com|hentaivault\.me)$/;
    const AUTO_ID = /^[0-9a-f]{8}$|_m[a-z0-9]{7}$/;
    // Words the discovery topic check lacks but that mark a listing as belonging here:
    // adult studios and cams, comic and manhwa readers, and the community's tools.
    const MORE_TOPIC = /\bvr\b|vr$|vr\.|cams?\b|cam\d|comic|scans?\b|toon|novel|fap|milf|lesbian|tranny|\btrans|gay|girls?|boys\b|fetish|boob|tits|pussy|cuckold|gloryhole|swallow|domination|amateur|babes|\bclips?|model|twistys|meatspin|sick-r|8muses|fuskator|stoya|hysterical|candy\.ai|dream\.ai|noodle|freeones|j-?list|tenkafuma|chan\b|booru|pixiv|artstation|saucenao|iqdb|ascii2d|tineye|tachiyomi|mihon|aidoku|paperback|hakuneko|rawdevart|catbox|litterbox|gofile|pixeldrain|bunkr|rentry|pastebin|comiket|comifuro|toranoana|ulmf|akiba|lemma ?soft|renai|weeb|camcontacts/i;
    const ALWAYS_REMOVE = /escort/i;

    const remove = [], reasons = { platform: 0, 'homepage listed': 0, 'homepage queued': 0, 'already in queue': 0, 'off-topic': 0 };
    const groups = new Map();
    // Hand-curated deep links (plain slug ids such as "Netflix Anime" or "4chan /h/")
    // point at a section of a big site on purpose and stay.
    for (const r of all.filter(r => !isHomepageUrl(r.url) && AUTO_ID.test(r.id))) {
      const host = hostKey(r.url) || '';
      const key = siteKey(r.url);
      if (!key || PLATFORMS.test(host)) { remove.push(r); reasons.platform++; continue; }
      if (homeKeys.has(key) || homeKeys.has(brandKey(r.url))) { remove.push(r); reasons['homepage listed']++; continue; }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const toQueue = [];
    for (const [key, rows] of groups) {
      rows.forEach(r => remove.push(r));
      if (queuedKeys.has(key)) { reasons['already in queue'] += rows.length; continue; }
      reasons['homepage queued'] += rows.length;
      const best = [...rows].sort((a, b) => Number(b.rating) - Number(a.rating))[0];
      const url = `${new URL(best.url).protocol}//${key}/`;
      toQueue.push({ url, category: best.category, name: cleanName(best.name, url), from: rows.length });
    }
    const offTopic = homes.filter(r => AUTO_ID.test(r.id) && (ALWAYS_REMOVE.test(`${r.url} ${r.name}`) ||
      !(isTopical(hostKey(r.url), r.name, r.description) || MORE_TOPIC.test(`${hostKey(r.url)} ${r.name} ${r.description || ''}`))));
    offTopic.forEach(r => remove.push(r));
    reasons['off-topic'] = offTopic.length;

    console.log(`  listings: ${all.length} | deep links: ${all.length - homes.length} | to delete: ${remove.length}` +
      ` | homepages to queue: ${toQueue.length}${dryRun ? ' (dry run)' : ''}`);
    console.log(`  by reason: ${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    for (const t of toQueue.slice(0, sample)) console.log(`    queue ${t.url} as "${t.name}" (${t.category}; replaces ${t.from})`);
    console.log(`  off-topic listings (${offTopic.length}):`);
    for (const r of offTopic) console.log(`    ${r.id}: "${r.name}" ${hostKey(r.url)}`);
    if (remove.length > all.length * maxShare) {
      throw new Error(`would delete ${remove.length} of ${all.length} listings (limit ${maxShare * 100}%); nothing changed`);
    }
    if (dryRun) return;

    const ids = remove.map(r => q(r.id));
    const statements = [];
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100).join(', ');
      statements.push(`DELETE FROM reviews WHERE site_id IN (${part})`, `DELETE FROM sites WHERE id IN (${part})`);
    }
    for (const t of toQueue) {
      statements.push(`INSERT OR IGNORE INTO queue (id, url, category, name, status) VALUES (${q(require('crypto').randomUUID())}, ${q(t.url)}, ${q(t.category)}, ${q(t.name)}, 'pending')`);
    }
    const res = await execStatements(statements);
    console.log(`  applied: ${remove.length} listings deleted, ${toQueue.length} homepages queued (${res.statements} statements)`);
  },

  // Read-only: queue size by status and how many listings were added per day.
  async 'pipeline-stats'() {
    const q = (await d1(`SELECT status, COUNT(*) AS n FROM queue GROUP BY status ORDER BY n DESC`)).results;
    console.log(`  queue: ${q.map(r => `${r.status}=${r.n}`).join(', ')}`);
    const added = (await d1(`SELECT substr(added_at, 1, 10) AS day, COUNT(*) AS n FROM sites
      WHERE added_at >= date('now', '-30 days') GROUP BY day ORDER BY day`)).results;
    console.log(`  listings added per day (30d): ${added.map(r => `${r.day}:${r.n}`).join(' ')}`);
    const done = (await d1(`SELECT status, COUNT(*) AS n FROM queue WHERE claimed_at >= datetime('now', '-30 days') GROUP BY status`)).results;
    console.log(`  queue outcomes (claimed in 30d): ${done.map(r => `${r.status}=${r.n}`).join(', ')}`);
  },

  // Live checks from the runner (Cloudflare may challenge CI IPs on some paths).
  async 'live-check'({ paths }) {
    for (const p of paths) {
      try {
        const res = await fetch(`https://${ZONE_NAME}${p}`, { redirect: 'manual' });
        const body = await res.text();
        const title = (body.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
        const locs = (body.match(/<loc>/g) || []).length;
        console.log(`  ${p} | ${res.status} | ${res.headers.get('location') || ''} | robots=${res.headers.get('x-robots-tag') || '-'} | ends_html=${/<\/html>\s*$/i.test(body)} | title="${title.slice(0, 60)}"${locs ? ` | locs=${locs}` : ''}`);
      } catch (e) { console.log(`  ${p} | error ${e.message}`); }
    }
  },
};

(async () => {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ops', 'tasks.json'), 'utf8'));
  for (const t of list) {
    console.log(`\n== ${t.task}`);
    try { await tasks[t.task](t); } catch (e) { console.log(`  FAILED: ${e.message}`); process.exitCode = 1; }
  }
})();
