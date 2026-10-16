import { setTimeout as sleep } from 'node:timers/promises';
// 代理变量清单只此一份（定义在 proxy-bootstrap），避免两处清单漂移：
// 一旦漂移，自愈会漏掉某个变量，网络在代理失效时静默中断。
import { PROXY_VARS } from './proxy-bootstrap.js';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 网络模式控制——**注意它并不能真正绕过已经装好的代理**。
 *
 * Node 在启动期读到 NODE_USE_ENV_PROXY=1 时就装好了 env-proxy dispatcher 并
 * 捕获了代理地址；此后在运行时 delete process.env.http_proxy 已经太晚，请求
 * 仍会打到那个代理。实测：带着失效代理启动时，本函数执行后 fetch 依然失败。
 *
 * 真正保证直连的是 lib/proxy-bootstrap.js 的 ensureDirectNetwork()——它在启动
 * 最开始用干净环境重启进程。本函数仅作兜底：当进程本来就是干净的时候（例如被
 * 库的方式调用、或由 start.command 预先 unset 过）才具有实际意义。
 *
 * 'direct' = 清掉进程内代理变量；'env' = 保留（尊重环境）。
 */
export function applyNetworkMode(mode) {
  if (mode !== 'direct') return { mode: 'env', removed: [] };
  const removed = [];
  for (const k of PROXY_VARS) {
    if (process.env[k]) { removed.push(k); delete process.env[k]; }
  }
  return { mode: 'direct', removed };
}

export function proxyEnvPresent() {
  return PROXY_VARS.filter((k) => process.env[k]);
}

let lastAt = 0;
export async function throttle(minIntervalMs = 0) {
  const wait = lastAt + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7'
};

async function request(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 25000;
  const retries = o.retries === undefined ? 2 : o.retries;
  const minIntervalMs = o.minIntervalMs === undefined ? 1200 : o.minIntervalMs;
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    await throttle(minIntervalMs);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: Object.assign({}, BROWSER_HEADERS, o.headers || {}),
        redirect: 'follow',
        signal: ac.signal
      });
      const body = await res.text();
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, finalUrl: res.url, body, ms: Date.now() - t0, attempts: attempt };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt <= retries) await sleep(400 * attempt);
    }
  }
  throw new Error('fetch failed after ' + (retries + 1) + ' attempts :: ' + url + ' :: ' + (lastErr && lastErr.message));
}

export async function fetchText(url, opts) {
  return request(url, opts);
}

export async function fetchJson(url, opts) {
  const r = await request(url, opts);
  try { r.json = JSON.parse(r.body); }
  catch (e) { r.json = null; r.parseError = String(e.message); }
  return r;
}
