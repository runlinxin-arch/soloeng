import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 解析 .env 风格文本。
 * 关键：~/.secrets 使用 `export KEY=value` 语法（开发计划 D4），
 * 必须兼容 export 前缀、引号、注释行。
 * 绝不记录或返回明文到日志。
 */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2) {
      const first = val[0];
      const last = val[val.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        val = val.slice(1, -1);
      }
    }
    if (key) out[key] = val;
  }
  return out;
}

export function defaultSecretPaths() {
  const home = homedir();
  return {
    appSecrets: join(home, '.english-vocab', 'secrets.env'),
    fallbackSecrets: join(home, '.secrets')
  };
}

async function readIfExists(path) {
  try { return await readFile(path, 'utf8'); }
  catch (e) { return null; }
}

/** 读两个密钥文件并合并；后读的不是覆盖，而是补缺（app secrets 优先） */
export async function loadSecrets(paths) {
  const p = paths || defaultSecretPaths();
  const merged = {};
  // 优先级：app 专属 secrets.env > 全局 ~/.secrets（先到先得）
  const order = [p.appSecrets, p.fallbackSecrets];
  const found = {};
  for (const path of order) {
    const text = await readIfExists(path);
    found[path] = text !== null;
    if (text === null) continue;
    const parsed = parseEnv(text);
    for (const k of Object.keys(parsed)) if (merged[k] === undefined) merged[k] = parsed[k];
  }
  return { values: merged, found };
}

/**
 * 只返回密钥可用性状态，绝不返回明文（PRD §2.4 / §5.1）。
 */
export function keyStatus(values) {
  const v = values || {};
  return {
    deepseek: Boolean(v.DEEPSEEK_API_KEY),
    mwCollegiate: Boolean(v.MW_COLLEGIATE_KEY),
    mwThesaurus: Boolean(v.MW_THESAURUS_KEY),
    mw: Boolean(v.MW_COLLEGIATE_KEY)
  };
}

export async function getSecrets(paths) {
  const r = await loadSecrets(paths);
  return { values: r.values, found: r.found, status: keyStatus(r.values) };
}
