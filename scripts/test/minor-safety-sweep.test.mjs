// Run: node --test 'scripts/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from '../minor-safety-sweep.mjs';

function fakeD1(sites, queue = []) {
  const calls = [];
  const d1 = async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    if (flat.startsWith('SELECT id, url, data_json FROM sites')) return { results: sites.map(toRow) };
    if (flat.startsWith('SELECT id, url, name FROM queue')) return { results: queue };
    return { results: [], meta: { changes: 1 } };
  };
  return { d1, calls };
}
const ok = id => ({ id, url: `https://${id}.com`, name: id, description: 'hentai doujin archive', tags: ['doujin'] });
// Shape of a D1 row: the whole listing is stored as JSON.
const toRow = ({ id, url, ...rest }) => ({ id, url, data_json: JSON.stringify({ id, url, ...rest }) });

test('removes blocked and restricted listings and queue entries, keeps the rest', async () => {
  const sites = [
    ...Array.from({ length: 20 }, (_, i) => ok(`site${i}`)),
    { ...ok('bad'), name: 'Candydoll forum' },
    { ...ok('teen'), name: 'TeenCams' },
  ];
  const queue = [
    { id: 'q1', url: 'https://l0li.example', name: 'x' },
    { id: 'q2', url: 'https://teens.example', name: 'y' },
    { id: 'q3', url: 'https://ok.example', name: 'hentai' },
  ];
  const { d1, calls } = fakeD1(sites, queue);
  const r = await runSweep({ d1, log: () => {} });
  assert.deepEqual(r.remove.map(x => x.id), ['bad', 'teen']);
  assert.deepEqual(r.queueRemove, ['q1', 'q2']);
  const writes = calls.map(c => c.sql).filter(s => !s.startsWith('SELECT'));
  assert.deepEqual(writes, [
    "DELETE FROM reviews WHERE site_id IN ('bad', 'teen')",
    "DELETE FROM sites WHERE id IN ('bad', 'teen')",
    "DELETE FROM queue WHERE id IN ('q1', 'q2')",
  ]);
});

test('checks every stored field, not only name and description', async () => {
  const sites = [...Array.from({ length: 9 }, (_, i) => ok(`s${i}`)), { ...ok('jp'), translations: { ja: '女子高生 まとめ' } }];
  const { d1 } = fakeD1(sites);
  const r = await runSweep({ d1, dryRun: true, log: () => {} });
  assert.deepEqual(r.remove.map(x => x.id), ['jp']);
});

test('dry run changes nothing', async () => {
  const { d1, calls } = fakeD1([ok('a'), ok('b'), ok('c'), ok('d'), { ...ok('e'), name: 'loli' }]);
  const r = await runSweep({ d1, dryRun: true, log: () => {} });
  assert.equal(r.remove.length, 1);
  assert.ok(calls.every(c => c.sql.startsWith('SELECT')));
});

test('circuit breaker stops a run that would remove too much', async () => {
  const { d1, calls } = fakeD1([ok('a'), { ...ok('b'), name: 'teen' }, { ...ok('c'), name: 'teen' }]);
  await assert.rejects(runSweep({ d1, log: () => {} }), /circuit breaker/);
  assert.ok(calls.every(c => c.sql.startsWith('SELECT')));
});

test('ids are quoted safely', async () => {
  const { d1, calls } = fakeD1([...Array.from({ length: 9 }, (_, i) => ok(`s${i}`)), { ...ok("o'loli"), name: 'loli' }]);
  await runSweep({ d1, log: () => {} });
  assert.ok(calls.some(c => c.sql === "DELETE FROM sites WHERE id IN ('o''loli')"));
});
