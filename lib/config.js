import { readFile, writeFile, mkdir, stat, access, constants } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_PATH } from './paths.js';

/** 默认配置。vaultPath 留空，由用户在「设置」里指定自己的库目录。 */
export const DEFAULT_CONFIG = {
  // 刻意不预置任何本机路径：这是别人的机器，也可能是公开仓库。
  // 首次启动请到「设置」里填写自己的 Obsidian 库目录。
  vaultPath: '',
  obsidianVaultName: null,
  dailyNewLimit: 10,
  dailyReviewLimit: 50,
  model: 'deepseek-flash',
  thinkingMode: 'off',
  enableMW: true,
  theme: 'system',
  lengthMode: 'standard',
  backupKeep: 20,
  fetchMinIntervalMs: 1500,
  fetchTimeoutMs: 25000,
  networkMode: 'direct',
  port: 4317,
  host: '127.0.0.1'
};

export const MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' }
];

export const LENGTH_MODES = ['quick', 'standard', 'intensive'];
export const THEMES = ['system', 'light', 'dark'];

export function withDefaults(cfg) {
  const out = Object.assign({}, DEFAULT_CONFIG);
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(cfg)) if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  return out;
}

export async function loadConfig(file) {
  const p = file || CONFIG_PATH;
  try {
    const raw = await readFile(p, 'utf8');
    return { config: withDefaults(JSON.parse(raw)), created: false, path: p };
  } catch (e) {
    return { config: withDefaults({}), created: true, path: p, error: e.code === 'ENOENT' ? null : String(e.message) };
  }
}

export async function saveConfig(cfg, file) {
  const p = file || CONFIG_PATH;
  const merged = withDefaults(cfg);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/** 库路径检测：存在性 + 目录 + 真实可写性（试写探针再删） */
export async function checkVault(dir) {
  const out = { path: dir, exists: false, isDir: false, writable: false, error: null };
  if (!dir || typeof dir !== 'string') { out.error = 'vaultPath 未配置'; return out; }
  try {
    const s = await stat(dir);
    out.exists = true;
    out.isDir = s.isDirectory();
    if (!out.isDir) { out.error = '不是目录'; return out; }
  } catch (e) {
    out.error = e.code === 'ENOENT' ? '目录不存在' : String(e.message);
    return out;
  }
  const probe = path.join(dir, '.soloeng-write-probe');
  try {
    await writeFile(probe, 'probe', 'utf8');
    await access(probe, constants.R_OK);
    const { unlink } = await import('node:fs/promises');
    await unlink(probe);
    out.writable = true;
  } catch (e) {
    out.error = '不可写：' + String(e.message);
  }
  return out;
}

/** 创建库目录（含父目录） */
export async function ensureVault(dir) {
  await mkdir(dir, { recursive: true });
  return checkVault(dir);
}

/**
 * 推导 Obsidian 库信息：从 vaultPath 向上找到含 .obsidian 的目录。
 * soloeng词库 只是 ob'base 的子文件夹，obsidian:// 链接必须用库名 ob'base，
 * 且相对路径要相对**库根**而不是卡片目录的父目录（卡片目录可能更深）。
 * 返回 { name, root }；找不到时 name=null。
 */
export async function resolveVaultInfo(vaultPath, override) {
  let cur = path.resolve(vaultPath || '.');
  for (let i = 0; i < 12; i++) {
    try {
      const s = await stat(path.join(cur, '.obsidian'));
      if (s.isDirectory()) return { name: override || path.basename(cur), root: cur };
    } catch (e) { /* 继续向上 */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { name: override || null, root: null };
}

export async function resolveVaultName(vaultPath, override) {
  return (await resolveVaultInfo(vaultPath, override)).name;
}

/**
 * URL 段编码。encodeURIComponent 不会转义撇号（'），
 * 而本机库名恰是 ob'base，裸撇号在 URL/终端里很脆弱，这里显式补上。
 */
export function encodeSegment(s) {
  return encodeURIComponent(String(s == null ? '' : s)).replace(/'/g, '%27');
}

/**
 * obsidian:// 打开链接。相对路径基于库根计算，两段都编码。
 * 库信息不可用时返回 null（宁可不显示按钮，也不给一个打不开的链接）。
 */
export function obsidianUrlFor(info, absFilePath) {
  if (!info || !info.name || !info.root || !absFilePath) return null;
  const rel = path.relative(info.root, absFilePath).replace(/\\/g, '/').replace(/\.md$/, '');
  if (!rel || rel.startsWith('..')) return null;
  return 'obsidian://open?vault=' + encodeSegment(info.name) + '&file=' + encodeSegment(rel);
}
