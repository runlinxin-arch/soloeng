import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rate, initialEntry, isEntryDue, buildQueue, MIN_EASE, GRADE, GRADE_LABEL } from '../lib/srs.js';

const base = { pos: 'noun', due: '2026-10-15', interval: 1, ease: 2.5, reps: 0, lapses: 0, last: '2026-10-15' };

test('忘了：间隔重置为 1 天，ease −0.20，lapses +1（附录 B）', () => {
  const s = rate({ pos: 'noun', due: '2026-10-15', interval: 18, ease: 2.5, reps: 4, lapses: 1, last: '2026-10-15' }, 1, '2026-10-16');
  assert.equal(s.interval, 1);
  assert.equal(s.ease, 2.3);
  assert.equal(s.lapses, 2);
  assert.equal(s.reps, 0, '忘了应重置连续答对次数');
  assert.equal(s.due, '2026-10-17');
  assert.equal(s.last, '2026-10-16');
});

test('模糊：间隔 ×1.2，ease −0.05', () => {
  const s = rate({ pos: 'noun', due: '2026-10-15', interval: 10, ease: 2.5, reps: 2, lapses: 0, last: '2026-10-15' }, 2, '2026-10-15');
  assert.equal(s.interval, 12);
  assert.equal(s.ease, 2.45);
  assert.equal(s.reps, 3);
  assert.equal(s.lapses, 0);
  assert.equal(s.due, '2026-10-27');
});

test('记得：间隔 ×ease，ease +0.10', () => {
  const s = rate({ pos: 'noun', due: '2026-10-15', interval: 3, ease: 2.5, reps: 1, lapses: 0, last: '2026-10-15' }, 3, '2026-10-15');
  assert.equal(s.interval, 8, 'round(3 × 2.5) = 8');
  assert.equal(s.ease, 2.6);
  assert.equal(s.reps, 2);
});

test('首次入库 1 天后进入第一轮，第一次「记得」→ 3 天（附录 B 起点）', () => {
  const e = initialEntry('noun', '2026-10-15');
  assert.equal(e.due, '2026-10-16');
  assert.equal(e.interval, 1);
  assert.equal(e.ease, 2.5);
  const s = rate(e, 3, '2026-10-16');
  assert.equal(s.interval, 3, 'round(1 × 2.5) = 3，与 PRD 序列起点一致');
  assert.equal(s.due, '2026-10-19');
});

test('连续「记得」间隔单调增长（不因取整而卡住）', () => {
  let cur = initialEntry('noun', '2026-10-15');
  const seq = [];
  for (let i = 0; i < 6; i++) {
    cur = rate(cur, 3, '2026-10-16');
    seq.push(cur.interval);
  }
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], '间隔必须严格增长：' + JSON.stringify(seq));
  assert.ok(seq[0] === 3);
  assert.ok(seq[seq.length - 1] > 20, '长期应显著增长，实际 ' + JSON.stringify(seq));
});

test('ease 有下限，连续「忘了」不会把 ease 压到 1 以下', () => {
  let cur = initialEntry('noun', '2026-10-15');
  for (let i = 0; i < 20; i++) cur = rate(cur, 1, '2026-10-16');
  assert.equal(cur.ease, MIN_EASE);
  assert.equal(cur.interval, 1);
  assert.equal(cur.lapses, 20);
});

test('模糊的间隔取整不会掉到 0', () => {
  const s = rate({ pos: 'noun', due: '2026-10-15', interval: 1, ease: 2.5, reps: 0, lapses: 0 }, 2, '2026-10-15');
  assert.ok(s.interval >= 1, '间隔至少 1 天');
});

test('rate 是纯函数：不修改传入对象', () => {
  const input = Object.assign({}, base);
  const snapshot = JSON.stringify(input);
  rate(input, 3, '2026-10-15');
  assert.equal(JSON.stringify(input), snapshot, '输入对象不得被修改');
});

test('rate 兼容缺失/损坏字段', () => {
  const s = rate({ pos: 'noun' }, 3, '2026-10-15');
  assert.equal(s.interval, 3);
  assert.equal(s.ease, 2.6);
  assert.ok(s.due);
});

test('isEntryDue：当天算到期，suspended 排除', () => {
  const e = { pos: 'verb', due: '2026-10-15' };
  assert.equal(isEntryDue(e, [], '2026-10-15'), true, '当天必须算到期');
  assert.equal(isEntryDue(e, [], '2026-10-14'), false);
  assert.equal(isEntryDue(e, ['verb'], '2026-10-15'), false, 'suspended 不得出现');
  assert.equal(isEntryDue(null, [], '2026-10-15'), false);
});

test('buildQueue：一词性一项，未来的不出现（PRD §7.2-10）', () => {
  const cards = [
    { word: 'effect', path: '/v/effect.md', data: { pos: ['noun', 'verb'], srs: [
      { pos: 'noun', due: '2026-10-15', interval: 1, ease: 2.5, reps: 0, lapses: 0 },
      { pos: 'verb', due: '2026-10-30', interval: 5, ease: 2.6, reps: 2, lapses: 0 }
    ] } },
    { word: 'future', path: '/v/future.md', data: { pos: ['noun'], srs: [{ pos: 'noun', due: '2026-11-01', reps: 1 }] } }
  ];
  const q = buildQueue(cards, { now: new Date(2026, 9, 15, 9, 0, 0) });
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].word, 'effect');
  assert.equal(q.items[0].pos, 'noun');
  assert.equal(q.dueTotal, 1);
  assert.equal(q.remaining, 0);
});

test('buildQueue：软上限生效且可超额（PRD §7.2-12）', () => {
  const srs = [];
  for (let i = 0; i < 20; i++) srs.push({ pos: 'noun', due: '2026-10-15', interval: 1, ease: 2.5, reps: 1, lapses: 0 });
  const cards = srs.map((e, i) => ({ word: 'w' + i, path: '/v/w' + i + '.md', data: { pos: ['noun'], srs: [e] } }));
  const limited = buildQueue(cards, { now: new Date(2026, 9, 15), reviewLimit: 5, newLimit: 10 });
  assert.equal(limited.items.length, 5, '受复习上限约束');
  assert.equal(limited.remaining, 15, '应报告还有多少张');
  const all = buildQueue(cards, { now: new Date(2026, 9, 15), reviewLimit: 5, continueAll: true });
  assert.equal(all.items.length, 20, '超额应放出全部');
});

test('buildQueue：新词与复习分别受各自上限约束', () => {
  const cards = [];
  for (let i = 0; i < 5; i++) cards.push({ word: 'n' + i, path: '/n' + i, data: { pos: ['noun'], srs: [{ pos: 'noun', due: '2026-10-15', reps: 0, interval: 1, ease: 2.5 }] } });
  for (let i = 0; i < 5; i++) cards.push({ word: 'r' + i, path: '/r' + i, data: { pos: ['noun'], srs: [{ pos: 'noun', due: '2026-10-15', reps: 3, interval: 10, ease: 2.6 }] } });
  const q = buildQueue(cards, { now: new Date(2026, 9, 15), newLimit: 2, reviewLimit: 1 });
  assert.equal(q.newDue, 5);
  assert.equal(q.reviewDue, 5);
  assert.equal(q.items.length, 3, '2 个新词 + 1 个复习');
  assert.equal(q.remaining, 7);
});

test('buildQueue：suspended 的词性完全不出现在队列（PRD §7.2-13）', () => {
  const cards = [{ word: 'effect', path: '/e', data: {
    pos: ['noun', 'verb'], suspended: ['noun'],
    srs: [
      { pos: 'noun', due: '2026-10-15', reps: 1, interval: 3, ease: 2.5 },
      { pos: 'verb', due: '2026-10-15', reps: 1, interval: 3, ease: 2.5 }
    ]
  } }];
  const q = buildQueue(cards, { now: new Date(2026, 9, 15) });
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].pos, 'verb');
});

test('GRADE_LABEL 三档齐全', () => {
  assert.deepEqual(Object.keys(GRADE_LABEL).sort(), ['1', '2', '3']);
  assert.equal(GRADE.FORGOT, 1);
  assert.equal(GRADE.REMEMBERED, 3);
});
