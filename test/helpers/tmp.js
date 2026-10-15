import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 会自动清理的临时目录。
 *
 * 直接 mkdtemp 的话，每跑一次测试就在系统临时目录里留下一堆目录；
 * 累计上千个之后既难排查也占空间。这里登记所有创建过的目录，在进程退出时统一删除。
 *
 * 用 process.on('exit')：退出钩子里只能跑同步代码，所以用 rmSync。
 */

const created = new Set();
let hooked = false;

function installHook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const dir of created) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
    }
    created.clear();
  });
}

/** 创建临时目录；测试进程退出时自动删除 */
export async function tempDir(prefix) {
  installHook();
  const dir = await mkdtemp(join(tmpdir(), prefix || 'soloeng-test-'));
  created.add(dir);
  return dir;
}

/** 需要提前释放时手动调用（可选） */
export async function cleanupTempDirs() {
  for (const dir of created) {
    try { await rm(dir, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
    created.delete(dir);
  }
}
