#!/usr/bin/env node
/**
 * 测试入口：先把数据目录重定向到一个临时目录，再跑 node --test。
 *
 * 为什么需要它：调用 bumpCounter 的测试文件会写进 lib/paths.js 里的 DATA_DIR，
 * 也就是仓库真实的 data/ —— 实测跑一次 npm test 就会改动本机应用的 counters.json。
 * 测试不该动真实应用数据。
 *
 * 边界说明：各测试文件是**独立进程**，所以这里只提供「互不打扰真实数据」的公共目录。
 * 需要断言计数器具体数值的文件（如 test/log.test.js）必须再给自己一份独立目录，
 * 否则并行跑的文件之间照样会互相踩踏 —— 那正是 CI 的 full 任务挂掉的原因。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'soloeng-testdata-'));
const env = Object.assign({}, process.env, { SOLOENG_DATA_DIR: dir });

const patterns = process.argv.slice(2);
const args = ['--test'].concat(patterns.length ? patterns : ['test/*.test.js']);

const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
child.on('exit', (code) => {
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
  process.exit(code === null ? 0 : code);
});
