import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCardData, buildCardBody, officialFallbackBody, writeCard, readCard,
  listCards, buildIndex, recentWords, countDueToday, backupCard, pruneBackups,
  appendRootsSection, createSkeletonCard, cardPath, sanitizeWord, splitRaw, ROOTS_HEADING
} from '../lib/store.js';
import { parseFrontmatter } from '../lib/markdown.js';

const tmp = () => mkdtemp(join(tmpdir(), 'engstore-'));

const NORMALIZED = {
  word: 'effect',
  ipa: { uk: '/ɪˈfekt/', us: '/ɪˈfekt/' },
  pos: ['noun', 'verb'],
  tags: { cefr: null, oxford3000: true, opal: ['OPAL W'] },
  senses: [
    { pos: 'noun', def: 'a change that somebody causes', examples: [{ en: 'the beneficial effects of exercise' }] }
  ],
  collocations: { categories: [{ type: 'adjective', items: ['decisive'] }] },
  relations: { synonyms: ['result'], antonyms: [], wordFamily: 'effective adjective' },
  wordOrigin: 'late Middle English: from Old French',
  usageNotes: [{ type: 'which_word', title: 'Which Word? affect / effect', text: 'affect verb to have an influence' }],
  idioms: [],
  missing: ['cefr'],
  found: true
};

test('buildCardData：一词性一条 srs，首次 due = added + 1 天', () => {
  const d = buildCardData(NORMALIZED, { added: '2026-10-15' });
  assert.equal(d.word, 'effect');
  assert.equal(d.ipa_uk, '/ɪˈfekt/');
  assert.deepEqual(d.pos, ['noun', 'verb']);
  assert.equal(d.oxford3000, true);
  assert.deepEqual(d.opal, ['OPAL W']);
  assert.deepEqual(d.tags, []);
  assert.deepEqual(d.suspended, []);
  assert.equal(d.srs.length, 2);
  assert.equal(d.srs[0].pos, 'noun');
  assert.equal(d.srs[0].due, '2026-10-16', '首次入库 1 天后进入第一轮');
  assert.equal(d.srs[0].interval, 1);
  assert.equal(d.srs[0].ease, 2.5);
  assert.equal(d.srs[0].reps, 0);
  assert.equal(d.srs[0].last, '2026-10-15');
  assert.equal(d.srs[1].pos, 'verb');
});

test('buildCardBody：有 LLM 文本时用其正文，标题带音标', () => {
  const body = buildCardBody(NORMALIZED, '## 核心释义\n**n.** 影响');
  assert.match(body, /^# effect \/ɪˈfekt\//);
  assert.ok(body.includes('## 核心释义'));
  assert.ok(!body.includes('讲解生成失败'));
});

test('buildCardBody：LLM 降级时仍写入官方内容并标注（PRD §7.1-3）', () => {
  // 词族与辨析确实没有官方数据；搭配与词源有 —— 降级正文必须如实反映
  const n = Object.assign({}, NORMALIZED, {
    relations: { synonyms: [], antonyms: [], wordFamily: null },
    usageNotes: []
  });
  const body = buildCardBody(n, '');
  assert.ok(body.includes('讲解生成失败'), '必须标注讲解失败');
  assert.ok(body.includes('decisive'), '官方搭配仍要写入');
  assert.ok(body.includes('late Middle English'), '官方词源仍要写入');
  assert.ok(body.includes('官方词典未收录'), '确实缺失的块（词族/辨析）要标注');
});

test('officialFallbackBody：所有块都缺时每块都标未收录', () => {
  const body = officialFallbackBody({ word: 'x', missing: ['senses', 'collocations', 'relations', 'compareNotes'] });
  const count = (body.match(/官方词典未收录/g) || []).length;
  assert.ok(count >= 4, '四个块都应标注，实际 ' + count);
});

test('writeCard / readCard 往返：frontmatter 与正文都保住', async () => {
  const vault = await tmp();
  const data = buildCardData(NORMALIZED, { added: '2026-10-15' });
  const body = buildCardBody(NORMALIZED, '## 核心释义\n影响');
  const p = await writeCard(vault, 'effect', data, body);
  assert.equal(p, cardPath(vault, 'effect'));
  const back = await readCard(vault, 'effect');
  assert.equal(back.exists, true);
  assert.deepEqual(back.data, data);
  assert.equal(back.body, body);
});

test('readCard 对不存在的卡片返回 exists=false 而不抛错', async () => {
  const vault = await tmp();
  const r = await readCard(vault, 'nope');
  assert.equal(r.exists, false);
  assert.equal(r.error, null);
});

test('listCards 只读文件头即可拿到 frontmatter（大正文也不受影响）', async () => {
  const vault = await tmp();
  const data = buildCardData(NORMALIZED, { added: '2026-10-15' });
  await writeCard(vault, 'effect', data, '# effect\n' + 'x'.repeat(200000));
  await writeCard(vault, 'affect', buildCardData({ word: 'affect', pos: ['verb'], ipa: {}, tags: {} }, { added: '2026-10-15' }), '# affect\n');
  const cards = await listCards(vault);
  assert.equal(cards.length, 2);
  const eff = cards.find((c) => c.word === 'effect');
  assert.equal(eff.data.word, 'effect');
  assert.deepEqual(eff.data.srs.length, 2);
  const idx = await buildIndex(vault);
  assert.equal(idx.total, 2);
  assert.equal(idx.byWord.get('effect').data.oxford3000, true);
});

test('listCards 跳过非 md 与隐藏文件', async () => {
  const vault = await tmp();
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, 'note.txt'), 'x');
  await writeFile(join(vault, '.hidden.md'), 'x');
  await writeFile(join(vault, 'real.md'), '---\nword: real\n---\n# real\n');
  const cards = await listCards(vault);
  assert.deepEqual(cards.map((c) => c.word), ['real']);
});

test('countDueToday 按词性统计并跳过 suspended（PRD §7.2-13）', async () => {
  const vault = await tmp();
  const now = new Date(2026, 9, 15, 10, 0, 0);
  const d1 = buildCardData(NORMALIZED, { added: '2026-10-14' }); // due 10-15 两个词性
  await writeCard(vault, 'effect', d1, '# effect\n');
  const d2 = buildCardData(NORMALIZED, { added: '2026-10-10' });
  d2.srs[0].due = '2026-10-20'; // 未来
  d2.suspended = ['verb'];
  await writeCard(vault, 'later', d2, '# later\n');
  const cards = await listCards(vault);
  assert.equal(countDueToday(cards, now), 2, 'effect 两个词性到期；later 一个未来一个被 suspended');
  d2.suspended = ['noun', 'verb'];
  await writeCard(vault, 'later', d2, '# later\n');
  const cards2 = await listCards(vault);
  assert.equal(countDueToday(cards2, now), 2);
});

test('recentWords 按修改时间倒序', async () => {
  const vault = await tmp();
  const mk = (w) => buildCardData({ word: w, pos: ['noun'], ipa: {}, tags: {} }, { added: '2026-10-15' });
  await writeCard(vault, 'first', mk('first'), '# first\n');
  await new Promise((r) => setTimeout(r, 15));
  await writeCard(vault, 'second', mk('second'), '# second\n');
  await new Promise((r) => setTimeout(r, 15));
  await writeCard(vault, 'third', mk('third'), '# third\n');
  const r = await recentWords(vault, 2);
  assert.deepEqual(r, ['third', 'second']);
});

test('backupCard 生成带时间戳的备份并只保留最近 N 份（PRD §7.1-6）', async () => {
  const vault = await tmp();
  const dir = await tmp();
  for (let i = 0; i < 8; i++) {
    const p = await backupCard(vault, 'effect', '# effect rev' + i, { backupDir: dir, keep: 5 });
    assert.ok(p && p.includes('/effect-'));
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 5, '应只保留 5 份，实际 ' + files.length);
  // 文件名排序必须等于时间排序，否则会删掉最新的
  const newest = files.slice().sort().pop();
  const content = await readFile(join(dir, newest), 'utf8');
  assert.match(content, /# effect rev7/, '保留的应是最新一份');
  const all = await Promise.all(files.map(async (f) => readFile(join(dir, f), 'utf8')));
  assert.ok(!all.some((c) => /rev0|rev1|rev2/.test(c)), '最旧的三份必须已被清理');
  assert.ok(all.some((c) => /rev3/.test(c)), 'rev3 应仍在保留窗口内');
});

test('backupCard 内容为空时不产生文件', async () => {
  const dir = await tmp();
  const p = await backupCard('/x', 'effect', '', { backupDir: dir });
  assert.equal(p, null);
  assert.deepEqual(await readdir(dir), []);
});

test('appendRootsSection：只加区块，frontmatter 与 srs 一字不动（T5.5）', async () => {
  const vault = await tmp();
  const data = buildCardData(NORMALIZED, { added: '2026-10-15' });
  data.tags = ['考研'];
  await writeCard(vault, 'effect', data, '# effect\n\n## 核心释义\n**n.** 影响\n');
  const r = await appendRootsSection(vault, 'effect', ROOTS_HEADING + '\nlate Middle English: from Old French');
  assert.equal(r.ok, true);
  const back = await readCard(vault, 'effect');
  assert.deepEqual(back.data, data, 'frontmatter 含 srs 必须完全不变');
  assert.ok(back.body.includes('## 核心释义'), '原有正文不得丢');
  assert.ok(back.body.includes(ROOTS_HEADING));
  assert.ok(back.body.includes('late Middle English'));
});

test('appendRootsSection：重复追加不产生重复区块', async () => {
  const vault = await tmp();
  await writeCard(vault, 'effect', buildCardData(NORMALIZED, { added: '2026-10-15' }), '# effect\n');
  await appendRootsSection(vault, 'effect', ROOTS_HEADING + '\n第一次');
  await appendRootsSection(vault, 'effect', ROOTS_HEADING + '\n第二次');
  const back = await readCard(vault, 'effect');
  const n = (back.body.match(/## 词源与构词/g) || []).length;
  assert.equal(n, 1, '区块只能有一个，实际 ' + n);
  assert.ok(back.body.includes('第二次'));
  assert.ok(!back.body.includes('第一次'));
});

test('appendRootsSection：卡片不存在时明确失败', async () => {
  const vault = await tmp();
  const r = await appendRootsSection(vault, 'missing', 'x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'card_not_found');
});

test('createSkeletonCard：srs 为空 → 不进复习队列（PRD §2.2）', async () => {
  const vault = await tmp();
  const r = await createSkeletonCard(vault, 'effect', 'affect', { added: '2026-10-15' });
  assert.equal(r.created, true);
  const card = await readCard(vault, 'effect');
  assert.deepEqual(card.data.srs, [], '骨架卡不得进复习队列');
  assert.deepEqual(card.data.suspended, []);
  assert.deepEqual(card.data.tags, ['易混:affect']);
  assert.ok(card.body.includes('[[affect]]'), '必须含双链，避免死链');
  const cards = await listCards(vault);
  assert.equal(countDueToday(cards, new Date(2026, 9, 20)), 0, '骨架卡永不到期');
});

test('createSkeletonCard：已存在则不覆盖', async () => {
  const vault = await tmp();
  await writeCard(vault, 'effect', buildCardData(NORMALIZED, { added: '2026-10-15' }), '# effect 手写内容\n');
  const r = await createSkeletonCard(vault, 'effect', 'affect', { added: '2026-10-15' });
  assert.equal(r.created, false);
  const card = await readCard(vault, 'effect');
  assert.ok(card.body.includes('手写内容'), '不得覆盖已有卡片');
});

test('sanitizeWord / cardPath / splitRaw', () => {
  assert.equal(sanitizeWord('Effect'), 'effect');
  assert.equal(sanitizeWord("mother-in-law"), "mother-in-law");
  assert.equal(sanitizeWord('a/b'), 'ab');
  const raw = '---\nword: effect\n---\n# effect\n正文';
  const s = splitRaw(raw);
  assert.equal(s.head, '---\nword: effect\n---\n');
  assert.equal(s.body, '# effect\n正文');
  const noFm = splitRaw('# 无 frontmatter');
  assert.equal(noFm.head, '');
  assert.equal(noFm.body, '# 无 frontmatter');
});
