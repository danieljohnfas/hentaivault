// Run: node --test 'scripts/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUB_PAGES, topForHub, renderHubCards, renderHomeSection, buildNameIndex, matchHeading, renderGuideLinks,
} from '../../src/internal-links.js';

// A row as the Worker's link snapshot returns it (json_extract gives tags as JSON text, booleans as 0/1).
const row = (id, over = {}) => ({
  id, url: `https://${id}.com/`, category: 'Hentai Streaming', rating: 4, name: id[0].toUpperCase() + id.slice(1),
  description: 'Hentai streaming site', tags: '["Streaming"]', isUp: 1, isDeadFlagged: null, releasedAt: '2026-10-01', ...over,
});
const streaming = HUB_PAGES['/category/hentai-streaming'];

test('hubs link only indexable listings of their category, best-rated first', () => {
  const sites = [
    row('alpha', { rating: 4.2 }), row('bravo', { rating: 4.8 }),
    row('unreleased', { releasedAt: null }), row('down', { isUp: 0 }), row('low', { rating: 3 }),
    row('tube', { category: 'Adult Tubes & Studios' }), row('manga', { category: 'Manga/Doujin' }),
  ];
  assert.deepEqual(topForHub(sites, streaming, 10).map(s => s.id), ['bravo', 'alpha']);
  assert.deepEqual(topForHub(sites, streaming, 10, new Set(['bravo'])).map(s => s.id), ['alpha']);
  assert.deepEqual(topForHub(sites, HUB_PAGES['/category/manga-doujin'], 10).map(s => s.id), ['manga']);
});

test('the visual-novels hub ranks visual novels ahead of other games', () => {
  const sites = [
    row('rpgworld', { category: 'Games & Visual Novels', rating: 4.9, description: 'Browser RPG' }),
    row('vnarchive', { category: 'Games & Visual Novels', rating: 4.0, description: 'English visual novel downloads' }),
  ];
  assert.deepEqual(topForHub(sites, HUB_PAGES['/category/visual-novels'], 2).map(s => s.id), ['vnarchive', 'rpgworld']);
  assert.deepEqual(topForHub(sites, HUB_PAGES['/category/games'], 2).map(s => s.id), ['rpgworld', 'vnarchive']);
});

test('rendered links are escaped', () => {
  const html = renderHubCards([row('x', { id: 'a"b', name: '<script>', url: 'https://x.com/' })]);
  assert.ok(html.includes('href="/site?id=a%22b"'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('homepage section groups listings by category without repeats, empty when there are none', () => {
  const html = renderHomeSection([row('alpha'), row('manga', { category: 'Manga & Doujinshi' })]);
  assert.match(html, /href="\/category\/hentai-streaming"/);
  assert.equal(html.match(/href="\/site\?id=alpha"/g).length, 1);
  assert.match(html, /href="\/site\?id=manga"/);
  assert.equal(renderHomeSection([row('x', { releasedAt: null })]), '');
});

test('guide headings are matched to listings by name, host or domain label', () => {
  const index = buildNameIndex([
    row('hitomila', { name: 'Hitomi.la', url: 'https://hitomi.la/' }),
    row('ehentai', { name: 'E-Hentai Galleries', url: 'https://e-hentai.org/' }),
    row('lowdup', { name: 'Hitomi.la', url: 'https://hitomi.la/', rating: 3.6 }),
  ]);
  assert.equal(matchHeading('#1. Hitomi.la — Best Overall nhentai Alternative', index).id, 'hitomila');
  assert.equal(matchHeading('E-Hentai', index).id, 'ehentai');
  assert.equal(matchHeading('2) e-hentai.org: still the biggest archive', index).id, 'ehentai');
  assert.equal(matchHeading('What is the best free nhentai alternative in 2026?', index), null);
  assert.equal(matchHeading('FAQ', index), null);
});

test('guide box lists each matched listing once', () => {
  const index = buildNameIndex([row('hitomila', { name: 'Hitomi.la', url: 'https://hitomi.la/' })]);
  const html = renderGuideLinks(['#1. Hitomi.la — Best', 'Hitomi.la', 'Conclusion'], index);
  assert.equal(html.match(/href="\/site\?id=hitomila"/g).length, 1);
  assert.equal(renderGuideLinks(['Conclusion'], index), '');
});

test('one listing per brand: mirrors on other TLDs and brands already on the page are skipped', () => {
  const sites = [
    row('haven1', { url: 'https://hentaihaven.com/', rating: 4.6 }),
    row('haven2', { url: 'https://hentaihaven.xxx/', rating: 4.7 }),
    row('static', { url: 'https://hanime.tv/', rating: 4.9 }),
    row('hanime2', { url: 'https://hanime.xxx/', rating: 4.5 }),
    row('other', { rating: 4.0 }),
    row('blog1', { url: 'https://aaa.blogspot.com/', rating: 3.9 }),
    row('blog2', { url: 'https://bbb.blogspot.com/', rating: 3.8 }),
    row('uk1', { url: 'https://one.co.uk/', rating: 3.7 }),
    row('uk2', { url: 'https://two.co.uk/', rating: 3.6 }),
  ];
  assert.deepEqual(topForHub(sites, streaming, 10, new Set(['static'])).map(s => s.id), ['haven2', 'other', 'blog1', 'blog2', 'uk1', 'uk2']);
});

test('HTML entities stored in names are decoded once, then escaped', () => {
  const html = renderHubCards([row('p', { name: 'Hentai Pulse &raquo; Best &amp; Free &#8211; <b>' })]);
  assert.ok(html.includes('Hentai Pulse » Best &amp; Free – &lt;b&gt;'), html);
});
