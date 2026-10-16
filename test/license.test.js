import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 许可声明的守卫。
 *
 * 公开仓库没有 LICENSE 时，默认法律状态是「保留一切权利」—— 别人克隆下来
 * 其实无权使用，这与「公开」的意图正好相反。所以这里把三处声明绑在一起：
 * LICENSE 全文、package.json 的 license 字段、README 的说明。
 */

test('LICENSE 必须是 MIT 全文', async () => {
  const text = await readFile('LICENSE', 'utf8');
  for (const phrase of [
    'MIT License',
    'Permission is hereby granted, free of charge',
    'The above copyright notice and this permission notice shall be included',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'
  ]) {
    assert.ok(text.includes(phrase), 'MIT 全文缺少关键条款：' + phrase);
  }
});

test('LICENSE 必须写明版权年份与署名', async () => {
  const text = await readFile('LICENSE', 'utf8');
  const m = text.match(/Copyright \(c\) (\d{4}) (.+)/);
  assert.ok(m, 'LICENSE 里找不到 Copyright (c) <年份> <署名> 这一行');
  const year = Number(m[1]);
  assert.ok(year >= 2020 && year <= new Date().getFullYear() + 1,
    '版权年份看起来不对：' + m[1]);
  assert.ok(m[2].trim().length >= 2, '版权署名不能为空');
});

test('package.json 的 license 字段必须与 LICENSE 一致', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.license, 'MIT', 'package.json 应声明 license: MIT');
  assert.ok(pkg.author, 'package.json 应写明 author，与 LICENSE 的署名对应');
});

test('README 必须指向 LICENSE，并说明它只覆盖代码', async () => {
  const md = await readFile('README.md', 'utf8');
  assert.match(md, /LICENSE/, 'README 应给出 LICENSE 的入口');
  assert.match(md, /MIT/, 'README 应写明许可类型');
  assert.match(md, /版权属于|不对其主张/,
    'README 应说明 MIT 只覆盖代码，词典内容版权属于各权利人');
});
