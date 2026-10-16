import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROXY_VARS, inheritedProxyVars } from '../lib/proxy-bootstrap.js';
import { applyNetworkMode, proxyEnvPresent } from '../lib/fetcher.js';

/**
 * 代理变量清单的「单一事实来源」守卫。
 *
 * 背景：这份清单曾经在 lib/fetcher.js、lib/proxy-bootstrap.js、test/startup.test.js
 * 里各写一份。两处清单一旦漂移（比如只在新版里加了某个变量），
 * proxy-bootstrap 的自愈就会漏掉它 —— 表现为「代理失效时网络静默中断」，
 * 而且极难排查。这两个测试就是为了让漂移不可能悄悄发生。
 */

test('fetcher 清除的变量与自愈模块检测的必须是同一组（行为一致性）', () => {
  const saved = new Map();
  for (const k of PROXY_VARS) {
    saved.set(k, process.env[k]);
    process.env[k] = 'http://127.0.0.1:9';
  }
  try {
    assert.deepEqual(proxyEnvPresent().sort(), PROXY_VARS.slice().sort(),
      'proxyEnvPresent 应识别全部代理变量');
    assert.deepEqual(inheritedProxyVars().sort(), PROXY_VARS.slice().sort(),
      'inheritedProxyVars 应识别全部代理变量');

    const net = applyNetworkMode('direct');
    assert.deepEqual(net.removed.sort(), PROXY_VARS.slice().sort(),
      'applyNetworkMode 应清掉全部代理变量');

    assert.deepEqual(proxyEnvPresent(), [], '清完后不该还检测到代理变量');
    assert.deepEqual(inheritedProxyVars(), [], '自愈模块清完后不该还检测到代理变量');
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('代理变量清单只能在 lib/proxy-bootstrap.js 里定义一处', () => {
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'data', '.git'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
    }
  })('.');

  const offenders = [];
  for (const f of files) {
    if (f.endsWith(join('lib', 'proxy-bootstrap.js'))) continue;
    const src = readFileSync(f, 'utf8');
    const hits = PROXY_VARS.filter((k) => src.includes("'" + k + "'") || src.includes('"' + k + '"'));
    // 零星用到某几个名字是合理的（例如给子进程造环境）；但整份清单不该出现第二份
    if (hits.length >= 5) offenders.push(f + '（出现 ' + hits.length + ' 个）');
  }

  assert.deepEqual(offenders, [],
    '以下文件复制了代理变量清单，请改为从 lib/proxy-bootstrap.js 导入：' + offenders.join('、'));
});
