import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

/**
 * fixtures 分发策略。
 *
 * 这个仓库是公开的，而抓取到的官方词典原文（页面 HTML、API 原始返回、释义片段、
 * 词源）受版权保护，只能留在本机、由 npm run spike 再生，绝不能提交。
 *
 * 允许随仓库分发的只有两类：① 不含任何释义/例句原文的结构化摘要
 * ② 词语列表。新增 fixture 时必须先确认它不含官方原文，再更新下面的清单。
 */

const DISTRIBUTABLE = [
  'fixtures/cam-effect.json',   // 词性 + 音标 + 义项数
  'fixtures/coll-access.json',  // 付费墙状态
  'fixtures/oald-effect.json',  // 音标 / 标签 / 音频 URL / 各类计数
  'fixtures/spellcheck.json'    // 拼写建议词列表
];

const MUST_IGNORE = [
  'fixtures/html/',
  'fixtures/mw-*-raw.json',
  'fixtures/mw-effect.json',
  'fixtures/cam-affect.json'
];

test('随仓库分发的 fixtures 必须在允许清单内（防止官方原文被误提交）', (t) => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', 'fixtures'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean).sort();
  } catch (e) {
    t.skip('环境里没有 git，跳过');
    return;
  }

  const allowed = DISTRIBUTABLE.slice().sort();
  const extra = tracked.filter((f) => !allowed.includes(f));
  const missing = allowed.filter((f) => !tracked.includes(f));

  assert.deepEqual(extra, [],
    '以下 fixture 不在允许清单内 —— 先确认它不含官方词典原文，再决定是否分发：' + extra.join('、'));
  assert.deepEqual(missing, [],
    '允许清单里的文件已不在仓库中，请同步更新清单：' + missing.join('、'));
});

test('含官方原文的 fixture 必须被 .gitignore 排除', () => {
  assert.ok(existsSync('.gitignore'), '仓库根目录应有 .gitignore');
  const ig = readFileSync('.gitignore', 'utf8');
  for (const pattern of MUST_IGNORE) {
    assert.ok(ig.includes(pattern), '.gitignore 必须排除含官方原文的 ' + pattern);
  }
});
