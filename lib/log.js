import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

/**
 * 每日调用计数（用于观察抓取量，PRD C2）。
 *
 * 计数器是共享文件上的「读-改-写」：并发调用会各自读到同一份旧数据再写回，
 * 互相覆盖。实测 6 个进程各累加 20 次，期望 120 只落 4~14。
 *
 * app 是单进程，所以这里用一条 Promise 队列把写入串行化即可根治；
 * 另外改成「先写临时文件再 rename」，保证任何时刻读到的都是完整 JSON。
 *
 * 边界：这**只解决同一进程内**的并发。多个进程同时写同一个 counters.json
 * 仍会互相覆盖（实测 6 进程各 20 次只落 28）。本项目是单进程本地 app，
 * 不打算为此引入文件锁；真要并发共用数据目录，需要另加锁。
 */
let counterChain = Promise.resolve();

export function bumpCounter(name, d) {
  const run = counterChain.then(
    () => writeCounter(name, d),
    () => writeCounter(name, d)   // 前一个失败也不能卡住后面的
  );
  counterChain = run.then(() => {}, () => {});
  return run;
}

async function writeCounter(name, d) {
  const day = stamp(d);
  let data = {};
  try { data = JSON.parse(await readFile(COUNTERS_PATH, 'utf8')); } catch (e) { data = {}; }
  data[day] = data[day] || {};
  data[day][name] = (data[day][name] || 0) + 1;
  const days = Object.keys(data).sort();
  while (days.length > 14) { delete data[days.shift()]; }
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = COUNTERS_PATH + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, COUNTERS_PATH);
  return data[day][name];
}

export async function getCounters(d) {
  const day = stamp(d);
  try {
    const data = JSON.parse(await readFile(COUNTERS_PATH, 'utf8'));
    return data[day] || {};
  } catch (e) { return {}; }
}
