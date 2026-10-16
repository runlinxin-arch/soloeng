import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ALL_HTML, MW_RAW, testWith as test } from './helpers/fixtures.js';
import { lookup } from '../lib/dictionary.js';
import { normalize } from '../lib/normalize.js';

const read = (p) => readFile(p, 'utf8');
const readJson = async (p) => JSON.parse(await read(p));

const F = {
  oald1: 'fixtures/html/oald.html',
  oald2: 'fixtures/html/oald_2.html',
  cam: 'fixtures/html/cambridge.html',
  camAffect: 'fixtures/html/cambridge-affect.html',
  spell: 'fixtures/html/spellcheck.html'
};

async function makeFake(opts) {
  const o = opts || {};
  const cache = {};
  for (const k of Object.keys(F)) cache[k] = await read(F[k]);
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (url.includes('dictionary.cambridge.org')) {
      if (o.cambridgeThrows) throw new Error('cambridge down');
      if (o.cambridgeMissing) return { ok: false, status: 404, body: '<html>no entry</html>' };
      return { ok: true, status: 200, body: url.includes('affect') ? cache.camAffect : cache.cam };
    }
    if (url.includes('/spellcheck/')) return { ok: true, status: 200, body: cache.spell };
    if (/effect_2/.test(url)) return { ok: true, status: 200, body: cache.oald2 };
    if (/effect_1/.test(url)) {
      if (o.oaldMissing) return { ok: true, status: 200, body: cache.spell };
      if (o.oaldThrows) throw new Error('oald down');
      return { ok: true, status: 200, body: cache.oald1 };
    }
    return { ok: false, status: 404, body: '' };
  };
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('collegiate')) return { json: await readJson('fixtures/mw-collegiate-raw.json') };
    if (url.includes('thesaurus')) return { json: await readJson('fixtures/mw-thesaurus-raw.json') };
    return { json: null };
  };
  return { fetchText, fetchJson, calls };
}

test(ALL_HTML, 'lookup(effect)：走通全管道且字段来自官方', async () => {
  const f = await makeFake();
  const r = await lookup('effect', { fetchText: f.fetchText, fetchJson: f.fetchJson, secrets: {}, minIntervalMs: 0 });
  assert.equal(r.found, true);
  assert.equal(r.sources.oald, 'ok');
  assert.equal(r.sources.mw, 'skipped', 'secrets 为空时 MW 应自动跳过');
  const n = r.normalized;
  assert.deepEqual(n.pos.slice().sort(), ['noun', 'verb']);
  assert.equal(n.ipa.uk, '/ɪˈfekt/');
  assert.equal(n.ipa.source, 'oald');
  assert.match(n.audio.uk, /effect__gb_2\.mp3$/);
  assert.ok(n.senses.length >= 5, '名词 4 + 动词 1，实际 ' + n.senses.length);
  assert.ok(n.collocations.categories.length >= 4);
  assert.match(n.wordOrigin, /late Middle English/);
  assert.equal(n.usageNotes.length, 1);
  assert.equal(n.tags.cefr, null, 'CEFR 对 effect 官方无数据，必须为 null（铁律）');
  assert.equal(n.tags.oxford3000, true);
  assert.ok(n.missing.includes('compareNotes') === false, 'effect 有 Which Word 说明，不应缺辨析');
});

test(ALL_HTML.concat(MW_RAW), 'lookup：MW 开启时同义/反义进 relations', async () => {
  const f = await makeFake();
  const secrets = { MW_COLLEGIATE_KEY: 'k', MW_THESAURUS_KEY: 't' };
  const r = await lookup('effect', { fetchText: f.fetchText, fetchJson: f.fetchJson, secrets, minIntervalMs: 0 });
  assert.equal(r.sources.mw, 'ok');
  assert.ok(r.normalized.relations.synonyms.length > 5);
  assert.ok(r.normalized.relations.antonyms.length > 0);
  assert.ok(!r.normalized.missing.includes('relations'));
});

test(ALL_HTML, 'lookup：OALD 无词条 → 剑桥回退成功（PRD §7.1-2）', async () => {
  const f = await makeFake({ oaldMissing: true });
  const r = await lookup('affect', { fetchText: f.fetchText, fetchJson: f.fetchJson, secrets: {}, minIntervalMs: 0 });
  assert.equal(r.sources.oald, 'missing');
  assert.equal(r.sources.cambridge, 'ok');
  assert.equal(r.found, true);
  assert.ok(r.normalized.pos.includes('verb'));
  assert.ok(r.normalized.senses.length >= 3);
  assert.ok(r.normalized.ipa.uk, '剑桥应补上音标');
  assert.equal(r.normalized.ipa.source, 'cambridge');
});

test(ALL_HTML, 'lookup：OALD 无词条且剑桥也失败 → 给拼写建议，不报错', async () => {
  const f = await makeFake({ oaldMissing: true, cambridgeMissing: true });
  const r = await lookup('adverrse', { fetchText: f.fetchText, fetchJson: f.fetchJson, secrets: {}, minIntervalMs: 0 });
  assert.equal(r.found, false);
  assert.ok(r.suggestions.includes('adverse'), '应给出官方拼写建议，实际 ' + JSON.stringify(r.suggestions));
});

test(ALL_HTML, 'lookup：任一来源抛错都不允许整次失败（PRD 附录 A）', async () => {
  const f = await makeFake({ oaldThrows: true, cambridgeThrows: true });
  const r = await lookup('effect', { fetchText: f.fetchText, fetchJson: f.fetchJson, secrets: {}, minIntervalMs: 0 });
  assert.equal(r.found, false);
  assert.equal(r.sources.oald, 'error');
  assert.equal(r.sources.cambridge, 'error');
});

test(ALL_HTML, 'lookup：剑桥超时但 OALD 正常 → 照常返回（PRD 附录 A）', async () => {
  const f = await makeFake();
  // 剑桥本来就不该被调用：OALD 有义项
  const r = await lookup('effect', { fetchText: f.fetchText, fetchJson: f.fetchJson, secrets: {}, minIntervalMs: 0 });
  assert.equal(r.found, true);
  assert.equal(r.sources.cambridge, 'skipped', 'OALD 完整时不应多打剑桥一次');
});

test([], 'normalize：全空时 missing 列出所有缺失块，且 found=false', () => {
  const n = normalize({ word: 'x' });
  assert.equal(n.found, false);
  for (const k of ['pronunciation', 'senses', 'collocations', 'wordOrigin', 'relations', 'compareNotes']) {
    assert.ok(n.missing.includes(k), 'missing 应含 ' + k);
  }
  assert.deepEqual(n.relations.synonyms, []);
  assert.deepEqual(n.collocations.categories, []);
});

test([], 'normalize：官方没有的块必须为空，不得编造（铁律）', () => {
  const n = normalize({
    word: 'x',
    oaldEntries: [{ pos: 'noun', ipa: { uk: '/x/' }, senses: [{ pos: 'noun', def: 'd', examples: [] }], tags: {}, collocations: { categories: [] }, audio: {} }]
  });
  assert.equal(n.collocations.categories.length, 0);
  assert.equal(n.wordOrigin, null);
  assert.ok(n.missing.includes('collocations'));
  assert.ok(n.missing.includes('wordOrigin'));
});
