import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NET_CHECK, LOCAL_CHECK, ALL_CHECKS } from '../verify/v1-checks.js';

/**
 * v1 验收「联网项 / 确定性项」分类的守卫。
 *
 * 背景：九项里 7 项要实时抓牛津 / 剑桥，第三方站点一抖就失败（剑桥偶发 Cloudflare
 * 挑战返回 403「Just a moment…」）。混在一起时，一次失败到底是代码坏了还是站点抽风，
 * 完全看不出来。所以分类必须**齐全、不重叠、而且真的被脚本用上**。
 */

test('分类必须覆盖 PRD §7.1 的全部九项', () => {
  const nums = Object.keys(ALL_CHECKS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9],
    '九项必须全部归类；新增检查时也要一并归类');
});

test('联网项与确定性项不得重叠', () => {
  const overlap = Object.keys(NET_CHECK).filter((k) => k in LOCAL_CHECK);
  assert.deepEqual(overlap, [], '同一项不能既算联网又算确定性：' + overlap.join(', '));
});

test('每一项都得有名字', () => {
  for (const [no, name] of Object.entries(ALL_CHECKS)) {
    assert.ok(typeof name === 'string' && name.length > 3, '第 ' + no + ' 项缺少名称');
  }
});

test('分类表必须真的被验收脚本用上（别只是摆设）', async () => {
  const src = await readFile('verify/v1-acceptance.js', 'utf8');
  assert.match(src, /from '\.\/v1-checks\.js'/, '脚本应导入分类表');
  assert.match(src, /no in NET_CHECK/, 'record() 应依据分类表标注 network');
});

test('源码里 record(N, ...) 的编号必须与分类表一致', async () => {
  const src = await readFile('verify/v1-acceptance.js', 'utf8');
  // 注意用 \d+ 而不是 \d：最初写成 \d，第 10 项（record(10, …)）会被静默漏掉，
  // 反证时才发现 —— 一个看不见第 10 项的守卫等于没有。
  const found = [...src.matchAll(/record\((\d+),/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const declared = Object.keys(ALL_CHECKS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(found, declared,
    '验收脚本里的检查项与分类表对不上 —— 新增/删除检查时两处都要改');
});

test('离线模式：联网项都有跳过分支，确定性项没有', async () => {
  const src = await readFile('verify/v1-acceptance.js', 'utf8');
  for (const no of Object.keys(NET_CHECK)) {
    const hits = (src.match(new RegExp('skipNet\\(' + no + '\\)', 'g')) || []).length;
    assert.equal(hits, 1, '第 ' + no + ' 项是联网项，必须有且只有一个 skipNet(' + no + ')，实际 ' + hits);
  }
  for (const no of Object.keys(LOCAL_CHECK)) {
    assert.equal(src.includes('skipNet(' + no + ')'), false,
      '第 ' + no + ' 项是确定性项，不该被跳过');
  }
});

test('确定性项不依赖联网检查留下的卡片（否则离线模式会挂）', async () => {
  const src = await readFile('verify/v1-acceptance.js', 'utf8');
  // 第 5 项曾经扫的是 tempVault，而那张卡是联网的 §7.1-2 写进去的，
  // 离线模式下它变成 0 张，于是「确定性」检查反而失败。现在必须自建。
  const block = src.slice(src.indexOf('5 浏览器不是仓库'), src.indexOf('6 不覆盖手写内容'));
  assert.match(block, /createSkeletonCard/, '第 5 项应自己造一张卡，不依赖别的检查');
});
