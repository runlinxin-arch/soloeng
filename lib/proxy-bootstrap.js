import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * 直连自愈。
 *
 * 背景：Node 在**启动期**读到 NODE_USE_ENV_PROXY=1 后，就装好了 env-proxy
 * dispatcher 并把代理地址捕获下来。之后在运行时 delete process.env.http_proxy
 * 已经太晚——请求照样会打到那个代理。本机代理挂掉时（PRD 风险表里实测存在），
 * 结果就是所有 fetch 全失败。
 *
 * 所以唯一可靠的办法是让进程**一开始就干净**：检测到继承了代理变量、而配置又是
 * direct 模式时，用干净环境重启自身，父进程随后退出。子进程通过哨兵变量识别，
 * 避免无限重启。
 */

export const PROXY_VARS = [
  'http_proxy', 'https_proxy', 'all_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'NODE_USE_ENV_PROXY'
];

/** 当前环境里存在哪些代理相关变量（纯函数，便于测试） */
export function inheritedProxyVars(env) {
  const e = env || process.env;
  return PROXY_VARS.filter((k) => e[k]);
}

/** 简单布尔：是否已经是被重启出来的子进程 */
export function isReexecChild(env) {
  return (env || process.env).SOLOENG_REEXEC === '1';
}

/** 读取配置里的 networkMode，读不到就按 direct 处理 */
export function readNetworkMode(configPath) {
  try {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw).networkMode || 'direct';
  } catch (e) {
    return 'direct';
  }
}

/**
 * 保证后续网络请求真正走直连。
 * 返回后一定是「处于干净环境」；若需要重启，父进程会在子进程退出后 exit。
 *
 * @param {string} configPath 配置文件路径（用于尊重 networkMode: 'env'）
 * @param {object} [deps] 便于测试注入：{ spawn, exit, stderr, argv, execPath }
 */
export async function ensureDirectNetwork(configPath, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const argv = d.argv || process.argv;
  const execPath = d.execPath || process.execPath;
  const doSpawn = d.spawn || spawn;
  const exit = d.exit || process.exit;
  const stderr = d.stderr || process.stderr;

  if (isReexecChild(env)) return true;              // 已经重启过，防死循环
  const inherited = inheritedProxyVars(env);
  if (!inherited.length) return true;               // 本来就干净

  // 明确选择 env 模式时不重启（那是用户想让请求走代理）
  if (readNetworkMode(configPath) === 'env') return true;

  const childEnv = Object.assign({}, env, { SOLOENG_REEXEC: '1' });
  for (const k of PROXY_VARS) delete childEnv[k];

  stderr.write('[网络] 检测到继承的代理变量 ' + inherited.join(', ') +
    '，已用干净环境重启自身以走直连（否则请求会打到可能已失效的代理）\n');

  const child = doSpawn(execPath, argv.slice(1), { env: childEnv, stdio: 'inherit' });

  // 父子同组时终端 Ctrl+C 会一起收到；但单独 SIGTERM 父进程不会自动传给子进程，
  // 那样就会留下一个继续占端口的孤儿。这里显式转发。
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.on(sig, () => { try { child.kill(sig); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
  }

  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c));
    child.on('error', () => resolve(null));
  });
  exit(code === null || code === undefined ? 0 : code);
  return false;                                     // 父进程不会走到这里
}
