import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 脚本目录里不得留下无人引用的探针。
 *
 * 起因：spike/ 下积累了 4 个一次性探针（dump / probe2 / probe5 / tree），
 * 全仓库 0 引用，其中 probe5 的产出还早已被 run.js 覆盖。这类脚本不会让测试失败，
 * 只会一直躺在公开仓库里，只能靠守卫拦。
 *
 * 为什么只查 spike/ 与 verify/，而不是全仓库：
 * 我实测过全仓库版本，两种做法都不成立 ——
 *   ① 只从 package.json 取 glob：test/*.test.js 这个模式其实写在 test/run.js 里，
 *      于是 19 个测试文件全被误报为孤立；
 *   ② 再从所有源码里抓 glob 令牌：会把注释和正则里的 * / .* 等碎片也当成模式，
 *      结果匹配一切，检查变成空转（0 个孤立，永远绿）。
 * 所以这里退回**不需要 glob** 的两个脚本目录：判据简单、无假阳也无假阴。
 */

const SCRIPT_DIRS = ['spike', 'verify'];
const SKIP_DIRS = new Set(['node_modules', 'data', '.git']);

function allSourceText(root, excludePath) {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|html)$/.test(e.name)) continue;
      const rel = p.replace(/^\.\//, '');
      if (rel === excludePath) continue;
      out.push(readFileSync(p, 'utf8'));
    }
  })(root);
  return out;
}

test('spike/ 与 verify/ 下的每个脚本都必须被引用（否则就是死代码）', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const scripts = Object.values(pkg.scripts || {}).join('\n');

  const orphans = [];
  for (const dir of SCRIPT_DIRS) {
    for (const name of readdirSync(dir)) {
      if (!/\.(js|mjs)$/.test(name)) continue;
      const rel = dir + '/' + name;
      if (scripts.includes(name) || scripts.includes(rel)) continue;
      const referenced = allSourceText('.', rel).some((text) => text.includes(name));
      if (!referenced) orphans.push(rel);
    }
  }

  assert.deepEqual(orphans, [],
    '以下脚本没有任何地方引用（npm script 或其它源码），探针用完请删除：\n  ' + orphans.join('\n  '));
});

test('package.json 的每个 script 都指向真实存在的文件', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    for (const m of String(cmd).matchAll(/(?:\.\/)?([\w./-]+\.(?:js|mjs|html|json))/g)) {
      const p = m[1].replace(/^\.\//, '');
      try { readFileSync(p); } catch (e) { missing.push(name + ' -> ' + p); }
    }
  }
  assert.deepEqual(missing, [], 'package.json 的 script 指向了不存在的文件：\n  ' + missing.join('\n  '));
});

test('入口脚本（server.js）应当有对应的 npm script', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const v = Object.values(pkg.scripts || {}).join('\n');
  assert.ok(v.includes('server.js'), 'server.js 是入口，但没有 npm script 指向它（应加 start）');
});
