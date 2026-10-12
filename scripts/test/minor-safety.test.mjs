// Run: node --test 'scripts/test/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMinorSafety, isProhibited, isMinorSafe, isListingVisible, PROHIBITED_TERMS } from '../../src/prohibited.js';

const verdict = (...parts) => checkMinorSafety(...parts).verdict;

test('blocks definitive child-abuse indicators', () => {
  for (const text of [
    'https://candydoll.top', 'Amateur Girls Forum candydoll', 'Art girls nymphets nude',
    'lolicon hentai archive', 'free shotacon', 'jailbait pics', 'preteen gallery',
    'pedo forum', 'PTHC links', 'child porn', 'kids porn', 'baby sex', 'minor nude',
    'cp videos', 'c.p. links', 'junior idol photos', 'teen model studio', 'little girls',
    'young boy pics', '15yo girl', '13 y/o', 'aged 14', 'u15 gravure', 'under 16 years',
    'tweens', 'ninfetas brasileiras', 'menores de edad', 'ロリ 同人', 'ジュニアアイドル', '小学生',
    '萝莉', 'малолетки', 'детское порно', 'pédophile',
  ]) assert.equal(verdict(text), 'block', text);
});

test('sees through obfuscation', () => {
  for (const text of [
    'l0l1 hentai', 'l0li', 'sh0ta', 'p3do', 'j@ilb@it', 'l.o.l.i', 'l o l i con', 's-h-o-t-a',
    'ＬＯＬＩ', 'lolì', 'ｊａｉｌｂａｉｔ', 'ﾛﾘ',
  ]) assert.equal(verdict(text), 'block', text);
});

test('restricts ambiguous age signals', () => {
  for (const text of [
    'teen cams', 'Teens Webcam', 'teenporn', 'schoolgirl cosplay', 'school girls',
    'young and horny', 'barely legal', 'JK uniform', '16 years old', 'novinhas', 'kids',
    '女子高生', 'youth',
  ]) assert.equal(verdict(text), 'restrict', text);
});

test('restricts age signals run into other words (domain-style names)', () => {
  for (const text of [
    'https://sweetteentits.com', 'Sweetteentits', 'https://hotteens.xxx', 'xteenx', '18teens',
    'thirteen', 'hotschoolgirls', 'freshyoungporn', 'https://youngsex.example',
  ]) assert.equal(verdict(text), 'restrict', text);
});

test('leaves ordinary listings alone', () => {
  for (const text of [
    'https://nhentai.net nHentai The largest doujinshi archive',
    'Hololive VTuber fan wiki', 'Gelbooru anime image board', 'Steam (Adult Only)',
    'Top 10 hentai sites rated 4/5', 'Only for adults. No one under 18 allowed.',
    'Loads in under 5 seconds', 'Founded 2010, 12 categories', 'https://18comic.vip',
    'torpedo games', 'Ahegao and NTR doujins', 'FAKKU! licensed hentai manga',
    'https://www.ign.com', 'Live cams with mature models',
    'Eighteen and over only', 'nineteen99 archive', 'Canteen recipes', 'Velveteen Rabbit',
    'sateen sheets', 'Schoolhouse Rock', 'Youngblood comics',
  ]) assert.equal(verdict(text), 'ok', text);
});

test('checks every field passed in, including arrays', () => {
  assert.equal(verdict('https://example.com', 'Example', ['anime', 'teen']), 'restrict');
  assert.equal(verdict(null, undefined, '', 'nymphet'), 'block');
  assert.equal(verdict(), 'ok');
});

test('helpers agree with the verdict', () => {
  assert.equal(isProhibited('loli'), true);
  assert.equal(isProhibited('teen'), false);
  assert.equal(isMinorSafe('teen'), false);
  assert.equal(isMinorSafe('nhentai'), true);
});

test('listing visibility: blocked and restricted never shown', () => {
  assert.equal(isListingVisible({ url: 'https://a.com', name: 'Loli X' }), false);
  assert.equal(isListingVisible({ url: 'https://teencams.com', name: 'TeenCams' }), false);
  assert.equal(isListingVisible({ url: 'https://nhentai.net', name: 'nHentai', tags: ['doujin'] }), true);
  assert.equal(isListingVisible({ url: 'https://x.com', name: 'X', tags: ['schoolgirl'] }), false);
  assert.equal(isListingVisible(null), false);
});

test('database terms stay SQL-safe', () => {
  for (const t of PROHIBITED_TERMS) assert.ok(!/['\\]/.test(t) && t === t.toLowerCase(), t);
});
