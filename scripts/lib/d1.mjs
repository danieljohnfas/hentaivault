// D1 over the Cloudflare HTTP API, for scripts run from GitHub Actions.
export const DB_ID = '3dc06028-c9b1-4e4a-a3c3-11f92209baab';

export async function d1(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw new Error(`D1 HTTP ${res.status} ${(json.errors || []).map(e => e.message).join('; ')}`);
  return json.result[0];
}

export const sqlString = v => `'${String(v).replace(/'/g, "''")}'`;
export const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
