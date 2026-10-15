import { mkdir, writeFile } from 'node:fs/promises';
import { applyNetworkMode, proxyEnvPresent, fetchText, fetchJson } from '../lib/fetcher.js';
import {
  parseOald, parseCambridge, parseOaldSuggestions, parseMWCollegiate,
  parseMWThesaurus, discoverEntryUrls, clean
} from '../lib/parser.js';
import { getSecrets } from '../lib/secrets.js';

const t0 = Date.now();
console.log('=== 网络模式（PRD 风险：代理可能指向死端口）===');
console.log('  改动前代理变量:', proxyEnvPresent().join(', ') || '(无)');
const net = applyNetworkMode('direct');
console.log('  已切换 direct，移除:', net.removed.join(', ') || '(无)');

const secrets = await getSecrets();
console.log('=== 密钥状态（只打印布尔）===');
console.log('  ', JSON.stringify(secrets.status));

await mkdir('fixtures/html', { recursive: true });

function save(name, body) { return writeFile('fixtures/html/' + name + '.html', body); }
function saveJson(name, obj) { return writeFile('fixtures/' + name + '.json', JSON.stringify(obj, null, 2)); }

const timings = {};

/* ---------- T0.1 OALD（含多词性发现） ---------- */
const w = 'effect';
const base = 'https://www.oxfordlearnersdictionaries.com/definition/english/' + w + '_1';
const r1 = await fetchText(base);
timings.oald1 = r1.ms;
await save('oald', r1.body);
const urls = discoverEntryUrls(r1.body, base);
console.log('\n=== T0.1 OALD effect :: 发现的词性页面 ===');
console.log('  ', urls.join('\n   '));

const oaldPages = [];
for (const u of urls) {
  const r = u === base ? r1 : await fetchText(u);
  if (u !== base) { timings['oald_' + u.split('_').pop()] = r.ms; await save('oald_' + u.split('_').pop(), r.body); }
  const parsed = parseOald(r.body);
  oaldPages.push({ url: u, status: r.status, ...parsed, $: undefined });
}

const oaldSummary = oaldPages.map((p) => {
  const e = p.entries[0] || {};
  return {
    url: p.url,
    pos: e.pos,
    headword: e.headword,
    ipa: e.ipa,
    audio: e.audio,
    tags: e.tags,
    senses: (e.senses || []).length,
    collocationCategories: (e.collocations && e.collocations.categories || []).length,
    hasWordOrigin: Boolean(e.wordOrigin),
    hasWordFamily: Boolean(e.wordFamily),
    hasSynonymsBlock: Boolean(e.synonymsBlock),
    usageNotes: (e.usageNotes || []).map((n) => n.title),
    idioms: (e.idioms || []).length
  };
});
console.log('\n=== T0.1 解析结果（按词性）===');
console.log(JSON.stringify(oaldSummary, null, 2));
await saveJson('oald-effect', oaldSummary);

const first = oaldPages[0].entries[0];
console.log('\n--- 首个词性的例句样本 ---');
console.log(JSON.stringify((first.senses[0].examples || []).slice(0, 2), null, 2));
console.log('--- 官方分类搭配（免费片段）---');
console.log(JSON.stringify(first.collocations.categories, null, 2));

/* ---------- T0.2 剑桥（含 affect 回退用例） ---------- */
console.log('\n=== T0.2 剑桥 effect ===');
const camUrl = 'https://dictionary.cambridge.org/dictionary/english/effect';
const rc = await fetchText(camUrl);
timings.cambridge = rc.ms;
await save('cambridge', rc.body);
const cam = parseCambridge(rc.body);
console.log('  词性:', cam.entries.map((e) => e.pos).join(', '), '| 义项数:', cam.entries.reduce((a, e) => a + e.senses.length, 0));
console.log('  音标:', JSON.stringify(cam.entries.map((e) => e.ipa)));
await saveJson('cam-effect', cam.entries.map((e) => ({ pos: e.pos, ipa: e.ipa, senses: e.senses.length })));

console.log('\n=== T0.2b 剑桥 affect（OALD 无词条 → 回退用例）===');
const rA = await fetchText('https://dictionary.cambridge.org/dictionary/english/affect');
await save('cambridge-affect', rA.body);
const camA = parseCambridge(rA.body);
console.log('  status=', rA.status, '| 词性:', camA.entries.map((e) => e.pos).join(', '),
  '| 义项:', camA.entries.reduce((a, e) => a + e.senses.length, 0));
await saveJson('cam-affect', camA.entries.map((e) => ({ pos: e.pos, ipa: e.ipa, senses: e.senses.map((s) => s.def.slice(0, 60)) })));

/* ---------- T0.3 Collocations 页（付费墙确认） ---------- */
console.log('\n=== T0.3 Oxford Collocations Dictionary 整页可达性 ===');
const { load } = await import('cheerio');
const rColl = await fetchText('https://www.oxfordlearnersdictionaries.com/definition/collocations/effect_1');
await save('coll', rColl.body);
const $c = load(rColl.body);
const restricted = $c('.entry-unauthorised').length > 0;
console.log('  status=', rColl.status, '| 付费墙(entry-unauthorised)=', restricted);
console.log('  结论: ' + (restricted
  ? '整页付费 → 按已批准降级链（MW 惯用短语 → 标「未收录」）；但定义页免费片段已提供官方分类搭配'
  : '整页可解析'));
await saveJson('coll-access', { status: rColl.status, paywalled: restricted, reason: clean($c('.entry-unauthorised .restrictedLock').text()) });

/* ---------- T0.4 MW ---------- */
console.log('\n=== T0.4 Merriam-Webster ===');
const mwOut = {};
if (secrets.status.mwCollegiate) {
  const rMW = await fetchJson('https://www.dictionaryapi.com/api/v3/references/collegiate/json/' + w + '?key=' + secrets.values.MW_COLLEGIATE_KEY);
  await saveJson('mw-collegiate-raw', rMW.json);
  const mw = parseMWCollegiate(rMW.json);
  mwOut.collegiate = { etymology: mw.etymology, shortdefs: mw.shortdefs, pos: mw.pos, examples: mw.examples.length, pronunciation: mw.pronunciation };
  console.log('  Collegiate: 词源=', mw.etymology ? '有(' + mw.etymology.length + '字)' : '无',
    '| 释义=', mw.shortdefs.length, '| 例句=', mw.examples.length, '| 音标=', mw.pronunciation);
} else console.log('  跳过：MW Collegiate key 未配置');

if (secrets.status.mwThesaurus) {
  const rMWT = await fetchJson('https://www.dictionaryapi.com/api/v3/references/thesaurus/json/' + w + '?key=' + secrets.values.MW_THESAURUS_KEY);
  const mwt = parseMWThesaurus(rMWT.json);
  mwOut.thesaurus = { synonyms: mwt.synonyms.slice(0, 8), antonyms: mwt.antonyms.slice(0, 5), examples: mwt.examples.length, synCount: mwt.synonyms.length };
  console.log('  Thesaurus: 同义=', mwt.synonyms.length, '| 反义=', mwt.antonyms.length, '| 例句=', mwt.examples.length);
} else console.log('  跳过：MW Thesaurus key 未配置');
await saveJson('mw-effect', mwOut);

/* ---------- T0.5 拼写建议 ---------- */
console.log('\n=== T0.5 拼写建议 ===');
const rSp = await fetchText('https://www.oxfordlearnersdictionaries.com/spellcheck/english/?q=adverrse');
await save('spellcheck', rSp.body);
const sugg = parseOaldSuggestions(rSp.body);
console.log('  adverrse →', JSON.stringify(sugg.slice(0, 6)));
const rNone = await fetchText('https://www.oxfordlearnersdictionaries.com/spellcheck/english/?q=zzzzqqqq');
await save('spellcheck-none', rNone.body);
const suggNone = parseOaldSuggestions(rNone.body);
console.log('  zzzzqqqq →', JSON.stringify(suggNone.slice(0, 6)));
await saveJson('spellcheck', { adverrse: sugg, zzzzqqqq: suggNone });

console.log('\n=== 抓取耗时（ms）===');
console.log(JSON.stringify(timings, null, 2));
console.log('总耗时 ms:', Date.now() - t0);
