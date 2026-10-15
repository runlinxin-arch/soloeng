import { setTimeout as sleep } from 'node:timers/promises';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PROXY_VARS = [
  'http_proxy', 'https_proxy', 'all_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'
];

/**
 * 显式网络模式控制。
 * PRD 风险表：本机代理环境变量可能指向死端口 → 默认走 direct，绕过代理。
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
