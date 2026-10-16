import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './helpers/tmp.js';
import { unusedImportsInSource, findUnusedImports, bindingsOf } from './helpers/imports.js';

/**
 * 防止未使用的 import 再次堆积。曾经一次清掉了 32 处，其中一半是重构留下的残渣
 * （例如 mkdtemp→tempDir 之后没人再用的 tmpdir）。
 *
 * 这类东西不会让测试失败，所以只能靠守卫拦。
 */

test('检测器本身有效：能认出未使用的 import', () => {
  const src = [
    "import { used, unused } from './x.js';",
    "import Dep from './dep.js';",
    "import * as ns from './ns.js';",
    'console.log(used, Dep, ns);',
    ''
  ].join('\n');
  assert.deepEqual(unusedImportsInSource(src), ['unused']);
});

test('检测器不会误报：真正在用的都不算', () => {
  const src = [
    "import { a, b as c } from './x.js';",
    "import d, { e } from './y.js';",
    'console.log(a, c, d, e);',
    ''
  ].join('\n');
  assert.deepEqual(unusedImportsInSource(src), []);
});

test('检测器认为「只出现在注释里」也算已使用（保守，不误报）', () => {
  const src = [
    "import { onlyInComment } from './x.js';",
    '// 这里提到 onlyInComment',
    ''
  ].join('\n');
  assert.deepEqual(unusedImportsInSource(src), []);
});

test('bindingsOf 能解析各种导入形态', () => {
  assert.deepEqual(bindingsOf('{ a, b as c }'), ['a', 'c']);
  assert.deepEqual(bindingsOf('D, { e }'), ['D', 'e']);
  assert.deepEqual(bindingsOf('* as ns'), ['ns']);
  assert.deepEqual(bindingsOf('solo'), ['solo']);
});

test('检测器能扫描目录并落到具体文件', async () => {
  const dir = await tempDir('engimports-');
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'sub', 'a.js'), "import { nope } from './x.js';\n", 'utf8');
  await writeFile(join(dir, 'b.js'), "import { ok } from './y.js';\nconsole.log(ok);\n", 'utf8');
  const found = findUnusedImports(dir);
  assert.equal(found.length, 1, '应只报出未使用的那一个');
  assert.match(found[0].file, /sub[\/\\]a\.js$/);
  assert.equal(found[0].name, 'nope');
  await rm(dir, { recursive: true, force: true });
});

test('仓库里不得存在未使用的 import', () => {
  const found = findUnusedImports('.');
  const lines = found.map((f) => '  ' + f.file.replace(/^\.\//, '') + '  ->  ' + f.name);
  assert.deepEqual(lines, [],
    '以下 import 从未被使用，请删除（重构后尤其容易留下这类残渣）：\n' + lines.join('\n'));
});
