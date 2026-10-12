/**
 * Read-only D1 aggregate counts (no URLs, names or account details are printed:
 * workflow logs of this public repository are publicly readable).
 */
const DB = '3dc06028-c9b1-4e4a-a3c3-11f92209baab';
const { CLOUDFLARE_API_TOKEN: T, CLOUDFLARE_ACCOUNT_ID: A } = process.env;

async function q(sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/d1/database/${DB}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  return j.success ? j.result[0].results : { error: j.errors };
}

(async () => {
  const { PROHIBITED_TERMS } = await import('../../src/prohibited.js');
  const prohibited = PROHIBITED_TERMS.map(t => `instr(lower(url || ' ' || data_json), '${t}') > 0`).join(' OR ');
  const host = `rtrim(substr(url, instr(url, '//') + 2), '/')`;
  const indexable = `category != 'Adult Tubes & Studios' AND rating >= 3.5
    AND COALESCE(json_extract(data_json,'$.isUp'),1) != 0 AND COALESCE(json_extract(data_json,'$.isDeadFlagged'),0) != 1
    AND data_json NOT LIKE '%Auto-Discovered%' AND instr(${host}, '/') = 0 AND instr(url, '?') = 0 AND NOT (${prohibited})`;
  const checks = {
    total: 'SELECT COUNT(*) n FROM sites',
    indexable: `SELECT COUNT(*) n FROM sites WHERE ${indexable}`,
    indexableByCategory: `SELECT category, COUNT(*) n FROM sites WHERE ${indexable} GROUP BY category ORDER BY n DESC`,
    deepLinks: `SELECT COUNT(*) n FROM sites WHERE instr(${host}, '/') > 0 OR instr(url, '?') > 0`,
    prohibitedMatches: `SELECT COUNT(*) n FROM sites WHERE ${prohibited}`,
    ftsRows: 'SELECT COUNT(*) n FROM sites_fts',
    triggers: "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    queuePending: "SELECT COUNT(*) n FROM queue WHERE status = 'pending'",
  };
  for (const [k, sql] of Object.entries(checks)) console.log(k, JSON.stringify(await q(sql)));
})();
