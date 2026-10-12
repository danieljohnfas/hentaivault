/**
 * Minor-safety rules. Nothing that sexualises, depicts or targets minors may be
 * listed, queued, rendered, linked to or indexed, by any code path. Fully
 * automatic: there is no manual approval step and no override.
 *
 * Two tiers, both removed from the directory:
 *   block     Definitive child-abuse indicators. D1 triggers also refuse them
 *             (PROHIBITED_TERMS), so no write path can store them.
 *   restrict  Ambiguous age signals ("teen", "schoolgirl", "young", ages in years).
 *
 * Every entry point (submissions, scout, daily-add, Worker discovery, reviews)
 * rejects both tiers, the Worker refuses to render or link them, and the sweep
 * (scripts/minor-safety-sweep.mjs) deletes any listing or queued submission that
 * matches, including ones written by manual SQL or caught by a newly added rule.
 *
 * Text is normalised before matching so obfuscation does not get through:
 * accents and stylised/full-width characters are folded (NFKD), leetspeak is
 * decoded (l0l1, p3d0), and letters spaced out with separators are joined (l.o.l.i).
 *
 * Shared by the Worker (ESM import) and the Node pipeline scripts (require()).
 * scripts/ops/build-prohibited-triggers.js regenerates the D1 triggers from
 * PROHIBITED_TERMS after any change; scripts/test/minor-safety.test.mjs must pass.
 */

// Plain lowercase substrings (no quotes): also enforced inside D1 by triggers and by
// the SQL guard on every listing query, so they must stay SQL-safe.
export const PROHIBITED_TERMS = [
  'jailbait', 'jail-bait', 'jbcam', 'jbteen', 'jb-teen',
  'loli', 'shota', 'lolita',
  'underage', 'under-age', 'preteen', 'pre-teen', 'pthc', 'childporn', 'child-porn', 'child porn',
  'kiddie', 'toddler', 'schoolgirl-porn',
  'pedophil', 'paedophil', 'pedobear', 'child sex', 'kids porn', 'kid porn',
  // "family/teen nudism" galleries are a well-known CSAM front in adult directories
  'nudism', 'nudist', 'naturist', 'teen young', 'teen-young', 'young teen', 'young-teen',
  // child "model" studios and long-standing CSAM search keywords
  'candydoll', 'candy-doll', 'candy doll', 'nymphet', 'ls-models', 'lsmodels', 'ls-island',
  'hussyfan', 'ptsc', 'qqaazz', 'kinderporn', 'kinder porn',
  'childlover', 'child lover', 'boylover', 'boy lover', 'girllover',
  'child model', 'child-model', 'childmodel', 'teen model', 'teen-model', 'teenmodel',
  'junior idol', 'junioridol', 'jr idol', 'prepubescent', 'pre-pubescent',
  'little girl', 'little boy', 'young girl', 'young boy', 'minor sex', 'sex with minor',
  'ninfet', 'pedofil', 'menor de edad', 'menores de edad', 'minderjahrig', 'minderjährig',
  // Japanese / Chinese / Russian
  'ロリ', 'ショタ', '幼女', '幼児', '小学生', '中学生', '児童', 'ジュニアアイドル', '未成年',
  '萝莉', '幼齿', 'малолет', 'лолит', 'педофил', 'детское порно',
];

// Word-aware patterns for terms that are too short or ambiguous as plain substrings.
// `base: true` patterns run on the un-decoded text (leetspeak decoding rewrites digits).
const BLOCK_PATTERNS = [
  { name: 'pedo', re: /\bpa?edo(?!met)/ },
  { name: 'cp', re: /\bc\.?p\.?\s*(?:porn|pics?|videos?|vids?|links?|collection|archive|cams?)\b/ },
  { name: 'tween', re: /\btweens?\b/ },
  // "under 18" itself is the standard age disclaimer, so only ages below it count.
  { name: 'under-18', re: /\bunder\s*-?\s*(?:1[0-7]|[1-9])\s*-?\s*(?:yo|y\/o|years?|yrs?)\b|\bu-?1[0-7]\b/, base: true },
  { name: 'age-yo', re: /\b(?:[1-9]|1[0-7])\s*-?\s*(?:yo|y\/o|y\.o\.?|yrs?\s*old)\b/, base: true },
  { name: 'aged-under-18', re: /\baged?\s*(?:[1-9]|1[0-7])\b/, base: true },
  { name: 'child-sexual', re: /\b(?:child(?:ren)?|kids?|bab(?:y|ies)|infants?)\s*-?\s*(?:porn|sex|nude|naked|erotic|lewd|hentai|xxx)/ },
  { name: 'minor-sexual', re: /\bminors?\s*-?\s*(?:porn|sex|nude|naked|erotic|lewd|hentai|xxx)/ },
];

// Domains and SEO names run words together ("sweetteentits", "hotschoolgirls"), so
// these also match inside a word; the lookbehind spares eighteen, nineteen,
// canteen, velveteen and sateen.
const RESTRICT_PATTERNS = [
  { name: 'teen', re: /(?<!eigh|nine|can|velve|sa)teen/ },
  { name: 'schoolgirl', re: /school\s*-?\s*girls?/ },
  { name: 'young', re: /\byoung(?:er|est)?\b|\byouth|young(?:er|est)?\s*-?\s*(?:girls?|boys?|porn|sex|teens?|pussy|nudes?|xxx)/ },
  { name: 'child', re: /\bkids?\b|\bchild|\bminors?\b/ },
  { name: 'barely-legal', re: /\bbarely\s*-?\s*(?:legal|18)\b/ },
  { name: 'jk-jc', re: /\bj[kc]\b/ },
  { name: 'age-years', re: /\b(?:[1-9]|1[0-7])\s*-?\s*years?\s*-?\s*old\b/, base: true },
  { name: 'colegial', re: /\bcolegial|\bnovinh|\bjovencit/ },
  { name: 'cjk-schoolgirl', re: /女子高生|女子中学生|少女/ },
];

// Known-safe words that contain a blocked substring (hololive ⊃ "loli").
const ALLOW_TOKENS = ['hololive'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' };

function fold(text) {
  let t = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const token of ALLOW_TOKENS) t = t.split(token).join(' ');
  return t;
}

// "l o l i", "l.o.l.i", "l-o-l-i" → "loli"
const joinSpacedLetters = s => s.replace(/(?<![a-z])(?:[a-z][\s._*\-]+){2,}[a-z](?![a-z])/g, m => m.replace(/[\s._*\-]+/g, ''));

function variants(text) {
  const base = fold(text);
  const leetI = base.replace(/[0134578@$!|+]/g, c => LEET[c]);
  const leetL = base.replace(/1/g, 'l').replace(/[034578@$!|+]/g, c => LEET[c]);
  const decoded = [...new Set([base, leetI, leetL].flatMap(s => [s, joinSpacedLetters(s)]))];
  return { base, decoded };
}

// Terms folded the same way as the text (NFKD splits e.g. ジ into シ + dakuten).
const FOLDED_TERMS = PROHIBITED_TERMS.map(t => [t, fold(t)]);

function firstMatch(rules, v) {
  for (const r of rules) {
    const texts = r.base ? [v.base] : v.decoded;
    if (texts.some(t => r.re.test(t))) return r.name;
  }
  return null;
}

/**
 * Checks any number of text fields (url, name, description, tags, page title...).
 * Returns { verdict: 'block' | 'restrict' | 'ok', rule }.
 */
export function checkMinorSafety(...parts) {
  const text = parts.flat().filter(Boolean).join(' \n ');
  if (!text) return { verdict: 'ok', rule: null };
  const v = variants(text);
  const term = FOLDED_TERMS.find(([, f]) => v.decoded.some(s => s.includes(f)));
  if (term) return { verdict: 'block', rule: term[0] };
  const blockRule = firstMatch(BLOCK_PATTERNS, v);
  if (blockRule) return { verdict: 'block', rule: blockRule };
  const restrictRule = firstMatch(RESTRICT_PATTERNS, v);
  if (restrictRule) return { verdict: 'restrict', rule: restrictRule };
  return { verdict: 'ok', rule: null };
}

/** Hard block: must never be stored, shown or linked. */
export function isProhibited(...parts) {
  return checkMinorSafety(...parts).verdict === 'block';
}

/** Safe to publish: neither blocked nor restricted. */
export function isMinorSafe(...parts) {
  return checkMinorSafety(...parts).verdict === 'ok';
}

/** Whether a stored listing may be shown, linked or indexed. */
export function isListingVisible(site) {
  if (!site) return false;
  const tags = Array.isArray(site.tags) ? site.tags.join(' ') : site.tags;
  return isMinorSafe(site.url, site.name, site.description, tags);
}
