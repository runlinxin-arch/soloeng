import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DATA_DIR, LOG_DIR, COUNTERS_PATH } from './paths.js';

/** 任何密钥都不得进日志（PRD §5 / C7） */
export function redact(input) {
  let x = String(input == null ? '' : input);
  x = x.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
  x = x.replace(/([?&]key=)[^&\s"']+/gi, '$1***');
  x = x.replace(/(MW_[A-Z_]*KEY\s*[=:]\s*)\S+/g, '$1***');
  x = x.replace(/(DEEPSEEK_API_KEY\s*[=:]\s*)\S+/g, '$1***');
  return x;
}

export function stamp(d) {
  const dt = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

function line(level, msg, extra) {
  const ts = new Date().toISOString();
  let s = '[' + ts + '] ' + level + ' ' + redact(msg);
  if (extra !== undefined) {
    try { s += ' ' + redact(typeof extra === 'string' ? extra : JSON.stringify(extra)); }
    catch (e) { s += ' [unserializable]'; }
  }
  return s + '\n';
}

export async function logLine(level, msg, extra) {
  const text = line(level, msg, extra);
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_DIR + '/' + stamp() + '.log', text, 'utf8');
  } catch (e) { /* 日志失败不得影响主流程 */ }
  return text;
}

export const info = (m, e) => logLine('INFO', m, e);
export const warn = (m, e) => logLine('WARN', m, e);
export const error = (m, e) => logLine('ERROR', m, e);

/** 每日调用计数（用于观察抓取量，PRD C2） */
export async function bumpCounter(name, d) {
  const day = stamp(d);
  let data = {};
  try { data = JSON.parse(await readFile(COUNTERS_PATH, 'utf8')); } catch (e) { data = {}; }
  data[day] = data[day] || {};
  data[day][name] = (data[day][name] || 0) + 1;
  const days = Object.keys(data).sort();
  while (days.length > 14) { delete data[days.shift()]; }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(COUNTERS_PATH, JSON.stringify(data, null, 2), 'utf8');
  return data[day][name];
}

export async function getCounters(d) {
  const day = stamp(d);
  try {
    const data = JSON.parse(await readFile(COUNTERS_PATH, 'utf8'));
    return data[day] || {};
  } catch (e) { return {}; }
}
