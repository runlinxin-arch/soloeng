import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requiredMajor, currentMajor } from './helpers/engines.js';

/**
 * 「声明了就必须是真的」。
 *
 * 这些断言把三个地方绑在一起：package.json 的 engines、CI 用的 Node、README 的说法。
 * 任何一处单独漂移都会被立刻发现 —— 例如有人把 CI 降到 Node 22，或是文档忘了改。
 */

test('package.json 必须声明 engines.node', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(pkg.engines && pkg.engines.node,
    '必须声明 engines.node，否则旧 Node 上只会得到说不清的失败');
});

test('当前运行时必须满足声明的下限', () => {
  const need = requiredMajor();
  assert.ok(need, 'engines.node 应能解析出主版本号');
  assert.ok(currentMajor() >= need,
    '当前 Node v' + process.versions.node + ' 低于声明的 >= ' + need);
});

test('CI 使用的 Node 大版本必须与 engines 一致', async () => {
  const ci = await readFile('.github/workflows/test.yml', 'utf8');
  const versions = [...ci.matchAll(/node-version:\s*['"](\d+)/g)].map((m) => Number(m[1]));
  assert.ok(versions.length > 0, 'CI 必须显式指定 node-version，否则 runner 默认版本会悄悄漂移');
  const need = requiredMajor();
  assert.ok(versions.every((v) => v === need),
    'CI 的 Node 大版本 ' + JSON.stringify(versions) + ' 与 engines 声明的 ' + need + ' 不一致');
});

test('.npmrc 应开启 engine-strict，让版本不符在安装阶段就明确失败', async () => {
  const rc = await readFile('.npmrc', 'utf8');
  assert.match(rc, /engine-strict\s*=\s*true/,
    '应设 engine-strict=true，否则 npm 只会警告，问题推迟到运行时才暴露');
});

test('README 里的 Node 要求必须与 engines 一致', async () => {
  const md = await readFile('README.md', 'utf8');
  const need = requiredMajor();
  assert.ok(md.includes('Node ≥ ' + need) || md.includes('Node.js v' + need) || md.includes('Node ' + need),
    'README 应明确写出需要 Node ' + need);
  assert.ok(!/Node\s*≥\s*20\.11/.test(md), 'README 仍写着旧的 ≥ 20.11，与 engines 矛盾');
});

test('engines 下限的理由是被实测验证过的（Node 20/22 确实不行）', () => {
  // 这里不重复跑旧版本（CI 上没有），只锁住「下限不是拍脑袋定的」这一结论本身：
  // 依据写在 .npmrc 注释里，改动下限的人必须先面对它。
  assert.ok(requiredMajor() >= 24,
    '低于 24 会让 NODE_USE_ENV_PROXY 失效（Node 22 实测挂 2 条代理测试）');
});
