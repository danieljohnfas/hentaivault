// Run: node --test 'scripts/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  hostKey, siteKey, brandKey, toHomepage, registrableDomain, isTopical, siteName, pool, cleanName, specificCategory,
} = require('../lib/discovery.js');

test('deep links reduce to the site homepage', () => {
  assert.equal(toHomepage('https://www.Example.com/gallery/123?x=1#y'), 'https://www.example.com/');
  assert.equal(toHomepage('http://site.net/a/b'), 'http://site.net/');
  for (const bad of ['mailto:a@b.c', 'javascript:void(0)', 'https://localhost/x', 'http://192.168.0.1/', 'not a url']) {
    assert.equal(toHomepage(bad), null, bad);
  }
});

test('hosts de-duplicate across www./m. variants', () => {
  assert.equal(hostKey('https://www.nhentai.net/g/1'), 'nhentai.net');
  assert.equal(hostKey('https://m.nhentai.net'), 'nhentai.net');
  assert.equal(hostKey('https://sukebei.nyaa.si/'), 'sukebei.nyaa.si');
});

test('registrable domain handles common two-part suffixes', () => {
  assert.equal(registrableDomain('cdn.assets.hentaisite.com'), 'hentaisite.com');
  assert.equal(registrableDomain('www.doujin.co.uk'), 'doujin.co.uk');
  assert.equal(registrableDomain('mangas.com.br'), 'mangas.com.br');
  assert.equal(registrableDomain('com'), null);
});

test('topic check keeps adult/anime sites and drops off-topic ones', () => {
  for (const t of ['nhentai.net', 'Gelbooru anime images', 'Free XXX cams', 'Read manga online', 'エロ同人', 'Rule 34', 'Visual Novel Database']) {
    assert.equal(isTopical(t), true, t);
  }
  for (const t of ['Video Game News, Reviews, and Walkthroughs - IGN', 'Eurogamer.net', 'Cambodia Tourist Service', 'Oak City Headlight Restoration', 'jsDelivr CDN']) {
    assert.equal(isTopical(t), false, t);
  }
});

test('language editions count as one site; real subdomain sites stay separate', () => {
  for (const u of ['https://de.videosfilmsporno.com/', 'http://pt-br.example.com/x', 'https://www.example.com', 'https://m.example.com'])
    assert.equal(siteKey(u), registrableDomain(new URL(u).hostname), u);
  assert.equal(siteKey('https://sukebei.nyaa.si/'), 'sukebei.nyaa.si');
  assert.equal(siteKey('https://danbooru.donmai.us/'), 'danbooru.donmai.us');
  assert.equal(siteKey('https://fr.example.co.uk/'), 'example.co.uk');
});

test('site names come from the brand, not the SEO title', () => {
  assert.equal(siteName('Free Porn Videos & XXX Movies | MadeTube', 'https://madetube.com/'), 'MadeTube');
  assert.equal(siteName('HentaiHaven - Watch Hentai Online Free in HD Quality', 'https://hentaihaven.xxx/'), 'HentaiHaven');
  assert.equal(siteName('Gelbooru', 'https://gelbooru.com/'), 'Gelbooru');
  assert.equal(siteName('Watch the best free porn videos online in full HD, updated daily for you', 'https://sexfilmegratis.org/'), 'Sexfilmegratis');
  assert.equal(siteName('', 'https://www.nhentai.net/'), 'Nhentai');
});

test('pool runs everything with bounded concurrency', async () => {
  let active = 0, peak = 0; const seen = [];
  await pool([...Array(25).keys()], 4, async i => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 2)); seen.push(i); active--;
  });
  assert.equal(seen.length, 25);
  assert.ok(peak <= 4);
});

test('mirrors on other TLDs share a brand key; sites on a platform subdomain have none', () => {
  assert.equal(brandKey('https://www.drtuber.desi/'), 'drtuber');
  assert.equal(brandKey('https://drtuber.club/'), 'drtuber');
  assert.equal(brandKey('https://de.example.co.uk/'), 'example');
  assert.equal(brandKey('https://foo.blogspot.com/'), null);
  assert.equal(brandKey('https://sukebei.nyaa.si/'), null);
  assert.equal(brandKey('not a url'), null);
});

test('SEO page titles are cut down to the brand; long brandless titles become the host', () => {
  const cases = [
    ['Hentai Pulse &raquo; The Best Hentai Streaming Sit', 'https://hentaipulse.com/', 'Hentai Pulse'],
    ['HENTAIA | BEST FREE HENTAI Online 2025', 'https://hentaia.net/', 'HENTAIA'],
    ['Hentai Ocean - Watch the best hentai!', 'https://hentaiocean.com/', 'Hentai Ocean'],
    ['League of Legends Hentai & Porn | LoLHentai.net', 'https://lolhentai.net/', 'LoLHentai.net'],
    ['Seu Hentai: Quadrinhos Eróticos, Hentais E HQs Por', 'https://seuhentai.com/', 'Seu Hentai'],
    ['Kemono Party: Patreon & Fanbox archive', 'https://kemono.party/', 'Kemono Party'],
    ['Hentaifromhell &#8211; Free Translated Manga and D', 'https://hentaifromhell.org/', 'Hentaifromhell'],
    // A cut-off fragment of the domain is not the brand; the title is too long to keep.
    ['Interactive Porn Games with Real Scenes - Free-Str', 'https://www.free-strip-games.com/', 'free-strip-games.com'],
    ['Free Manhwa Hentai &amp; Hentai Manhwa Updated Liv', 'https://manhwahentai.me/', 'manhwahentai.me'],
    // A section subdomain (forum.) is not the brand.
    ['Forums - Hentai Heroes', 'https://forum.kinkoid.com/', 'Forums - Hentai Heroes'],
    // Real names are left alone.
    ['Steam (Adult Only)', 'https://store.steampowered.com/', 'Steam (Adult Only)'],
    ['Literotica Discussion Board', 'https://forum.literotica.com/', 'Literotica Discussion Board'],
    ['Re:Zero Fan Wiki', 'https://rezero.fandom.com/', 'Re:Zero Fan Wiki'],
    ['nHentai', 'https://nhentai.net/', 'nHentai'],
    // A short domain inside a longer word is not a match; the closest part wins.
    ['Discover Anime Shows to Watch - Ani.ME', 'https://ani.me/', 'Ani.ME'],
    ['Free Online Games on CrazyGames | Play Now!', 'https://www.crazygames.com/', 'crazygames.com'],
    // A bot-check page's title is not the site's name.
    ['One moment, please...', 'https://example-tube.com/', 'example-tube.com'],
    ['Just a moment...', 'https://www.example.org/', 'example.org'],
  ];
  for (const [name, url, want] of cases) assert.equal(cleanName(name, url), want, name);
});

test('non-video "hentai" sites get their specific category only on an unambiguous signal', () => {
  assert.equal(specificCategory('nHentai', 'The most famous doujinshi archive', 'nhentai.net'), 'Manga & Doujinshi');
  assert.equal(specificCategory('Seu Hentai', 'quadrinhos eróticos e HQs porno', 'seuhentai.com'), 'Manga & Doujinshi');
  assert.equal(specificCategory('Hentai Games, Sex Games', 'hentai Games, porn Games', 'wetpussygames.com'), 'Games & Visual Novels');
  assert.equal(specificCategory('Forums - Hentai Heroes', 'forum.kinkoid.com is a great resource for hentai streaming.', 'forum.kinkoid.com'),
    'Communities & Forums');
  // Video words keep a site in streaming; mixed signals change nothing.
  assert.equal(specificCategory('Hentai Ocean', 'Watch free hentai online', 'hentaiocean.com'), null);
  assert.equal(specificCategory('LoLHentai', 'Albums, Videos, Gifs, Games, and Comics', 'lolhentai.net'), null);
  assert.equal(specificCategory('Naruto Hentai', 'Porn Pictures, Flash Games, English Comics', 'narutohentaidb.com'), null);
});
