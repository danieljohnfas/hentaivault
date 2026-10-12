// Run: node --test 'scripts/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIndexNow } from '../indexnow.mjs';
import { DAILY_RELEASE_LIMIT, SITEMAP_STATIC_PAGES } from '../../src/listing-rules.js';

const row = (id, over = {}) => ({
  id, url: `https://${id}.example`, category: 'Manga & Doujinshi', rating: 4, added_at: '2026-09-01',
  name: id.toUpperCase() + ' Hentai', description: 'doujin archive', isUp: 1, isDeadFlagged: null,
  tags: '["doujin"]', releasedAt: '2026-09-01', ...over,
});

function fakeDb(rows, sent = []) {
  const state = { rows, sent: new Set(sent), writes: [] };
  const d1 = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('CREATE TABLE')) return { results: [] };
    if (q.startsWith('SELECT id, url, category')) return { results: state.rows.map(r => ({ ...r })) };
    if (q === 'SELECT url FROM indexnow_sent') return { results: [...state.sent].map(url => ({ url })) };
    state.writes.push({ q, params });
    if (q.startsWith('INSERT OR REPLACE INTO indexnow_sent')) for (const [, u] of q.matchAll(/\('([^']+)', '/g)) state.sent.add(u);
    if (q.startsWith('DELETE FROM indexnow_sent')) for (const [, u] of q.matchAll(/'([^']+)'/g)) state.sent.delete(u);
    if (q.startsWith('UPDATE sites SET data_json = json_set(data_json, \'$.releasedAt\'')) {
      for (const [, id] of q.matchAll(/'([^']+)'/g)) { const r = state.rows.find(x => x.id === id); if (r) r.releasedAt = params[0]; }
    }
    return { results: [], meta: { changes: 1 } };
  };
  return { d1, state };
}
const quiet = () => {};
const url = id => `https://hentaivault.me/site?id=${id}`;

test('first run sends every sitemap URL and records them', async () => {
  const { d1, state } = fakeDb([row('a'), row('b'), row('c', { rating: 2 })]);
  const posts = [];
  const r = await runIndexNow({ d1, post: async b => { posts.push(b); return 200; }, today: '2026-10-02', log: quiet });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].host, 'hentaivault.me');
  assert.ok(posts[0].urlList.includes(url('a')) && posts[0].urlList.includes(url('b')));
  assert.ok(!posts[0].urlList.includes(url('c')), 'non-qualifying listing is not sent');
  assert.equal(posts[0].urlList.length, SITEMAP_STATIC_PAGES.length + 2);
  assert.equal(r.removed.length, 0);
  assert.equal(state.sent.size, SITEMAP_STATIC_PAGES.length + 2);
});

test('later runs send only additions and removals', async () => {
  const already = [...SITEMAP_STATIC_PAGES.map(p => `https://hentaivault.me${p}`), url('a'), url('gone')];
  const { d1, state } = fakeDb([row('a'), row('b')], already);
  const posts = [];
  await runIndexNow({ d1, post: async b => { posts.push(b); return 202; }, today: '2026-10-02', log: quiet });
  assert.deepEqual(posts[0].urlList.sort(), [url('b'), url('gone')].sort());
  assert.ok(state.sent.has(url('b')) && !state.sent.has(url('gone')));
});

test('releases at most the daily limit, best-rated first, and only qualifying listings', async () => {
  const waiting = Array.from({ length: DAILY_RELEASE_LIMIT + 20 }, (_, i) => row(`w${i}`, { releasedAt: null, rating: 3.5 + (i % 15) / 10 }));
  const notQualifying = row('low', { releasedAt: null, rating: 3.0 });
  const { d1, state } = fakeDb([...waiting, notQualifying]);
  const r = await runIndexNow({ d1, post: async () => 200, today: '2026-10-02', log: quiet });
  assert.equal(r.release.length, DAILY_RELEASE_LIMIT);
  const released = state.rows.filter(x => x.releasedAt === '2026-10-02');
  assert.equal(released.length, DAILY_RELEASE_LIMIT);
  const minReleased = Math.min(...released.map(x => x.rating));
  const maxLeft = Math.max(...state.rows.filter(x => !x.releasedAt && x.id !== 'low').map(x => x.rating));
  assert.ok(minReleased >= maxLeft, 'best-rated released first');
  assert.equal(state.rows.find(x => x.id === 'low').releasedAt, null);
  assert.equal(r.added.filter(u => u.includes('/site?id=')).length, DAILY_RELEASE_LIMIT, 'released listings go to IndexNow the same day');
});

test('a rejected batch is not recorded, so it is retried next run', async () => {
  const { d1, state } = fakeDb([row('a')]);
  await assert.rejects(runIndexNow({ d1, post: async () => 429, today: '2026-10-02', log: quiet }), /HTTP 429/);
  assert.equal(state.sent.size, 0);
});

test('dry run releases and sends nothing', async () => {
  const { d1, state } = fakeDb([row('a', { releasedAt: null })]);
  let posted = false;
  await runIndexNow({ d1, post: async () => { posted = true; return 200; }, dryRun: true, log: quiet });
  assert.equal(posted, false);
  assert.equal(state.writes.length, 0);
  assert.equal(state.rows[0].releasedAt, null);
});
