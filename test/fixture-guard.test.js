import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ALL_HTML, MW_RAW, skipReason } from './helpers/fixtures.js';

/**
 * fixture 守卫的粒度守卫。
 *
 * 曾经的写法是「文件里缺任意一个 fixture 就跳过整个文件」。
 * 后果很隐蔽：CI 的 full 任务能抓到牛津/剑桥的 HTML（不需要密钥），
 * 却因为 MW fixture 缺失而把同一文件里 10 个纯 HTML 的解析测试一起跳过 ——
 * 抓了半天，一个都没用上。解析又恰好是本项目最复杂的部分。
 *
 * 所以这里锁两件事：① skipReason 判得准 ② 每个用例都必须显式声明自己的依赖。
 */

test('skipReason：依赖齐全时返回 false（不跳过）', () => {
  // 用必定存在的普通文件，避免这个测试自身反过来依赖 fixture ——
  // 否则在全新克隆（无 fixture）里它会失败，把 CI 直接弄红。
  assert.equal(skipReason(['package.json']), false);
  assert.equal(skipReason([]), false);
});

test('skipReason：空依赖永不跳过', () => {
  assert.equal(skipReason([]), false);
  assert.equal(skipReason(), false);
});

test('skipReason：缺哪个就点名哪个，并给出补齐方式', () => {
  const r = skipReason(['fixtures/definitely-not-here.json']);
  assert.match(r, /definitely-not-here\.json/, '应点名缺失的文件');
  assert.match(r, /npm run spike/, '应说明怎么补齐');
});

test('skipReason：只报缺失的那一个，不牵连其它', () => {
  // 存在的文件不该出现在缺失列表里
  const r = skipReason(['package.json', 'fixtures/nope.json']);
  assert.match(r, /nope\.json/);
  assert.doesNotMatch(r, /package\.json/, '存在的文件不该被列为缺失');
});

test('解析测试必须逐条声明 fixture，不得退回「按文件」跳过', async () => {
  for (const file of ['test/parser.test.js', 'test/dictionary.test.js']) {
    const src = await readFile(file, 'utf8');
    const calls = [...src.matchAll(/^test\(([^\n]*?)',/gm)];
    assert.ok(calls.length > 0, file + ' 应当有 test(...) 调用');
    for (const c of calls) {
      const firstArg = c[1].trim();
      assert.match(firstArg, /^(\[|ALL_HTML|MW_RAW)/,
        file + ' 里有测试没有逐条声明 fixture（这会退回按文件跳过）：' + c[0].slice(0, 70));
    }
  }
});

test('dictionary 的 makeFake 依赖清单与该文件声明的 ALL_HTML 一致', async () => {
  const src = await readFile('test/dictionary.test.js', 'utf8');
  // makeFake 通过 Object.keys(F) 一次性读取全部 HTML fixture
  assert.match(src, /Object\.keys\(F\)/, 'makeFake 应仍然遍历 F 加载 HTML fixture');
  const keys = [...src.matchAll(/^\s{2}(\w+):\s*'(fixtures\/[^']+)'/gm)].map((m) => m[2]);
  assert.deepEqual(keys.slice().sort(), ALL_HTML.slice().sort(),
    'F 里的 fixture 应与 helpers 里声明的 ALL_HTML 完全一致；不一致说明有一边漏改了');
});

test('MW 原始返回只在需要它的用例里声明', () => {
  // 这两个文件里，MW_RAW 只应被「MW 开启」那一个用例使用
  assert.equal(MW_RAW.length, 2);
  assert.ok(MW_RAW.every((f) => f.includes('mw-')));
});
