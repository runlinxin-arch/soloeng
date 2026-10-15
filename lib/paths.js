import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const BACKUP_DIR = path.join(DATA_DIR, 'backup');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const COUNTERS_PATH = path.join(DATA_DIR, 'counters.json');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const PROMPTS_DIR = path.join(ROOT, 'prompts');

export function relToRoot(p) {
  return path.relative(ROOT, p);
}
