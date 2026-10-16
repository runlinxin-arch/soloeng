import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { tempDir } from './helpers/tmp.js';
;
import { join } from 'node:path';
import { createService } from '../lib/service.js';
import * as store from '../lib/store.js';
import { readCard } from '../lib/store.js';

const tmp = () => tempDir('engsvc-');

function norm(word, extra) {
  return Object.assign({
    word,
    ipa: { uk: '/x/', us: '/x/' },
    audio: { uk: 'https://www.oxfordlearnersdictionaries.com/media/a.mp3', us: null },
    pos: ['noun'],
    tags: { cefr: null, oxford3000: true, opal: [] },
    senses: [{ pos: 'noun', def: 'official def', examples: [{ en: 'official example' }] }],
    collocations: { categories: [{ type: 'adjective', items: ['decisive'] }] },
    relations: { synonyms: ['result'], antonyms: [], wordFamily: null },
    wordOrigin: 'late Middle English',
    usageNotes: [{ type: 'which_word', title: 'W', text: 'note' }],
    idioms: [],
    missing: [],
    found: true
  }, extra || {});
}

async function world(over) {
  const vault = await tmp();
  const events = [];
  const calls = { lookup: 0, generateCard: 0, generateCompare: 0, generateRoots: 0 };
  const o = over || {};
  const deps = {
    store,
    lookup: async (w) => {
      calls.lookup++;
      if (o.lookupImpl) return o.lookupImpl(w);
      return { word: w, found: true, normalized: norm(w), suggestions: [] };
    },
    generateCard: async (n, opts) => {
      calls.generateCard++;
      if (o.cardImpl) return o.cardImpl(n, opts);
      return { ok: true, text: '## 核心释义\n**n.** 中文讲解', model: 'deepseek-flash', degraded: false, error: null };
    },
    generateCompare: async (a, b) => {
      calls.generateCompare++;
      return { ok: true, text: '## 易混词辨析\nvs [[' + b.word + ']]：官方说明', degraded: false };
    },
    generateRoots: async (n) => {
      calls.generateRoots++;
      return { ok: true, text: '## 词源与构词\n来自官方 Word Origin', degraded: false };
    }
  };
  const service = createService({ config: { vaultPath: vault, backupKeep: 20, model: 'deepseek-flash' }, ...deps });
  const onEvent = (ev, d) => events.push({ ev, d });
  return { vault, service, events, calls, onEvent, deps };
}

test('单查新词：按 status→head→chunk→done 顺序，并写入卡片', async () => {
  const w = await world();
  const r = await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  const names = w.events.map((e) => e.ev);
  assert.equal(names[0], 'status');
  assert.ok(names.includes('head'));
  assert.ok(names.includes('chunk'));
  assert.equal(names[names.length - 1], 'done');
  assert.ok(names.indexOf('head') < names.indexOf('chunk'), 'head 必须先于 chunk');
  const card = await readCard(w.vault, 'effect');
  assert.equal(card.exists, true);
  assert.equal(card.data.word, 'effect');
  assert.equal(card.data.srs.length, 1);
  assert.ok(card.data.srs[0].due, '必须有首次到期日');
  assert.ok(card.body.includes('## 核心释义'));
  assert.ok(card.body.startsWith('# effect /x/'));
});

test('已有词默认不覆盖也不调 API（PRD §7.1-6）', async () => {
  const w = await world();
  await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  w.calls.lookup = 0; w.calls.generateCard = 0;
  w.events.length = 0;
  const r = await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.mode, 'existing');
  assert.equal(w.calls.lookup, 0, '不应再抓官方词典');
  assert.equal(w.calls.generateCard, 0, '不应再调 LLM');
  assert.equal(w.events[0].ev, 'existing');
  const card = await readCard(w.vault, 'effect');
  assert.ok(card.body.includes('中文讲解'), '原有内容不得变');
});

test('force 重新生成：先备份再覆盖（PRD §7.1-6）', async () => {
  const w = await world();
  await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  const before = await readCard(w.vault, 'effect');
  const r = await w.service.query({ q: 'effect', force: true }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.mode, 'regenerated');
  assert.ok(r.backup, '必须产生备份');
  const backups = await readdir(join(w.vault, '..', '..'), { recursive: true }).catch(() => []);
  assert.ok(w.calls.generateCard >= 2);
  const after = await readCard(w.vault, 'effect');
  assert.equal(after.data.srs.length, before.data.srs.length);
});

test('官方未收录：给建议、报错、绝不写文件（不变式 5）', async () => {
  const w = await world({
    lookupImpl: async (word) => ({ word, found: false, normalized: norm(word), suggestions: ['adverse', 'averse'] })
  });
  const r = await w.service.query({ q: 'adverrse' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
  assert.equal(r.wrote, false);
  const sugg = w.events.find((e) => e.ev === 'suggestions');
  assert.deepEqual(sugg.d.words, ['adverse', 'averse']);
  assert.ok(w.events.some((e) => e.ev === 'error'));
  const files = await readdir(w.vault).catch(() => []);
  assert.deepEqual(files, [], '任何文件都不许产生');
});

test('「这次不保存」：展示但不写文件', async () => {
  const w = await world();
  const r = await w.service.query({ q: 'effect', noSave: true }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.wrote, false);
  assert.equal(w.events.find((e) => e.ev === 'done').d.mode, 'unsaved');
  const files = await readdir(w.vault).catch(() => []);
  assert.deepEqual(files, []);
});

test('LLM 降级：官方内容照常入库并标注（PRD §7.1-3）', async () => {
  const w = await world({
    cardImpl: async () => ({ ok: false, text: '', degraded: true, error: '未找到 DeepSeek key' })
  });
  const r = await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: null });
  assert.equal(r.wrote, true, '生成失败不阻塞入库');
  assert.equal(r.llmFailed, true);
  const card = await readCard(w.vault, 'effect');
  assert.ok(card.body.includes('讲解生成失败'));
  assert.ok(card.body.includes('official def'), '官方释义必须写入');
  assert.ok(card.body.includes('late Middle English'), '官方词源必须写入');
  assert.equal(card.data.srs.length, 1, '仍要进复习队列');
});

test('中文输入：直接报错，不抓取不调用', async () => {
  const w = await world();
  const r = await w.service.query({ q: '影响' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'chinese');
  assert.equal(w.calls.lookup, 0);
  const err = w.events.find((e) => e.ev === 'error');
  assert.equal(err.d.code, 'CHINESE');
});

test('未配置库路径：明确报错', async () => {
  const service = createService({ config: {}, store });
  const events = [];
  const r = await service.query({ q: 'effect' }, { onEvent: (e, d) => events.push({ e, d }) });
  assert.equal(r.code, 'NO_VAULT');
  assert.equal(events[0].d.code, 'NO_VAULT');
});

test('辨析模式：写主卡并为对方词建骨架卡（避免死链）', async () => {
  const w = await world();
  const r = await w.service.query({ q: 'affect vs effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.ok, true);
  const main = await readCard(w.vault, 'affect');
  assert.equal(main.exists, true);
  assert.ok(main.body.includes('易混词辨析'));
  const skel = await readCard(w.vault, 'effect');
  assert.equal(skel.exists, true, '对方词应建骨架卡');
  assert.deepEqual(skel.data.srs, [], '骨架卡不进复习队列');
  assert.ok(skel.body.includes('[[affect]]'));
});

test('词根模式：对已有卡片只追加区块，srs 与其它正文不动（PRD §7.1-7）', async () => {
  const w = await world();
  await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  const before = await readCard(w.vault, 'effect');
  const r = await w.service.query({ q: 'effect 词根' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.mode, 'appended');
  const after = await readCard(w.vault, 'effect');
  assert.deepEqual(after.data, before.data, 'frontmatter（含 srs）必须完全不变');
  assert.ok(after.body.includes('## 核心释义'), '原有正文不得丢');
  assert.ok(after.body.includes('## 词源与构词'));
  assert.ok(r.backup, '追加前也要备份');
});

test('词根模式：卡片不存在时生成完整卡片', async () => {
  const w = await world();
  const r = await w.service.query({ q: 'newword 词根' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  assert.equal(r.mode, 'saved');
  const card = await readCard(w.vault, 'newword');
  assert.equal(card.exists, true);
  assert.equal(card.data.srs.length, 1);
});

/**
 * 回归：曾经 renderHead 只在拿到 obsidianUrl 时才画「在 Obsidian 打开」，
 * 但 head/existing 事件根本不带这个字段，app.js 还显式置 null →
 * 按钮**永远**不出现。组件单测过不了这一关，必须测「线上真的喂了它」。
 */
test('单查：head 事件必须带上可用的 obsidian:// 链接', async () => {
  const root = await tempDir('eng-vaultroot-');
  const vaultRoot = join(root, 'myvault');
  await mkdir(join(vaultRoot, '.obsidian'), { recursive: true });
  const cardDir = join(vaultRoot, 'soloeng词库');
  await mkdir(cardDir, { recursive: true });

  const service = createService({
    config: { vaultPath: cardDir, backupKeep: 20, model: 'deepseek-flash' },
    store,
    lookup: async (w) => ({ word: w, found: true, normalized: norm(w), suggestions: [] }),
    generateCard: async () => ({ ok: true, text: '## 核心释义\n讲解', degraded: false })
  });
  const events = [];
  await service.query({ q: 'effect' }, { onEvent: (e, d) => events.push({ e, d }), apiKey: 'sk-x' });

  const head = events.find((x) => x.e === 'head');
  assert.ok(head, '必须有 head 事件');
  assert.ok(head.d.obsidianUrl, 'head 事件必须带 obsidianUrl，否则按钮永远不显示');
  assert.ok(head.d.obsidianUrl.includes('vault=myvault'), '库名应为 myvault，实际 ' + head.d.obsidianUrl);
  assert.ok(head.d.obsidianUrl.includes(encodeURIComponent('soloeng词库/effect')),
    '相对路径应基于库根，实际 ' + head.d.obsidianUrl);

  // 第二次走 existing 分支，同样必须带
  events.length = 0;
  await service.query({ q: 'effect' }, { onEvent: (e, d) => events.push({ e, d }), apiKey: 'sk-x' });
  const ex = events.find((x) => x.e === 'existing');
  assert.ok(ex, '应有 existing 事件');
  assert.ok(ex.d.obsidianUrl, 'existing 事件同样必须带 obsidianUrl');
});

test('没有 .obsidian 时不产生死链（宁可不显示按钮）', async () => {
  const w = await world();
  await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  const head = w.events.find((x) => x.ev === 'head');
  assert.ok(head, '应有 head 事件');
  assert.equal(head.d.obsidianUrl, null, '推导不出库名时必须为 null');
});

test('「这次不保存」不给 Obsidian 链接（文件根本不会存在）', async () => {
  const root = await tempDir('eng-vaultroot2-');
  const vaultRoot = join(root, 'myvault');
  await mkdir(join(vaultRoot, '.obsidian'), { recursive: true });
  const cardDir = join(vaultRoot, 'soloeng词库');
  await mkdir(cardDir, { recursive: true });
  const service = createService({
    config: { vaultPath: cardDir, backupKeep: 20 }, store,
    lookup: async (w) => ({ word: w, found: true, normalized: norm(w), suggestions: [] }),
    generateCard: async () => ({ ok: true, text: 'x', degraded: false })
  });
  const events = [];
  await service.query({ q: 'nosaveword', noSave: true }, { onEvent: (e, d) => events.push({ e, d }), apiKey: 'sk-x' });
  const head = events.find((x) => x.e === 'head');
  assert.ok(head);
  assert.equal(head.d.obsidianUrl, null, '不保存就不该给出打不开的链接');
});

test('流式：chunk 事件把正文分片推送', async () => {
  const long = '## 核心释义\n' + 'x'.repeat(500);
  const w = await world({ cardImpl: async () => ({ ok: true, text: long, degraded: false }) });
  await w.service.query({ q: 'effect' }, { onEvent: w.onEvent, apiKey: 'sk-x' });
  const chunks = w.events.filter((e) => e.ev === 'chunk').map((e) => e.d.text).join('');
  assert.equal(chunks, long, '分片拼回应等于原文');
  assert.ok(w.events.filter((e) => e.ev === 'chunk').length > 1, '应不止一片');
});
