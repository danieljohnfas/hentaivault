// Run: node --test 'scripts/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSql, batches, execStatements } from '../d1-exec-file.mjs';

test('splits on semicolons outside string literals only', () => {
  const sql = `-- header comment
INSERT INTO t VALUES ('a;b', 'it''s; fine');
UPDATE t SET x = 'line1
line2;' WHERE id = 1;  -- trailing comment
DELETE FROM t WHERE id = '--not a comment'`;
  assert.deepEqual(splitSql(sql), [
    "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
    "UPDATE t SET x = 'line1\nline2;' WHERE id = 1",
    "DELETE FROM t WHERE id = '--not a comment'",
  ]);
});

test('batches respect the statement and size limits', () => {
  assert.deepEqual(batches(['a', 'b', 'c'], 2).map(b => b.length), [2, 1]);
  assert.deepEqual(batches(['x'.repeat(10), 'y'.repeat(10)], 40, 15).map(b => b.length), [1, 1]);
});

test('retries when D1 is busy, then succeeds', async () => {
  let calls = 0;
  const d1 = async () => { if (++calls < 3) throw new Error('D1 HTTP 503 D1 DB is overloaded'); };
  const r = await execStatements(['SELECT 1'], { d1, log: () => {}, sleep: async () => {} });
  assert.equal(calls, 3);
  assert.equal(r.statements, 1);
});

test('a SQL error fails at once, naming the statements', async () => {
  const d1 = async () => { throw new Error('D1 HTTP 400 near "SELEC": syntax error'); };
  await assert.rejects(execStatements(['SELEC 1'], { d1, log: () => {}, sleep: async () => {} }), /statements 1-1: .*syntax error/);
});
