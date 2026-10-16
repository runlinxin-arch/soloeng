import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { tempDir } from './helpers/tmp.js';

// 必须放在 import lib/* 之前：paths.js 在模块加载时就把路径定下来了。
// 不隔离的话，本文件会与并行跑的其它测试文件共写真实 data/counters.json ——
// CI 的 full 任务正是这样挂的（dictionary 测试也在调 bumpCounter）。
process.env.SOLOENG_DATA_DIR = await tempDir('englog-');

const { redact, stamp, logLine, bumpCounter, getCounters } = await import('../lib/log.js');
const { LOG_DIR, COUNTERS_PATH } = await import('../lib/paths.js');

test('redact 抹掉所有密钥形态（PRD C7：密钥绝不进日志）', () => {
  const s = redact('call https://api.deepseek.com?key=sk-abcdef123456 and sk-zzzzzzzz');
  assert.ok(!s.includes('sk-abcdef123456'));
  assert.ok(!s.includes('sk-zzzzzzzz'));
  assert.ok(s.includes('key=***'));
  assert.equal(redact('MW_COLLEGIATE_KEY=supersecret'), 'MW_COLLEGIATE_KEY=***');
  assert.equal(redact('export DEEPSEEK_API_KEY=abc123'), 'export DEEPSEEK_API_KEY=***');
});

test('redact 不破坏普通文本', () => {
  assert.equal(redact('正在读取牛津官方词典…'), '正在读取牛津官方词典…');
});

test('stamp 为 YYYY-MM-DD', () => {
  assert.equal(stamp(new Date('2026-10-15T23:59:59')), '2026-10-15');
  assert.equal(stamp(new Date('2026-01-05T00:00:00')), '2026-01-05');
});

test('logLine 落盘且不写入明文密钥', async () => {
  const text = await logLine('INFO', '查词 effect，key=sk-leakme12345');
  assert.ok(!text.includes('sk-leakme12345'), '返回行不得含明文');
  const file = LOG_DIR + '/' + stamp() + '.log';
  const content = await readFile(file, 'utf8');
  assert.ok(content.includes('查词 effect'));
  assert.ok(!content.includes('sk-leakme12345'), '落盘内容不得含明文密钥');
});

test('bumpCounter 按日累加并持久化', async () => {
  await rm(COUNTERS_PATH, { force: true });
  const day = new Date('2026-10-15T12:00:00');
  assert.equal(await bumpCounter('fetch.oald', day), 1);
  assert.equal(await bumpCounter('fetch.oald', day), 2);
  assert.equal(await bumpCounter('fetch.cambridge', day), 1);
  const c = await getCounters(day);
  assert.equal(c['fetch.oald'], 2);
  assert.equal(c['fetch.cambridge'], 1);
  assert.deepEqual(await getCounters(new Date('2026-10-16T12:00:00')), {});
});

test('bumpCounter 并发调用一次都不能丢（同一进程）', async () => {
  const day = new Date('2026-01-02T12:00:00');
  await rm(COUNTERS_PATH, { force: true });
  const N = 50;
  await Promise.all(Array.from({ length: N }, () => bumpCounter('concurrent.test', day)));
  const c = await getCounters(day);
  assert.equal(c['concurrent.test'], N,
    '并发累加应一次不丢；读-改-写没串行化时会丢失（实测 6 进程各 20 次只落 4~14）');
});

test('计数器写入是原子的：不残留临时文件', async () => {
  const { readdir } = await import('node:fs/promises');
  const { dirname, basename } = await import('node:path');
  const day = new Date('2026-01-03T12:00:00');
  await bumpCounter('atomic.test', day);
  const files = await readdir(dirname(COUNTERS_PATH));
  const leftovers = files.filter((f) => f.startsWith(basename(COUNTERS_PATH)) && f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '写完后不应留下 .tmp 文件（rename 应当已把它移走）');
});

test('本文件使用隔离的数据目录，不污染仓库 data/', () => {
  assert.ok(COUNTERS_PATH.startsWith(tmpdir()),
    'COUNTERS_PATH 应落在临时目录，实际：' + COUNTERS_PATH);
  assert.ok(LOG_DIR.startsWith(tmpdir()),
    'LOG_DIR 应落在临时目录，实际：' + LOG_DIR);
});
