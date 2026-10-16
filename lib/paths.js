import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
/**
 * 数据目录。可用环境变量 SOLOENG_DATA_DIR 重定向。
 * 测试必须用它把自己与真实 data/ 隔离 —— 否则并行跑的多个测试文件会共写
 * 同一个 counters.json，互相踩踏（CI 的 full 任务就是这样挂的）。
 */
export const DATA_DIR = process.env.SOLOENG_DATA_DIR || path.join(ROOT, 'data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const BACKUP_DIR = path.join(DATA_DIR, 'backup');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const COUNTERS_PATH = path.join(DATA_DIR, 'counters.json');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const PROMPTS_DIR = path.join(ROOT, 'prompts');

export function relToRoot(p) {
  return path.relative(ROOT, p);
}
