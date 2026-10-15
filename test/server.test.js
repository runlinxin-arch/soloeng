import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { createService } from '../lib/service.js';
import * as store from '../lib/store.js';
import { writeCard, buildCardData, readCard } from '../lib/store.js';

let app;
let base;
let vault;
let configPath;

function norm(word) {
  return {
    word, ipa: { uk: '/x/', us: '/x/' }, audio: { uk: null, us: null }, pos: ['noun'],
    tags: { cefr: null, oxford3000: false, opal: [] },
    senses: [{ pos: 'noun', def: 'd', examples: [{ en: 'e' }] }],
    collocations: { categories: [] }, relations: { synonyms: [], antonyms: [], wordFamily: null },
    wordOrigin: null, usageNotes: [], idioms: [], missing: ['collocations'], found: true
  };
}

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'engsrv-vault-'));
  configPath = join(await mkdtemp(join(tmpdir(), 'engsrv-cfg-')), 'config.json');
  const service = createService({
    config: { vaultPath: vault, backupKeep: 5, model: 'deepseek-flash' },
    store,
    lookup: async (w) => ({ word: w, found: true, normalized: norm(w), suggestions: [] }),
    generateCard: async () => ({ ok: true, text: '## 核心释义\n官方讲解', degraded: false })
  });
  app = await createApp({
    config: { vaultPath: vault, host: '127.0.0.1', port: 0, model: 'deepseek-flash', networkMode: 'direct' },
    configPath,
    service
  });
  const addr = await app.listen(0, '127.0.0.1');
  base = 'http://127.0.0.1:' + addr.port;
});

after(async () => {
  if (app) await new Promise((r) => app.server.close(r));
});

test('GET /api/health 返回运行状态', async () => {
  const r = await fetch(base + '/api/health');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.match(j.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('GET /api/state 统计总数与今日到期，且不泄露密钥', async () => {
  await writeCard(vault, 'effect', buildCardData({ word: 'effect', pos: ['noun'], ipa: {}, tags: {} }, { added: '2020-01-01' }), '# effect\n');
  const r = await fetch(base + '/api/state');
  const j = await r.json();
  assert.ok(j.total >= 1);
  assert.ok(j.dueToday >= 1, '卡片 due 早已过期，应计入今日待复习');
  assert.deepEqual(j.recent, ['effect']);
  assert.equal(typeof j.keyStatus.deepseek, 'boolean');
  assert.ok(!JSON.stringify(j).includes('sk-'), '状态接口不得出现密钥明文');
});

test('GET /api/config 返回配置/密钥状态/库检测，不含明文', async () => {
  const r = await fetch(base + '/api/config');
  const j = await r.json();
  assert.equal(j.config.vaultPath, vault);
  assert.equal(j.vault.exists, true);
  assert.equal(j.vault.writable, true);
  assert.equal(typeof j.keyStatus.deepseek, 'boolean');
  assert.ok(Array.isArray(j.options.models));
  assert.ok(j.options.models.some((m) => m.id === 'deepseek-flash'));
  assert.ok(!JSON.stringify(j).includes('sk-'));
});

test('POST /api/config 保存并回读', async () => {
  const r = await fetch(base + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyNewLimit: 3, model: 'deepseek-v4-pro' })
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.config.dailyNewLimit, 3);
  assert.equal(j.config.model, 'deepseek-v4-pro');
  const back = await (await fetch(base + '/api/config')).json();
  assert.equal(back.config.dailyNewLimit, 3);
  // 还原，避免影响后续用例
  await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dailyNewLimit: 10, model: 'deepseek-flash' }) });
});

test('POST /api/config action=checkVault 检测不存在的目录', async () => {
  const r = await fetch(base + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'checkVault', vaultPath: '/definitely/not/here' })
  });
  const j = await r.json();
  assert.equal(j.vault.exists, false);
  assert.ok(j.vault.error);
});

test('GET /api/audio 只允许牛津官方媒体（防 SSRF）', async () => {
  const evil = await fetch(base + '/api/audio?url=' + encodeURIComponent('https://evil.example/x.mp3'));
  assert.equal(evil.status, 403);
  const local = await fetch(base + '/api/audio?url=' + encodeURIComponent('http://127.0.0.1:9/x.mp3'));
  assert.equal(local.status, 403);
  const bad = await fetch(base + '/api/audio?url=not-a-url');
  assert.equal(bad.status, 400);
  const wrongPath = await fetch(base + '/api/audio?url=' + encodeURIComponent('https://www.oxfordlearnersdictionaries.com/other/x.mp3'));
  assert.equal(wrongPath.status, 403);
});

test('POST /api/query/stream 返回 SSE 事件流', async () => {
  const r = await fetch(base + '/api/query/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: 'brandnewword' })
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  assert.ok(text.includes('event: status'), 'SSE 应有 status');
  assert.ok(text.includes('event: head'), 'SSE 应有 head');
  assert.ok(text.includes('event: done'), 'SSE 应有 done');
  assert.ok(text.includes('event: summary'));
  assert.ok(text.includes('data: '));
});

test('POST /api/query/stream 中文输入返回错误事件且不写文件', async () => {
  const r = await fetch(base + '/api/query/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: '中文' })
  });
  const text = await r.text();
  assert.ok(text.includes('CHINESE'), '应带 CHINESE 错误码');
  assert.ok(!text.includes('event: done'), '不应有 done');
});

test('未知 API 返回 404 JSON', async () => {
  const r = await fetch(base + '/api/nope');
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.ok, false);
});

test('静态路径不存在时 404，且不得目录穿越', async () => {
  const r = await fetch(base + '/not-a-file.txt');
  assert.equal(r.status, 404);
  const trav = await fetch(base + '/../package.json');
  assert.ok(trav.status === 404 || trav.status === 403, '目录穿越必须被挡住，实际 ' + trav.status);
});

/* ============================ v2 复习接口 ============================ */

const REVIEW_WORD = 'reviewme';
const REVIEW_BODY = '# reviewme /r/\n\n## 核心释义\n**n.** 测试用法\n\n## 易混词辨析\nvs [[other]]：词级内容';

test('GET /api/review/today 只列今天到期的词性，且带音频地址', async () => {
  await writeCard(vault, REVIEW_WORD, buildCardData({
    word: REVIEW_WORD, pos: ['noun', 'verb'], ipa: { uk: '/r/', us: '/r/' },
    audio: { uk: 'https://www.oxfordlearnersdictionaries.com/media/uk.mp3', us: null }, tags: {}
  }, { added: '2020-01-01' }), REVIEW_BODY);
  const r = await fetch(base + '/api/review/today');
  const j = await r.json();
  assert.equal(r.status, 200);
  const mine = j.items.filter((i) => i.word === REVIEW_WORD);
  assert.equal(mine.length, 2, '名词与动词都应到期，实际 ' + mine.length);
  assert.ok(mine[0].audio_uk, '正面需要音频地址');
  assert.ok(mine[0].ipa_uk);
  assert.ok(Array.isArray(mine[0].otherPos));
});

test('POST /api/review/rate 正确回写该词性的 progress（PRD §7.2-11）', async () => {
  const before = await readCard(vault, REVIEW_WORD);
  const r = await fetch(base + '/api/review/rate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: REVIEW_WORD, pos: 'noun', grade: 3 })
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.entry.interval, 3, '首次「记得」→ 3 天');
  assert.equal(j.entry.ease, 2.6);
  assert.equal(j.entry.reps, 1);
  const after = await readCard(vault, REVIEW_WORD);
  const noun = after.data.srs.find((e) => e.pos === 'noun');
  const verb = after.data.srs.find((e) => e.pos === 'verb');
  assert.equal(noun.interval, 3, '目标词性必须更新');
  assert.equal(verb.interval, 1, '其他词性不得被连带修改');
  assert.equal(after.body, before.body, '正文绝不能被评分改动');
});

test('POST /api/review/rate 忘了 → 重置 1 天且 lapses+1', async () => {
  const r = await fetch(base + '/api/review/rate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: REVIEW_WORD, pos: 'verb', grade: 1 })
  });
  const j = await r.json();
  assert.equal(j.entry.interval, 1);
  assert.equal(j.entry.lapses, 1);
  assert.equal(j.entry.reps, 0);
});

test('POST /api/review/rate 非法评分被拒绝', async () => {
  const r = await fetch(base + '/api/review/rate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: REVIEW_WORD, pos: 'noun', grade: 9 })
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'BAD_GRADE');
});

test('POST /api/review/suspend 移出后不再出现，且数据完整保留（PRD §7.2-13）', async () => {
  // 先把 noun 的 due 拉回过期，确保「消失」的原因只能是 suspended，而不是没到期
  const pre = await readCard(vault, REVIEW_WORD);
  await writeCard(vault, REVIEW_WORD, Object.assign({}, pre.data, {
    srs: pre.data.srs.map((e) => (e.pos === 'noun' ? Object.assign({}, e, { due: '2020-01-01' }) : e))
  }), pre.body);
  const before = await readCard(vault, REVIEW_WORD);

  const listBefore = await (await fetch(base + '/api/review/today?continue=1')).json();
  assert.ok(listBefore.items.some((i) => i.word === REVIEW_WORD && i.pos === 'noun'), '过期且未 suspended 时必须出现');

  const s = await fetch(base + '/api/review/suspend', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: REVIEW_WORD, pos: 'noun', suspended: true })
  });
  const sj = await s.json();
  assert.equal(sj.ok, true);
  assert.deepEqual(sj.suspended, ['noun']);

  const listAfter = await (await fetch(base + '/api/review/today?continue=1')).json();
  assert.equal(listAfter.items.filter((i) => i.word === REVIEW_WORD && i.pos === 'noun').length, 0,
    'suspended 的词性不得出现');

  const after = await readCard(vault, REVIEW_WORD);
  assert.equal(JSON.stringify(after.data.srs), JSON.stringify(before.data.srs), 'srs 不得被改动');
  assert.equal(after.body, before.body, '正文不得改动');
});

test('POST /api/review/suspend 可重新启用', async () => {
  await fetch(base + '/api/review/suspend', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: REVIEW_WORD, pos: 'noun', suspended: false })
  });
  const after = await readCard(vault, REVIEW_WORD);
  assert.deepEqual(after.data.suspended, []);
  const list = await (await fetch(base + '/api/review/today?continue=1')).json();
  assert.ok(list.items.some((i) => i.word === REVIEW_WORD && i.pos === 'noun'),
    '取消 suspended 且仍过期时必须重新出现');
});

test('GET /api/review/today?continue=1 可超额放出全部（PRD §7.2-12）', async () => {
  const limited = await (await fetch(base + '/api/review/today')).json();
  const all = await (await fetch(base + '/api/review/today?continue=1')).json();
  assert.ok(all.items.length >= limited.items.length, '超额不应比受限更少');
  assert.ok(typeof all.remaining === 'number');
});
