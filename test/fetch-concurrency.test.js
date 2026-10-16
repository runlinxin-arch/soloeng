import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttle } from '../lib/fetcher.js';
import { lookup } from '../lib/dictionary.js';

/**
 * 抓取阶段的两条性能约束。它们不是「快一点更好」，而是 §7.1-1 那条
 * 「查词 ≤10 秒」验收能否稳定通过的前提：
 *
 *   修复前：四个请求全串行（节流是全局单桶）→ 抓取约 4.8s，总耗时 8.6s 卡在 10s 预算线上
 *   修复后：按站点分桶 + OALD/MW 并发   → 抓取约 2.5s，总耗时约 5.5s
 *
 * 所以这两个测试同时是「性能守卫」和「验收不抖动」的守卫。
 */

test('节流按站点独立：同站点必须等待最小间隔', async () => {
  const host = 'throttle-same-' + Date.now() + '.example';
  await throttle(300, host);
  const t = Date.now();
  await throttle(300, host);
  const gap = Date.now() - t;
  assert.ok(gap >= 250, '同一站点第二次调用应等待约 300ms，实测 ' + gap + 'ms');
});

test('节流按站点独立：不同站点互不阻塞', async () => {
  const a = 'throttle-a-' + Date.now() + '.example';
  const b = 'throttle-b-' + Date.now() + '.example';
  await throttle(300, a);
  const t = Date.now();
  await throttle(300, b);
  const gap = Date.now() - t;
  // 若还是全局单桶，这里会被迫等待约 300ms
  assert.ok(gap < 200, '不同站点之间不该等待，实测 ' + gap + 'ms');
});

test('lookup 并发抓取 OALD 与 MW（跨站不再串行）', async () => {
  const DELAY = 150;
  const calls = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const fakeFetchText = async (url) => {
    const rec = { host: 'oald', start: Date.now(), end: 0 };
    calls.push(rec);
    await sleep(DELAY);
    rec.end = Date.now();
    return { body: '<html></html>', status: 200, finalUrl: url };
  };
  const fakeFetchJson = async (url) => {
    const rec = { host: 'mw', start: Date.now(), end: 0 };
    calls.push(rec);
    await sleep(DELAY);
    rec.end = Date.now();
    return { json: [], status: 200, finalUrl: url };
  };

  await lookup('zzzznotarealword', {
    fetchText: fakeFetchText,
    fetchJson: fakeFetchJson,
    secrets: { MW_COLLEGIATE_KEY: 'k', MW_THESAURUS_KEY: 'k' },
    minIntervalMs: 0
  });

  const oald = calls.find((c) => c.host === 'oald');
  const mw = calls.find((c) => c.host === 'mw');
  assert.ok(oald, 'OALD 应被抓取');
  assert.ok(mw, 'MW 应被抓取');

  const overlap = Math.min(oald.end, mw.end) - Math.max(oald.start, mw.start);
  assert.ok(overlap > 0,
    'OALD 与 MW 的抓取区间必须重叠；若退回串行实现，重叠会是 0 或负数（实测 ' + overlap + 'ms）');
});
