import { test as nodeTest } from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseOald, parseCambridge, parseOaldSuggestions, isOaldNotFound,
  parseMWCollegiate, parseMWThesaurus, discoverEntryUrls, mwStrip, clean
} from '../lib/parser.js';

const read = (p) => readFile(p, 'utf8');
const readJson = async (p) => JSON.parse(await read(p));

// 抓取到的官方页面原文出于版权原因不随仓库分发（见 README「测试数据」）。
// 缺少 fixture 时显式 skip 并说明如何补齐，而不是抛一个看不懂的 ENOENT。
const FIXTURE_HINT = '缺少 fixtures/html（未随仓库分发）：先运行 npm run spike 重新抓取（需联网）';
const test = (name, fn) => nodeTest(name, { skip: existsSync('fixtures/html/oald.html') ? false : FIXTURE_HINT }, fn);


const OALD_1 = 'fixtures/html/oald.html';
const OALD_2 = 'fixtures/html/oald_2.html';
const CAM = 'fixtures/html/cambridge.html';
const CAM_AFFECT = 'fixtures/html/cambridge-affect.html';
const SP = 'fixtures/html/spellcheck.html';
const SP_NONE = 'fixtures/html/spellcheck-none.html';
const MW_C = 'fixtures/mw-collegiate-raw.json';
const MW_T = 'fixtures/mw-thesaurus-raw.json';

test('OALD effect_1：词性/音标/音频/标签', async () => {
  const { entries } = parseOald(await read(OALD_1));
  assert.equal(entries.length, 1, 'effect_1 应为单一条目');
  const e = entries[0];
  assert.equal(e.headword, 'effect');
  assert.equal(e.pos, 'noun');
  assert.equal(e.ipa.uk, '/ɪˈfekt/');
  assert.equal(e.ipa.us, '/ɪˈfekt/');
  assert.match(e.audio.uk, /effect__gb_2\.mp3$/);
  assert.match(e.audio.us, /effect__us_1\.mp3$/);
  assert.equal(e.tags.oxford3000, true);
  assert.equal(e.tags.oxfordLevel, 'a2');
  assert.ok(e.tags.opal.length >= 2, '应有 OPAL W / OPAL S');
  assert.ok(e.tags.opal.every((s) => !s.includes('::')), 'OPAL 标签不得含内部标识串：' + JSON.stringify(e.tags.opal));
  assert.ok(e.tags.opal.some((s) => /^OPAL W \(Sublist 1\)$/.test(s)), 'OPAL 应格式化为可读形式，实际 ' + JSON.stringify(e.tags.opal));
});

test('OALD：CEFR 不得窃取 Word of the Day 别的词（铁律）', async () => {
  const { entries } = parseOald(await read(OALD_1));
  // 页面上唯一的 .cefr 属于 wotd-box 里的 enhance(B2)，不是 effect
  assert.equal(entries[0].tags.cefr, null, 'effect 在 OALD 无词级 CEFR，必须为 null 而不是 B2');
});

test('OALD effect_1：义项、例句、语法、标签', async () => {
  const { entries } = parseOald(await read(OALD_1));
  const e = entries[0];
  assert.ok(e.senses.length >= 4, 'senses 应 >= 4，实际 ' + e.senses.length);
  assert.match(e.senses[0].def, /^a change that somebody\/something causes/);
  assert.equal(e.senses[0].grammar, '[countable, uncountable]');
  assert.ok(e.senses[0].examples.length > 0, '第一义项应带官方例句');
  assert.match(e.senses[0].examples[0].en, /beneficial effects of exercise/);
});

test('OALD：例句自带的官方搭配框架（.cf）必须保留', async () => {
  const { entries } = parseOald(await read(OALD_1));
  const framed = [];
  for (const s of entries[0].senses) for (const ex of s.examples) if (ex.frame) framed.push(ex);
  assert.ok(framed.length > 0, '应捕获到官方搭配框架，实际 0 条');
  assert.ok(framed.some((f) => /effect on somebody|for effect/.test(f.frame)), '框架内容应含官方搭配，实际 ' + JSON.stringify(framed.map((f) => f.frame).slice(0, 4)));
});

test('OALD：官方分类搭配来自免费片段且分类正确', async () => {
  const { entries } = parseOald(await read(OALD_1));
  const cats = entries[0].collocations.categories;
  assert.ok(cats.length >= 4, '搭配类目应 >= 4，实际 ' + cats.length);
  const types = cats.map((c) => c.type);
  assert.ok(types.includes('adjective'), '缺少 adjective 类目');
  assert.ok(types.includes('verb + effect'), '缺少 verb + effect 类目');
  assert.ok(types.includes('preposition'), '缺少 preposition 类目');
  const adj = cats.find((c) => c.type === 'adjective');
  assert.ok(adj.items.includes('decisive'));
  assert.ok(adj.items.includes('dramatic'));
  assert.ok(!adj.items.includes('…'), '省略号必须被过滤');
  assert.match(entries[0].collocations.seeFullEntry, /\/definition\/collocations\/effect_1$/);
});

test('OALD：词源 / 词族 / Which Word 官方用法说明', async () => {
  const { entries } = parseOald(await read(OALD_1));
  const e = entries[0];
  assert.match(e.wordOrigin, /late Middle English/);
  assert.ok(e.wordFamily && /effective/.test(e.wordFamily), '词族应含 effective');
  assert.equal(e.usageNotes.length, 1);
  assert.match(e.usageNotes[0].title, /Which Word\? affect \/ effect/);
  assert.match(e.usageNotes[0].text, /influence on somebody/);
});

test('OALD effect_2 是动词条目', async () => {
  const { entries } = parseOald(await read(OALD_2));
  assert.equal(entries[0].pos, 'verb');
  assert.equal(entries[0].senses.length, 1);
});

test('discoverEntryUrls 发现同词其他词性页', async () => {
  const html = await read(OALD_1);
  const base = 'https://www.oxfordlearnersdictionaries.com/definition/english/effect_1';
  const urls = discoverEntryUrls(html, base);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].endsWith('effect_1'));
  assert.ok(urls[1].endsWith('effect_2'));
  assert.ok(!urls.some((u) => u.includes('american_english')), '不得混入美式词条页');
  assert.ok(!urls.some((u) => u.includes('collocations')), '不得混入搭配页');
});

test('OALD 未收录页识别 + 拼写建议两分支', async () => {
  assert.equal(isOaldNotFound(await read(SP)), true);
  const sugg = parseOaldSuggestions(await read(SP));
  assert.ok(sugg.includes('adverse'), '应建议 adverse，实际 ' + JSON.stringify(sugg));
  assert.ok(sugg.includes('averse'));
  assert.deepEqual(parseOaldSuggestions(await read(SP_NONE)), [], '无建议时必须是空数组');
});

test('剑桥：词性去重 + 英美音标', async () => {
  const { entries, duplicatesRemoved } = parseCambridge(await read(CAM));
  assert.deepEqual(entries.map((e) => e.pos).sort(), ['noun', 'verb']);
  assert.ok(duplicatesRemoved >= 2, '应剔除重复词性块');
  const noun = entries.find((e) => e.pos === 'noun');
  assert.equal(noun.ipa.uk, 'ɪˈfekt');
  assert.equal(noun.ipa.us, 'əˈfekt');
  assert.ok(noun.senses.length >= 4);
  assert.ok(noun.senses[0].examples.length > 0);
});

test('剑桥 affect 回退可用（OALD 确为 404）', async () => {
  const { entries } = parseCambridge(await read(CAM_AFFECT));
  const pos = entries.map((e) => e.pos);
  assert.ok(pos.includes('verb'), 'affect 应解析出动词，实际 ' + JSON.stringify(pos));
  const total = entries.reduce((a, e) => a + e.senses.length, 0);
  assert.ok(total >= 3, 'affect 义项应 >= 3，实际 ' + total);
});

test('MW Collegiate：词源/释义/例句且无残留标记', async () => {
  const mw = parseMWCollegiate(await readJson(MW_C));
  assert.ok(mw.etymology && mw.etymology.length > 50);
  assert.ok(mw.shortdefs.length > 0);
  assert.ok(mw.examples.length > 0, 'MW 例句应 > 0');
  assert.ok(mw.pronunciation);
  const all = [mw.etymology].concat(mw.shortdefs, mw.examples.map((e) => e.en)).join(' ');
  assert.ok(!/[{}]/.test(all), 'MW 标记必须清洗干净：' + all.slice(0, 120));
  assert.ok(!/\{it\}|\{bc\}|\{sx/.test(all));
});

test('MW Thesaurus：同义/反义/例句', async () => {
  const mwt = parseMWThesaurus(await readJson(MW_T));
  assert.ok(mwt.synonyms.length > 5, '同义词应 > 5，实际 ' + mwt.synonyms.length);
  assert.ok(mwt.antonyms.length > 0, '反义词应 > 0');
  assert.ok(mwt.examples.length > 0, '例句应 > 0');
  assert.ok(mwt.synonyms.includes('result') || mwt.synonyms.includes('consequence'));
});

test('MW 建议分支：字符串数组 = 拼写建议，不是词条', async () => {
  const c = parseMWCollegiate(['effect', 'effectuate']);
  assert.deepEqual(c.suggestions, ['effect', 'effectuate']);
  assert.deepEqual(c.shortdefs, []);
  const t = parseMWThesaurus(['effect']);
  assert.deepEqual(t.suggestions, ['effect']);
  assert.deepEqual(t.synonyms, []);
});

test('mwStrip 清洗 MW 标记', () => {
  assert.equal(mwStrip('{bc}an event {sx|result|result:2|} that is produced'), '• an event result that is produced');
  assert.equal(mwStrip('the {wi}effects{/wi} of the policy'), 'the effects of the policy');
  assert.equal(clean('a\u200bb  c'), 'ab c');
});
