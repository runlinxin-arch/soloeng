import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, PUBLIC_DIR, CONFIG_PATH } from './lib/paths.js';
import { loadConfig, saveConfig, checkVault, ensureVault, resolveVaultName, resolveVaultInfo, obsidianUrlFor, MODELS, LENGTH_MODES, THEMES } from './lib/config.js';
import { getSecrets } from './lib/secrets.js';
import { applyNetworkMode, proxyEnvPresent, throttle } from './lib/fetcher.js';
import { createService } from './lib/service.js';
import { ensureDirectNetwork } from './lib/proxy-bootstrap.js';
import { buildIndex, countDueToday, recentWords } from './lib/store.js';
import { todayISO } from './lib/dates.js';
import { info, error, redact } from './lib/log.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const AUDIO_HOST = 'www.oxfordlearnersdictionaries.com';

async function readBody(req, limit) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > (limit || 1000000)) throw new Error('请求体过大');
  }
  return data;
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data == null ? {} : data) + '\n\n');
}

export async function createApp(opts) {
  const o = opts || {};
  const loaded = o.config ? { config: o.config } : await loadConfig(o.configPath);
  let config = loaded.config;
  const net = applyNetworkMode(config.networkMode === 'env' ? 'env' : 'direct');
  if (net.removed.length) info('已清除代理变量（direct 模式）', { removed: net.removed.join(',') });

  const service = o.service || createService({ config });
  service.setConfig(config);

  async function state() {
    if (!config.vaultPath) return { total: 0, dueToday: 0, recent: [] };
    const idx = await buildIndex(config.vaultPath);
    return {
      total: idx.total,
      dueToday: countDueToday(idx.cards, new Date()),
      recent: await recentWords(config.vaultPath, 5)
    };
  }

  async function handle(req, res, url) {
    const p = url.pathname;

    if (p === '/api/health') {
      return sendJson(res, 200, { ok: true, today: todayISO(), network: net.mode, proxyEnv: proxyEnvPresent() });
    }

    if (p === '/api/state' && req.method === 'GET') {
      const s = await state();
      const secrets = await getSecrets();
      s.keyStatus = secrets.status;
      return sendJson(res, 200, s);
    }

    if (p === '/api/config' && req.method === 'GET') {
      const secrets = await getSecrets();
      return sendJson(res, 200, {
        config,
        keyStatus: secrets.status,
        secretsFound: secrets.found,
        vault: await checkVault(config.vaultPath),
        vaultName: await resolveVaultName(config.vaultPath, config.obsidianVaultName),
        options: { models: MODELS, lengthModes: LENGTH_MODES, themes: THEMES },
        dataDir: path.dirname(CONFIG_PATH)
      });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.action === 'checkVault') {
        return sendJson(res, 200, { vault: await checkVault(body.vaultPath || config.vaultPath) });
      }
      if (body.action === 'ensureVault') {
        const dir = body.vaultPath || config.vaultPath;
        const v = await ensureVault(dir);
        return sendJson(res, 200, { vault: v });
      }
      const next = Object.assign({}, config);
      for (const k of ['vaultPath', 'dailyNewLimit', 'dailyReviewLimit', 'model', 'enableMW', 'theme', 'lengthMode', 'networkMode', 'backupKeep']) {
        if (body[k] !== undefined) next[k] = body[k];
      }
      config = await saveConfig(next, o.configPath);
      service.setConfig(config);
      return sendJson(res, 200, { ok: true, config });
    }

    if (p === '/api/card' && req.method === 'GET') {
      const word = (url.searchParams.get('word') || '').toLowerCase();
      const store = service.deps.store;
      const card = await store.readCard(config.vaultPath, word);
      if (!card.exists) return sendJson(res, 404, { ok: false, error: '卡片不存在' });
      const info = await resolveVaultInfo(config.vaultPath, config.obsidianVaultName);
      return sendJson(res, 200, {
        ok: true, word, path: card.path, data: card.data, body: card.body,
        obsidianUrl: obsidianUrlFor(info, card.path)
      });
    }

    if (p === '/api/audio' && req.method === 'GET') {
      const target = url.searchParams.get('url') || '';
      let parsed;
      try { parsed = new URL(target); } catch (e) { return sendJson(res, 400, { ok: false, error: '非法音频地址' }); }
      // 只允许转发 OALD 官方媒体，防 SSRF
      if (parsed.host !== AUDIO_HOST || !parsed.pathname.startsWith('/media/')) {
        return sendJson(res, 403, { ok: false, error: '只允许牛津官方音频' });
      }
      try {
        await throttle(200);
        const upstream = await fetch(parsed.toString());
        if (!upstream.ok) return sendJson(res, 502, { ok: false, error: '音频源不可用' });
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=86400'
        });
        return res.end(buf);
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: '音频转发失败' });
      }
    }

    if (p === '/api/query/stream' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message) }); }
      sseHead(res);
      const ac = new AbortController();
      let closed = false;
      req.on('close', () => { closed = true; ac.abort(); });
      const secrets = await getSecrets();
      const t0 = Date.now();
      let wrote = false;
      try {
        const r = await service.query(body, {
          signal: ac.signal,
          apiKey: secrets.values.DEEPSEEK_API_KEY,
          secrets: secrets.values,
          onEvent: (ev, data) => {
            if (ev === 'done' && data && data.wrote !== false) wrote = true;
            sseSend(res, ev, data);
          }
        });
        sseSend(res, 'summary', { ok: r.ok !== false, mode: r.mode, ms: Date.now() - t0, wrote: Boolean(r.wrote) });
      } catch (e) {
        error('查询失败', e.message);
        sseSend(res, 'error', { code: 'INTERNAL', message: redact(e.message) });
      }
      if (!res.writableEnded) res.end();
      return undefined;
    }

    /* ---------- v2 复习 ---------- */
    if (p === '/api/review/today' && req.method === 'GET') {
      const r = await service.reviewToday({ continueAll: url.searchParams.get('continue') === '1' });
      return sendJson(res, r.ok === false ? 400 : 200, r);
    }

    if (p === '/api/review/rate' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await service.rateWord(body);
      return sendJson(res, r.ok === false ? 400 : 200, r);
    }

    if (p === '/api/review/suspend' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.word || !body.pos) return sendJson(res, 400, { ok: false, error: '缺少 word/pos' });
      const r = await service.setSuspended({ word: body.word, pos: body.pos, suspended: body.suspended !== false });
      return sendJson(res, r.ok === false ? 400 : 200, r);
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口' });

    /* ---------- 静态文件 ---------- */
    let rel = p === '/' ? '/index.html' : p;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    try {
      const s = await stat(filePath);
      if (!s.isFile()) throw new Error('not file');
      const buf = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(buf);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    handle(req, res, url).catch((e) => {
      error('未捕获请求错误', e && e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '内部错误' });
      else if (!res.writableEnded) res.end();
    });
  });

  return {
    server,
    get config() { return config; },
    setConfig: (c) => { config = c; service.setConfig(c); },
    service,
    state,
    listen(port, host) {
      return new Promise((resolve) => {
        server.listen(port, host || config.host || '127.0.0.1', () => resolve(server.address()));
      });
    }
  };
}

// 注意：项目路径含中文，import.meta.url 会被百分号编码，
// 不能直接与 'file://' + argv[1] 比较，必须走 fileURLToPath。
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
/**
 * 后端代码改动后，正在运行的进程仍然跑的是**内存里的旧代码**，
 * 改磁盘文件不会生效。这里主动提示需要重启，避免「改了没生效」的困惑。
 */
function watchForCodeChanges() {
  let timer = null;
  const notify = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log('');
      console.log('⚠️  检测到后端代码已更新，但当前进程仍在运行旧代码，改动不会生效。');
      console.log('   请按 Ctrl+C 停止，然后重新双击 start.command 启动。');
      console.log('');
    }, 300);
  };
  const watchers = [];
  try {
    watchers.push(watch(path.join(ROOT, 'lib'), notify));
    watchers.push(watch(path.join(ROOT, 'server.js'), notify));
  } catch (e) { /* 监听失败不影响服务 */ }
  // unref：绝不因为这个监听而阻止进程退出
  for (const w of watchers) { try { w.unref(); } catch (e) { /* ignore */ } }
}

if (isMain) {
  // 必须最先做：Node 在启动期就固定了 env proxy，运行时删变量已无效。
  // 带着（可能已失效的）代理变量启动时，这里会用干净环境重启自身再继续。
  const configPath = process.env.SOLOENG_CONFIG || CONFIG_PATH;
  await ensureDirectNetwork(configPath);

  watchForCodeChanges();
  // 允许用环境变量指向别的配置文件（测试/多库场景）
  const app = await createApp({ configPath });
  const cfg = app.config;
  const port = Number(process.env.PORT || cfg.port || 4317);
  await app.listen(port, cfg.host);
  info('服务已启动', { url: 'http://127.0.0.1:' + port, vault: cfg.vaultPath });
  console.log('个人英语学习 App 已启动：http://127.0.0.1:' + port);
  console.log('库路径：' + cfg.vaultPath);
  console.log('按 Ctrl+C 退出');
}
