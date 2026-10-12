// Run: node --test 'scripts/test/*.test.mjs'
// The daily link checker (scripts/daily-deadlink-checker.js) against a local server
// that imitates dead, parked, protected, broken and healthy sites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isSiteLive = require('../ping-site.js');

const realPage = '<html><head><title>Real site</title></head><body>' + 'hentai doujin archive '.repeat(60) + '</body></html>';
const routes = {
  '/ok': [200, {}, realPage],
  '/gone404': [404, {}, 'Not Found'],
  '/gone410': [410, {}, 'Gone'],
  '/parked': [200, {}, '<html><body>' + 'This domain is for sale! Buy this domain today. '.repeat(20) + '</body></html>'],
  '/tiny': [200, {}, '<html></html>'],
  '/cf403': [403, { Server: 'cloudflare' }, 'Attention Required'],
  '/cfchallenge': [200, {}, '<html><title>Just a moment...</title><body>Cloudflare please wait' + ' '.repeat(600) + '</body></html>'],
  '/err500': [500, {}, 'Internal Server Error'],
};
let server, base;
before(async () => {
  server = http.createServer((req, res) => {
    const [code, headers, body] = routes[req.url] || [404, {}, 'nope'];
    res.writeHead(code, { 'Content-Type': 'text/html', ...headers });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('classifies sites the way the delete rule expects', async () => {
  const expect = {
    '/ok': 'live', '/cf403': 'live', '/cfchallenge': 'live',
    '/gone404': 'dead', '/gone410': 'dead', '/parked': 'dead', '/tiny': 'dead',
    '/err500': 'error',
  };
  for (const [p, want] of Object.entries(expect)) assert.equal(await isSiteLive(base + p), want, p);
  assert.equal(await isSiteLive('http://127.0.0.1:1'), 'error', 'unreachable host is kept, not deleted');
});

test('checker deletes only definitively dead listings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadlink-'));
  const sites = Object.keys(routes).map(p => ({ id: `id${p.replace('/', '_')}`, url: base + p }));
  sites.push({ id: "o'quote", url: base + '/gone404' });
  fs.writeFileSync(path.join(dir, 'sites.json'), JSON.stringify(sites));
  const out = path.join(dir, 'out.sql');
  // The checker pings over the network; run it as a child so the server keeps serving.
  await new Promise((resolve, reject) => {
    const { execFile } = require('node:child_process');
    execFile(process.execPath, ['scripts/daily-deadlink-checker.js', '--existing-urls', path.join(dir, 'sites.json'), '--output-sql', out],
      { cwd: path.resolve(import.meta.dirname, '../..') }, err => err ? reject(err) : resolve());
  });
  const sql = fs.readFileSync(out, 'utf8').trim().split('\n').sort();
  assert.deepEqual(sql, [
    "DELETE FROM sites WHERE id = 'id_gone404';",
    "DELETE FROM sites WHERE id = 'id_gone410';",
    "DELETE FROM sites WHERE id = 'id_parked';",
    "DELETE FROM sites WHERE id = 'id_tiny';",
    "DELETE FROM sites WHERE id = 'o''quote';",
  ]);
});
