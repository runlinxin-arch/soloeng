import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG, withDefaults, loadConfig, saveConfig,
  checkVault, ensureVault, resolveVaultName, resolveVaultInfo, obsidianUrlFor
} from '../lib/config.js';

const tmp = () => mkdtemp(join(tmpdir(), 'engcfg-'));

test('withDefaults 补全缺字段且不覆盖已有值', () => {
  const c = withDefaults({ model: 'deepseek-v4-pro' });
  assert.equal(c.model, 'deepseek-v4-pro');
  assert.equal(c.dailyNewLimit, 10);
  assert.equal(c.enableMW, true);
  assert.equal(c.vaultPath, DEFAULT_CONFIG.vaultPath);
  assert.equal(DEFAULT_CONFIG.vaultPath, '', '默认不得预置任何本机路径（公开仓库）');
  assert.equal(withDefaults(null).model, 'deepseek-flash');
});

test('saveConfig / loadConfig 往返一致', async () => {
  const dir = await tmp();
  const file = join(dir, 'config.json');
  await saveConfig({ vaultPath: '/tmp/x', dailyNewLimit: 7, model: 'deepseek-v4-pro' }, file);
  const r = await loadConfig(file);
  assert.equal(r.created, false);
  assert.equal(r.config.vaultPath, '/tmp/x');
  assert.equal(r.config.dailyNewLimit, 7);
  assert.equal(r.config.model, 'deepseek-v4-pro');
  assert.equal(r.config.backupKeep, 20);
});

test('loadConfig 文件缺失时返回默认值而非抛错', async () => {
  const dir = await tmp();
  const r = await loadConfig(join(dir, 'nope.json'));
  assert.equal(r.created, true);
  assert.equal(r.config.model, 'deepseek-flash');
});

test('loadConfig 遇到损坏 JSON 不崩', async () => {
  const dir = await tmp();
  const file = join(dir, 'config.json');
  await writeFile(file, '{ this is not json');
  const r = await loadConfig(file);
  assert.equal(r.created, true);
  assert.equal(r.config.dailyNewLimit, 10);
});

test('checkVault 三态：不存在 / 是文件 / 可写目录', async () => {
  const dir = await tmp();
  const missing = await checkVault(join(dir, 'nope'));
  assert.equal(missing.exists, false);
  assert.equal(missing.writable, false);

  const filePath = join(dir, 'afile.txt');
  await writeFile(filePath, 'x');
  const asFile = await checkVault(filePath);
  assert.equal(asFile.exists, true);
  assert.equal(asFile.isDir, false);
  assert.match(asFile.error, /不是目录/);

  const ok = await checkVault(dir);
  assert.equal(ok.exists, true);
  assert.equal(ok.isDir, true);
  assert.equal(ok.writable, true, '临时目录应可写');
});

test('checkVault 未配置路径时给出明确错误', async () => {
  const r = await checkVault('');
  assert.equal(r.exists, false);
  assert.match(r.error, /未配置/);
});

test('ensureVault 创建缺失的库目录（D1：soloeng词库 需可一键创建）', async () => {
  const dir = await tmp();
  const target = join(dir, '个人学习', '英语单词卡');
  const r = await ensureVault(target);
  assert.equal(r.exists, true);
  assert.equal(r.isDir, true);
  assert.equal(r.writable, true);
});

test('resolveVaultName 上溯 .obsidian 得到真正的库名（D1 连带影响）', async () => {
  const root = await tmp();
  const vault = join(root, "ob'base");
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  const cardDir = join(vault, 'soloeng词库');
  await mkdir(cardDir, { recursive: true });
  const name = await resolveVaultName(cardDir, null);
  assert.equal(name, "ob'base", '必须推出 ob\'base 而不是 soloeng词库');
  assert.equal(await resolveVaultName(cardDir, 'override-name'), 'override-name');
  const noVault = join(root, 'plain');
  await mkdir(noVault, { recursive: true });
  assert.equal(await resolveVaultName(noVault, null), null);
});

test('obsidianUrlFor：相对路径必须基于**库根**，而不是卡片目录的父目录', async () => {
  const root = await tmp();
  const vaultRoot = join(root, "ob'base");
  await mkdir(join(vaultRoot, '.obsidian'), { recursive: true });
  // 故意放深两层：旧实现用 dirname(vaultPath) 会算出错的相对路径
  const cardDir = join(vaultRoot, '个人学习', '英语单词卡');
  await mkdir(cardDir, { recursive: true });

  const info = await resolveVaultInfo(cardDir, null);
  assert.equal(info.name, "ob'base");
  assert.equal(info.root, vaultRoot, '必须定位到含 .obsidian 的库根');

  const url = obsidianUrlFor(info, join(cardDir, 'effect.md'));
  assert.ok(url.startsWith('obsidian://open?vault='));
  assert.ok(url.includes('vault=ob%27base'), "库名需转义撇号（encodeURIComponent 不转义 '，已显式补上），实际 " + url);
  assert.ok(url.includes(encodeURIComponent('个人学习/英语单词卡/effect')),
    '相对路径必须从库根起算且去掉 .md，实际 ' + url);
  assert.ok(!url.includes('.md'));
  assert.ok(!url.includes("ob'base&"), '撇号不得原样出现');
});

test('obsidianUrlFor：库信息不可用时返回 null（宁可不显示，也不给死链）', async () => {
  assert.equal(obsidianUrlFor(null, '/x/y.md'), null);
  assert.equal(obsidianUrlFor({ name: null, root: '/x' }, '/x/y.md'), null);
  assert.equal(obsidianUrlFor({ name: 'v', root: null }, '/x/y.md'), null);
  assert.equal(obsidianUrlFor({ name: 'v', root: '/x' }, null), null);
  assert.equal(obsidianUrlFor({ name: 'v', root: '/x' }, '/other/y.md'), null, '不在库根下的路径必须拒绝');
});
