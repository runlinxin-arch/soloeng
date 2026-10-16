import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * 文档与实现的一致性守卫。
 *
 * 起因：PRD 里一直写着省略号菜单（U+22EF，「⋯」），而代码里早已删掉；
 * 开发计划里还写着一个**根本不存在**的产出物 fixtures/oald-collocations-effect.json；
 * PRD 的视觉规范「不用卡片阴影与大圆角」也和现行的胶囊控件直接对立。
 * 文档跟代码打架会误导后续所有工作，而这类问题不会让测试失败，只能靠守卫拦。
 */

const ELLIPSIS = '\u22ef';
const DOCS = ['PRD.md', '开发计划.md', '项目任务书.md', '页面结构与交互设计.md', 'README.md'];

/**
 * 读文档。刻意不吞异常、也不接受过短内容 ——
 * 否则「读不到」会退化成空字符串，守卫就在空文档上空跑，变成假通过。
 */
async function docText(f) {
  const text = await readFile(f, 'utf8');
  assert.ok(text.length > 200,
    f + ' 只读到 ' + text.length + ' 字节，内容异常；守卫可能在空文档上空跑');
  return text;
}

/**
 * 极简 gitignore 匹配：够用于本仓库的那几条模式。
 * 用途见「文档引用的 fixtures」那条 —— 判断某个不存在的路径是否本来就**不该**存在。
 */
export function isIgnoredBy(patterns, p) {
  const norm = p.replace(/^\.\//, '').replace(/\/$/, '');
  for (const raw of patterns) {
    let pat = String(raw).trim();
    if (!pat || pat.startsWith('#')) continue;
    if (pat.endsWith('/')) pat = pat.slice(0, -1);
    const rx = new RegExp('^' + pat
      .replace(/[.+^$\{\}()|[\]\\]/g, '\\$&')
      .split('**').join('\u0000')
      .split('*').join('[^/]*')
      .split('\u0000').join('.*')
      + '(/.*)?$');
    if (rx.test(norm)) return true;
  }
  return false;
}

test('gitignore 匹配器认得本仓库的模式（否则下一条守卫会误报）', () => {
  const patterns = ['fixtures/html/', 'fixtures/mw-*-raw.json', 'fixtures/mw-effect.json'];
  assert.ok(isIgnoredBy(patterns, 'fixtures/html'), '目录模式');
  assert.ok(isIgnoredBy(patterns, 'fixtures/html/oald.html'), '目录下的文件');
  assert.ok(isIgnoredBy(patterns, 'fixtures/mw-collegiate-raw.json'), '通配模式');
  assert.ok(isIgnoredBy(patterns, 'fixtures/mw-effect.json'), '精确文件');
  assert.ok(!isIgnoredBy(patterns, 'fixtures/cam-effect.json'), '未被排除的不该误判');
});

test('提到已取消的省略号菜单时，必须说明它已取消（不能再当成存在）', async () => {
  for (const f of DOCS) {
    const text = await docText(f);
    text.split('\n').forEach((line, i) => {
      if (!line.includes(ELLIPSIS)) return;
      assert.match(line, /已取消|取消|以 PRD 为准/,
        f + ':' + (i + 1) + ' 把省略号菜单当成现有功能在描述，但它早已从代码里移除：\n' + line.trim());
    });
  }
});

test('文档引用的 fixtures 路径必须存在、被 gitignore 排除、或明确标注未产出', async () => {
  const patterns = readFileSync('.gitignore', 'utf8').split('\n');
  const ANNOTATION = /不外发|未随仓库|不随仓库|没有产出|未产出|不产出|重新抓取/;
  const problems = [];
  for (const f of DOCS) {
    const text = await docText(f);
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/fixtures\/[A-Za-z0-9_.*\/-]+/g)) {
        const p = m[0].replace(/[.,;:）)]$/, '');
        if (p.includes('*')) continue;                                  // 通配写法不做存在性要求
        if (existsSync(p) || existsSync(p.replace(/\/$/, ''))) continue;
        if (isIgnoredBy(patterns, p)) continue;                         // 本来就不外发
        if (ANNOTATION.test(line)) continue;                            // 同行已说明未产出
        problems.push(f + ':' + (i + 1) + '  引用不存在的 ' + p);
      }
    });
  }
  assert.deepEqual(problems, [],
    '以下文档引用了不存在的产出物，且没说明原因（会让人以为它该存在）：\n' + problems.join('\n'));
});

test('三份文档的从属关系必须一致：PRD 取代另外两份', async () => {
  assert.match(await docText('PRD.md'), /取代/, 'PRD 应声明它取代了另外两份文档');
  for (const f of ['项目任务书.md', '页面结构与交互设计.md']) {
    assert.match(await docText(f), /PRD\.md/,
      f + ' 应指明以 PRD 为准，否则会出现「谁是唯一来源」的矛盾');
  }
});

test('视觉规范必须与 CSS 实现一致（胶囊控件 + 阴影）', async () => {
  const css = await readFile('public/style.css', 'utf8');
  assert.ok(/border-radius:\s*999px/.test(css),
    '这条守卫的前提是 CSS 确实用了胶囊圆角；实现改了请同步改这里');
  for (const f of ['PRD.md', '页面结构与交互设计.md']) {
    const text = await docText(f);
    assert.match(text, /999px|胶囊/, f + ' 的视觉规范没提胶囊控件，与 CSS 实现脱节');
    assert.ok(!/不用卡片阴影与大圆角。/.test(text),
      f + ' 仍写着「不用卡片阴影与大圆角」，与现行的胶囊 + 分层阴影实现直接对立');
  }
});

test('README 里写的测试总数必须与实际一致（这个数字漂移过两次）', async () => {
  // 顶层 test( 声明数恰好等于 node --test 报告的总数（本仓库实测一致，无循环生成的用例）
  let declared = 0;
  for (const f of readdirSync('test')) {
    if (!f.endsWith('.test.js')) continue;
    declared += (readFileSync('test/' + f, 'utf8').match(/^test\(/gm) || []).length;
  }
  assert.ok(declared > 100, '测试数看起来不对：' + declared);

  // 只认「单元测试」那一行。别用宽松的 **N / N 通过**：v1 验收那行也是这个格式（9 / 9），
  // 会撞上来 —— 我第一版就是这么写的，守卫张口就说「README 写着 9 个测试」。
  const md = await docText('README.md');
  const row = md.match(/\|\s*单元测试\s*\|\s*\*\*(\d+) \/ \1 通过\*\*/);
  assert.ok(row, 'README 的验收结果表里应有一行：单元测试 | **N / N 通过**');
  assert.equal(Number(row[1]), declared,
    'README 写着 ' + row[1] + ' 个测试，实际声明了 ' + declared + ' 个 —— 加了测试就要同步这个数字');
});

test('文档里提到的 UI 控件名应该真的存在于代码里', async () => {
  const code = [
    await readFile('public/index.html', 'utf8'),
    await readFile('public/render.js', 'utf8'),
    await readFile('public/app.js', 'utf8')
  ].join('\n');
  for (const label of ['在 Obsidian 打开', '重新生成', '移出队列', '跳过']) {
    assert.ok(code.includes(label), '文档提到「' + label + '」，但代码里找不到这个控件');
  }
});
