import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter, parseYaml, stringifyFrontmatter, parseScalar, parseFlowArray
} from '../lib/markdown.js';

const CARD = [
  '---',
  'word: effect',
  'ipa_uk: /ɪˈfekt/',
  'ipa_us: /ɪˈfekt/',
  'pos: [noun, verb]',
  'oxford3000: true',
  'opal: [学术词]',
  'tags: [考研, 易混:affect]',
  'added: 2026-10-15',
  'srs:',
  '  - pos: noun',
  '    due: 2026-10-18',
  '    interval: 3',
  '    ease: 2.5',
  '    reps: 2',
  '    lapses: 0',
  '    last: 2026-10-15',
  '  - pos: verb',
  '    due: 2026-10-16',
  '    interval: 1',
  '    ease: 2.5',
  '    reps: 0',
  '    lapses: 0',
  '    last: 2026-10-15',
  '---',
  '# effect /ɪˈfekt/',
  '',
  '## 核心释义',
  '**n.** 影响',
  ''
].join('\n');

test('parseFrontmatter：解析 PRD 卡片规格示例', () => {
  const fm = parseFrontmatter(CARD);
  assert.equal(fm.hasFrontmatter, true);
  assert.equal(fm.data.word, 'effect');
  assert.equal(fm.data.ipa_uk, '/ɪˈfekt/');
  assert.deepEqual(fm.data.pos, ['noun', 'verb']);
  assert.equal(fm.data.oxford3000, true);
  assert.deepEqual(fm.data.opal, ['学术词']);
  assert.deepEqual(fm.data.tags, ['考研', '易混:affect']);
  assert.equal(fm.data.added, '2026-10-15');
  assert.equal(fm.data.srs.length, 2);
  assert.equal(fm.data.srs[0].pos, 'noun');
  assert.equal(fm.data.srs[0].due, '2026-10-18');
  assert.equal(fm.data.srs[0].interval, 3);
  assert.equal(fm.data.srs[0].ease, 2.5);
  assert.equal(fm.data.srs[1].pos, 'verb');
  assert.equal(fm.data.srs[1].reps, 0);
  assert.match(fm.body, /^# effect \/ɪˈfekt\//);
});

test('往返幂等：parse(stringify(data)) 深等于 data（关键）', () => {
  const data = parseFrontmatter(CARD).data;
  const body = parseFrontmatter(CARD).body;
  const again = parseFrontmatter(stringifyFrontmatter(data, body));
  assert.deepEqual(again.data, data);
  assert.equal(again.body, body);
  const third = parseFrontmatter(stringifyFrontmatter(again.data, again.body));
  assert.deepEqual(third.data, data, '两次往返仍须一致');
});

test('无 frontmatter 时整体作为正文', () => {
  const fm = parseFrontmatter('# 纯正文\n内容');
  assert.equal(fm.hasFrontmatter, false);
  assert.deepEqual(fm.data, {});
  assert.equal(fm.body, '# 纯正文\n内容');
});

test('null / 空数组 / 布尔 / 数字 往返', () => {
  const data = { a: null, b: [], c: false, d: 0, e: 2.5, f: 'x' };
  const out = parseFrontmatter(stringifyFrontmatter(data, 'body')).data;
  assert.deepEqual(out, data);
});

test('含逗号/冒号的字符串会被引号保护且能还原', () => {
  const data = { word: 'effect', tags: ['a,b', '易混:affect'], note: 'x: y' };
  const out = parseFrontmatter(stringifyFrontmatter(data, '')).data;
  assert.deepEqual(out, data);
});

test('parseScalar 各类标量', () => {
  assert.equal(parseScalar('  42 '), 42);
  assert.equal(parseScalar('-3.5'), -3.5);
  assert.equal(parseScalar('true'), true);
  assert.equal(parseScalar('false'), false);
  assert.equal(parseScalar('null'), null);
  assert.equal(parseScalar(''), null);
  assert.equal(parseScalar('"a b"'), 'a b');
  assert.equal(parseScalar("'a b'"), 'a b');
  assert.equal(parseScalar('/ɪˈfekt/'), '/ɪˈfekt/');
  assert.deepEqual(parseScalar('[a, b]'), ['a', 'b']);
});

test('parseFlowArray 处理引号内的逗号与中文', () => {
  assert.deepEqual(parseFlowArray('[]'), []);
  assert.deepEqual(parseFlowArray('[考研, 易混:affect]'), ['考研', '易混:affect']);
  assert.deepEqual(parseFlowArray('["a,b", c]'), ['a,b', 'c']);
});

test('parseYaml 忽略注释与空行', () => {
  const y = parseYaml('# 注释\n\na: 1\n\nb: 2\n');
  assert.deepEqual(y, { a: 1, b: 2 });
});

test('缩进不同层级不互相污染', () => {
  const y = parseYaml('top: 1\nnested:\n  inner: 2\nbottom: 3\n');
  assert.equal(y.top, 1);
  assert.equal(y.nested.inner, 2);
  assert.equal(y.bottom, 3);
});
