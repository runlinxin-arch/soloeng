import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './helpers/tmp.js';
;
import { join } from 'node:path';
import { PROXY_VARS, inheritedProxyVars, isReexecChild, readNetworkMode } from '../lib/proxy-bootstrap.js';

/**
 * 这一组测试回答一个问题：带着「已失效的代理」启动时，进程还能不能直连上网。
 *
 * 做法：本地起一个 HTTP 服务，把代理指向必定关闭的 127.0.0.1:9，
 * 并且**清掉 NO_PROXY**——否则 127.0.0.1 会被自动绕过，实验就没有区分度了。
 * 这样「走代理」必然失败、「直连」必然成功，结论唯一。
 */

const DEAD_PROXY = 'http://127.0.0.1:9';
const PROBE = 'test/helpers/network-probe.mjs';

let server;
let targetUrl;

before(async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  targetUrl = 'http://127.0.0.1:' + server.address().port + '/';
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

function runProbe(extraEnv, configPath) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, {
      http_proxy: DEAD_PROXY, https_proxy: DEAD_PROXY, NODE_USE_ENV_PROXY: '1'
    }, extraEnv || {});
    // 关键：本机地址也必须走代理，否则测不出问题
    delete env.NO_PROXY;
    delete env.no_proxy;

    const child = spawn(process.execPath, [PROBE, targetUrl, configPath || '/nonexistent-config.json'], {
      cwd: process.cwd(), env
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', () => resolve({ out, err }));
  });
}

test('带失效代理启动时会自愈，仍然能直连', async () => {
  const { out, err } = await runProbe();
  assert.match(err, /已用干净环境重启自身/, '应提示发生了自我重启，实际 stderr: ' + err.slice(0, 160));
  assert.match(out, /PROBE_OK 200/, '自愈后应能直连成功，实际 stdout: ' + out.slice(0, 160));
});

test('反证：跳过自愈时确实会失败（证明这组测试有区分度）', async () => {
  const { out, err } = await runProbe({ SOLOENG_REEXEC: '1' });
  assert.match(out, /PROBE_FAIL/, '跳过自愈本该失败；若这里通过了，说明测试没有区分度。stdout: ' + out.slice(0, 160));
  assert.doesNotMatch(err, /已用干净环境重启自身/, '跳过时不应有重启提示');
});

test('networkMode=env 时不重启（尊重「我要走代理」的选择）', async () => {
  const dir = await tempDir('engproxy-');
  const cfg = join(dir, 'config.json');
  await writeFile(cfg, JSON.stringify({ networkMode: 'env' }), 'utf8');
  const { out, err } = await runProbe({}, cfg);
  assert.doesNotMatch(err, /已用干净环境重启自身/, '显式选了 env 模式就不该重启');
  assert.match(out, /PROBE_FAIL/, 'env 模式下应老实走（失效的）代理');
});

test('没有代理变量时不重启（不应无谓多起一层进程）', async () => {
  const env = Object.assign({}, process.env);
  for (const k of PROXY_VARS) delete env[k];
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE, targetUrl], { cwd: process.cwd(), env });
    let o = '', e = '';
    child.stdout.on('data', (d) => { o += d.toString(); });
    child.stderr.on('data', (d) => { e += d.toString(); });
    child.on('exit', () => resolve({ o, e }));
  });
  assert.doesNotMatch(out.e, /已用干净环境重启自身/, '本来就干净，不该重启');
  assert.match(out.o, /PROBE_OK 200/);
});

test('inheritedProxyVars 只挑代理相关变量', () => {
  assert.deepEqual(inheritedProxyVars({ http_proxy: 'http://x', PATH: '/bin', NODE_USE_ENV_PROXY: '1' }),
    ['http_proxy', 'NODE_USE_ENV_PROXY']);
  assert.deepEqual(inheritedProxyVars({}), []);
});

test('isReexecChild 用哨兵变量防止无限重启', () => {
  assert.equal(isReexecChild({ SOLOENG_REEXEC: '1' }), true);
  assert.equal(isReexecChild({}), false);
});

test('readNetworkMode 读不到配置时按 direct 处理', () => {
  assert.equal(readNetworkMode('/definitely/not/here.json'), 'direct');
});
