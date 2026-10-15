import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { redact, stamp, logLine, bumpCounter, getCounters } from '../lib/log.js';
import { LOG_DIR, COUNTERS_PATH } from '../lib/paths.js';

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
