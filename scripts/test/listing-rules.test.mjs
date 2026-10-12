// Run: node --test 'scripts/test/*.test.mjs'
// Every condition that decides whether a listing is in the sitemap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIndexable, isIndexCandidate, isJunkName, isSiteUp, normalizeCategory } from '../../src/listing-rules.js';

// A listing that meets every condition; each test changes one thing.
const good = (over = {}) => ({
  id: 'nhentai', url: 'https://nhentai.net', name: 'nHentai', category: 'Manga & Doujinshi',
  rating: 4.6, description: 'Doujinshi archive', tags: ['doujin'], isUp: true, releasedAt: '2026-10-01', ...over,
});

test('baseline listing is indexable', () => {
  assert.equal(isIndexable(good()), true);
  assert.equal(isIndexable(good({ url: 'https://nhentai.net/' })), true, 'trailing slash is still the homepage');
  assert.equal(isIndexable(good({ url: 'http://nhentai.net' })), true);
});

test('only a site homepage, not a deep link', () => {
  for (const url of [
    'https://nhentai.net/g/12345', 'https://nhentai.net/tag/ahegao/', 'https://nhentai.net/?q=x',
    'https://nhentai.net/search?query=a', 'https://example.com/performer/jane',
  ]) assert.equal(isIndexable(good({ url })), false, url);
  for (const url of ['ftp://nhentai.net', 'javascript:alert(1)', 'not a url', '', null]) {
    assert.equal(isIndexable(good({ url })), false, String(url));
  }
});

test('rated 3.5 or higher', () => {
  assert.equal(isIndexable(good({ rating: 3.5 })), true);
  assert.equal(isIndexable(good({ rating: '4.1' })), true, 'D1 may return the rating as text');
  for (const rating of [3.49, 3, 0, null, undefined, 'n/a']) {
    assert.equal(isIndexable(good({ rating })), false, String(rating));
  }
});

test('online: health checks and the dead-link flag take it out', () => {
  // json_extract returns 0/1 for JSON booleans; older rows may hold strings.
  for (const isUp of [false, 0, 'false', '0']) assert.equal(isIndexable(good({ isUp })), false, `isUp=${isUp}`);
  for (const isDeadFlagged of [true, 1, 'true', '1']) {
    assert.equal(isIndexable(good({ isDeadFlagged })), false, `isDeadFlagged=${isDeadFlagged}`);
  }
  for (const isUp of [true, 1, undefined, null]) assert.equal(isSiteUp({ isUp }), true, `isUp=${isUp}`);
});

test('not in the Adult Tubes & Studios category, including its legacy alias', () => {
  assert.equal(isIndexable(good({ category: 'Adult Tubes & Studios' })), false);
  assert.equal(isIndexable(good({ category: 'Adult Studios' })), false);
  assert.equal(normalizeCategory(' Adult Studios '), 'Adult Tubes & Studios');
  for (const category of ['Hentai Streaming', 'Anime Streaming', 'Image Boards (Boorus)', 'Creator Platforms', 'Communities']) {
    assert.equal(isIndexable(good({ category })), true, category);
  }
});

test('not tagged as unreviewed auto-discovered', () => {
  assert.equal(isIndexable(good({ tags: ['doujin', 'Auto-Discovered'] })), false);
  assert.equal(isIndexable(good({ tags: '["Auto-Discovered"]' })), false, 'tags as D1 JSON text');
  assert.equal(isIndexable(good({ tags: '["doujin"]' })), true);
  assert.equal(isIndexable(good({ tags: undefined })), true);
  assert.equal(isIndexable(good({ tags: 'not json' })), true);
});

test('real name, not a scraping artefact', () => {
  for (const name of [
    'Checking your browser', 'Just a moment...', 'Attention Required! | Cloudflare', 'Access Denied',
    '403 Forbidden', 'Page Not Found', 'Age Verification', 'WWW', 'M', 'DE', 'RT', 'rus', '', '   ', null,
  ]) assert.equal(isIndexable(good({ name })), false, `name=${name}`);
  // Generic subdomain labels scraped as the name
  assert.equal(isJunkName('One moment, please...', 'https://example-tube.com'), true);
  assert.equal(isJunkName('Free', 'https://free.livecamzsex.com'), true);
  assert.equal(isJunkName('Live', 'https://live.camslurp.com'), true);
  assert.equal(isJunkName('Video', 'https://video.pornozavr.net'), true);
  assert.equal(isJunkName('Members', 'https://members.hanime.tv'), true);
  // ...but a real brand that happens to be a word, or a brand on a subdomain, is fine
  assert.equal(isJunkName('Live', 'https://live.com'), false);
  assert.equal(isJunkName('Danbooru', 'https://danbooru.donmai.us'), false);
  assert.equal(isJunkName('Sukebei Nyaa', 'https://sukebei.nyaa.si'), false);
  assert.equal(isJunkName('E-Hentai', 'https://e-hentai.org'), false);
  assert.equal(isJunkName('F95Zone', 'https://f95zone.to'), false);
});

test('passes the minor-safety rules', () => {
  assert.equal(isIndexable(good({ name: 'TeenCams', url: 'https://teencams.example' })), false);
  assert.equal(isIndexable(good({ description: 'schoolgirl uploads' })), false);
  assert.equal(isIndexable(good({ tags: ['loli'] })), false);
  assert.equal(isIndexable(good({ url: 'https://l0li-archive.example' })), false);
});

test('released to search engines (drip-feed)', () => {
  assert.equal(isIndexable(good({ releasedAt: undefined })), false, 'waiting for release');
  assert.equal(isIndexCandidate(good({ releasedAt: undefined })), true, 'but it is a release candidate');
  assert.equal(isIndexCandidate(good({ releasedAt: undefined, rating: 2 })), false, 'only qualifying listings are candidates');
});

test('a missing listing is never indexable', () => {
  assert.equal(isIndexable(null), false);
  assert.equal(isIndexable(undefined), false);
});
