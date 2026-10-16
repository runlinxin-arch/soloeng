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
import { nodeVersionProblem } from './helpers/engines.js';

// 先查版本：在 Node 22 上跑，失败的是两条代理测试（报错与版本毫无关系）；
// 在 Node 20 上连 node --test 的 glob 都不支持。与其让人对着莫名其妙的失败发呆，
// 不如在这里直接说清楚。
const problem = nodeVersionProblem();
if (problem) {
  console.error('✗ ' + problem);
  console.error('  Node 24 之前不支持 NODE_USE_ENV_PROXY，代理自愈与相关测试的行为都会不符预期；');
  console.error('  Node 20 的 node --test 还不支持 glob 参数，测试命令本身就跑不起来。');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'soloeng-testdata-'));
const env = Object.assign({}, process.env, { SOLOENG_DATA_DIR: dir });

const patterns = process.argv.slice(2);
const args = ['--test'].concat(patterns.length ? patterns : ['test/*.test.js']);

const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
child.on('exit', (code) => {
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
  process.exit(code === null ? 0 : code);
});
