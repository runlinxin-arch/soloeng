import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../lib/parse-input.js';

test('单查：小写化并去空白', () => {
  assert.deepEqual(parseInput('  Effect  '), { kind: 'single', word: 'effect', raw: 'Effect' });
  assert.equal(parseInput("mother-in-law").kind, 'single');
  assert.equal(parseInput("don't").kind, 'single');
});

test('中文输入被拦截且不发请求（PRD §7.1-7）', () => {
  const r = parseInput('影响');
  assert.equal(r.kind, 'invalid');
  assert.equal(r.reason, 'chinese');
  assert.equal(r.message, '请输入英文单词');
  assert.equal(parseInput('effect 词根吗').reason, 'chinese', '中英混合也应拦截');
});

test('辨析：X vs Y 三种写法', () => {
  for (const s of ['affect vs effect', 'affect VS effect', 'economic vs. economical', 'affect 对比 effect', 'affect 辨析 effect']) {
    const r = parseInput(s);
    assert.equal(r.kind, 'compare', s + ' 应识别为辨析');
    assert.ok(r.word && r.other, s + ' 应给出两个词');
  }
  const r = parseInput('affect vs effect');
  assert.equal(r.word, 'affect');
  assert.equal(r.other, 'effect');
});

test('词根：前后缀两种语序', () => {
  const a = parseInput('affect 词根');
  assert.equal(a.kind, 'roots');
  assert.equal(a.word, 'affect');
  const b = parseInput('词根 affect');
  assert.equal(b.kind, 'roots');
  assert.equal(b.word, 'affect');
  assert.equal(parseInput('affect 词根词缀').kind, 'roots');
  assert.equal(parseInput('affect 词源').kind, 'roots');
});

test('空输入与非法输入', () => {
  assert.equal(parseInput('').kind, 'empty');
  assert.equal(parseInput('   ').kind, 'empty');
  assert.equal(parseInput('123').kind, 'invalid');
  assert.equal(parseInput('a b c').kind, 'invalid');
  assert.equal(parseInput('a b c').reason, 'not_single_word');
});

test('不做词形还原：running 不等于 run（PRD §2.2）', () => {
  const r = parseInput('running');
  assert.equal(r.kind, 'single');
  assert.equal(r.word, 'running', '不得自动还原为 run');
});
