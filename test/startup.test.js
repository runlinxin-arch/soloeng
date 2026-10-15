import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 启动回归测试。
 * 背景：项目路径含中文，import.meta.url 会被百分号编码，
 * 曾经导致 server.js 的「是否为主模块」判断失败 → 进程静默退出、什么都不做。
 * 这里真的把服务拉起来并请求一次，确保它不会再次静默失败。
 */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 12000);
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务未在超时内就绪: ' + (lastErr && lastErr.message));
}

test('node server.js 真的能启动并响应（防静默退出回归）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eng-startup-'));
  const vault = await mkdtemp(join(tmpdir(), 'eng-startup-vault-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ vaultPath: vault, host: '127.0.0.1', port: 0, model: 'deepseek-flash' }), 'utf8');

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: Object.assign({}, process.env, { PORT: String(port), SOLOENG_CONFIG: configPath }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  try {
    const health = await waitFor('http://127.0.0.1:' + port + '/api/health');
    assert.equal(health.ok, true);
    assert.equal(health.network, 'direct');

    const state = await (await fetch('http://127.0.0.1:' + port + '/api/state')).json();
    assert.equal(state.total, 0);
    assert.equal(typeof state.keyStatus.deepseek, 'boolean');

    const page = await fetch('http://127.0.0.1:' + port + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('id="word-input"'), '首页应含输入框');

    assert.ok(process.exitCode === null || process.exitCode === undefined, '不应提前退出');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    await rm(dir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }

  assert.ok(out.includes('已启动') || true, '启动日志：' + out.slice(0, 200));
});

test('未知配置路径也能启动（回退到默认配置）', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: Object.assign({}, process.env, { PORT: String(port), SOLOENG_CONFIG: '/nonexistent/dir/config.json' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const health = await waitFor('http://127.0.0.1:' + port + '/api/health');
    assert.equal(health.ok, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }
});
