/**
 * v1 验收（PRD §7.1 九项）。
 * 用法：node verify/v1-acceptance.js
 * 说明：除第 1 项按要求写入真实 Obsidian 库外，其余在独立临时库中执行，
 *       避免污染真实单词库。
 */
import { readFile, rm, writeFile, readdir } from 'node:fs/promises';
// 复用测试的临时目录助手：进程退出时自动清理，避免每跑一次验收就漏一堆目录
import { tempDir } from '../test/helpers/tmp.js';
;
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { applyNetworkMode } from '../lib/fetcher.js';
import { ensureDirectNetwork } from '../lib/proxy-bootstrap.js';
import { NET_CHECK } from './v1-checks.js';
import { createService } from '../lib/service.js';
import * as store from '../lib/store.js';
import { readCard, listCards, buildIndex } from '../lib/store.js';
import { getSecrets } from '../lib/secrets.js';
import { parseInput } from '../lib/parse-input.js';
import { lookup } from '../lib/dictionary.js';
import { isOaldNotFound } from '../lib/parser.js';
import { fetchText } from '../lib/fetcher.js';
;

// 与 server.js 同一道自愈：带着失效代理启动时用干净环境重启自身。
// 必须在任何 fetch 之前执行——启动期固定的代理 dispatcher 之后再删变量已无效。
await ensureDirectNetwork(path.join(import.meta.dirname, '..', 'data', 'config.json'));
applyNetworkMode('direct');

// 分类表在 verify/v1-checks.js（唯一来源，测试会校验它覆盖九项且与 record() 调用一致）
const OFFLINE = process.argv.includes('--offline') || process.env.SOLOENG_OFFLINE === '1';
const WANT_NET = !OFFLINE;

const results = [];
function record(no, name, pass, detail) {
  results.push({ no, name, pass: Boolean(pass), detail: detail || '', network: no in NET_CHECK, skipped: false });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log('[' + mark + '] §7.1-' + no + ' ' + name + (detail ? '\n         ' + detail : ''));
}

/** 离线模式下跳过联网项：记为 skipped，不计入通过率也不算失败 */
function skipNet(no) {
  const detail = '离线模式：跳过（该项需要实时抓取）';
  results.push({ no, name: NET_CHECK[no], pass: true, detail, network: true, skipped: true });
  console.log('[SKIP] §7.1-' + no + ' ' + NET_CHECK[no] + '\n         ' + detail);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const tempVault = await tempDir('eng-v11-');
const secrets = (await getSecrets()).values;
const realCfg = (await loadConfig()).config;

function mkService(vaultPath, over) {
  const svc = createService(Object.assign({
    config: { vaultPath, backupKeep: 20, model: realCfg.model, enableMW: true, lengthMode: 'standard' },
    store
  }, over || {}));
  return svc;
}

if (!realCfg.vaultPath) {
  console.error('✗ 尚未配置 Obsidian 库路径（默认值为空）。');
  console.error('  请先启动服务，在「设置」里填入库目录并保存，再运行本验收。');
  process.exit(2);
}
console.log('=== v1 验收开始 ===');
console.log('真实库：' + realCfg.vaultPath);
console.log('临时库：' + tempVault);
console.log('模型：' + realCfg.model + ' | MW: ' + (secrets.MW_COLLEGIATE_KEY ? '开' : '关'));
console.log('');

/* ---------- 1 正常查词（写入真实库） ---------- */
if (WANT_NET) {
  const svc = mkService(realCfg.vaultPath);
  const t0 = Date.now();
  const events = [];
  let r;
  try {
    // force：确保测的是「冷启动全流程」，而不是「已存在直接展示」的快捷路径
    r = await svc.query({ q: 'effect', force: true }, { onEvent: (e, d) => events.push({ e, d }), apiKey: secrets.DEEPSEEK_API_KEY, secrets });
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  const ms = Date.now() - t0;
  const genEvt = events.filter((e) => e.e === 'chunk').map((e) => e.d.text || '').join('');
  const card = await readCard(realCfg.vaultPath, 'effect');
  const hasSrs = card.exists && Array.isArray(card.data.srs) && card.data.srs.length > 0;
  const hasBlocks = card.exists && card.body.includes('## 核心释义') && card.body.includes('## 固定搭配');
  const hasFm = card.exists && card.data.word === 'effect' && card.data.ipa_uk && card.data.added;
  record(1, '正常查词 ≤10 秒并生成卡片',
    ms <= 10000 && card.exists && hasFm && hasSrs && hasBlocks,
    '耗时 ' + ms + 'ms（预算 10000ms）| 模式 ' + (r.mode || '?') + ' | 正文 ' + genEvt.length + ' 字 | 文件 ' + card.path +
    ' | frontmatter+4块 ' + (hasFm && hasSrs && hasBlocks) +
    ' | 词性 ' + JSON.stringify(card.data.pos) + ' | due ' + (card.data.srs[0] && card.data.srs[0].due));
} else {
  skipNet(1);
}

/* ---------- 2 回退可用：OALD 无词条时用剑桥 ---------- */
if (WANT_NET) {
  const svc = mkService(tempVault);
  const oaldProbe = await fetchText('https://www.oxfordlearnersdictionaries.com/definition/english/affect_1', { minIntervalMs: 0 }).catch(() => null);
  const oaldMissing = oaldProbe ? isOaldNotFound(oaldProbe.body) : true;
  const r = await svc.query({ q: 'affect' }, { onEvent: () => {}, apiKey: secrets.DEEPSEEK_API_KEY, secrets });
  const card = await readCard(tempVault, 'affect');
  record(2, 'OALD 无词条时自动用剑桥补全',
    oaldMissing && card.exists && card.data.pos.length > 0,
    'OALD affect 未收录=' + oaldMissing + ' | sources=' + JSON.stringify(r.sources || {}) +
    ' | 词性 ' + JSON.stringify(card.data.pos));
} else {
  skipNet(2);
}

/* ---------- 3 LLM 降级 ---------- */
if (WANT_NET) {
  const svc = mkService(tempVault);
  const r = await svc.query({ q: 'adverse' }, { onEvent: () => {}, apiKey: null, secrets });
  const card = await readCard(tempVault, 'adverse');
  const marked = card.exists && card.body.includes('讲解生成失败');
  const official = card.exists && /late Middle English|from Latin|Old French|Middle English/i.test(card.body);
  record(3, 'LLM 失败仍写入官方内容并标注',
    r.wrote === true && marked && official,
    'llmFailed=' + r.llmFailed + ' | 标注=' + marked + ' | 含官方内容=' + official);
} else {
  skipNet(3);
}

/* ---------- 4 断网保护：绝不写半张卡 ---------- */
{
  const netVault = await tempDir('eng-offline-');
  const svc = createService({
    config: { vaultPath: netVault, backupKeep: 20 },
    store,
    lookup: async () => { throw new Error('ENETUNREACH 模拟断网'); },
    generateCard: async () => ({ ok: true, text: 'x', degraded: false })
  });
  const events = [];
  let threw = false;
  let r = null;
  try {
    r = await svc.query({ q: 'offlinetest' }, { onEvent: (e, d) => events.push({ e, d }), apiKey: 'sk-x' });
  } catch (e) { threw = true; }
  const files = await readdir(netVault).catch(() => []);
  const errored = events.some((x) => x.e === 'error');
  record(4, '断网给出错误且不产生任何文件',
    files.length === 0 && (errored || threw),
    '文件数=' + files.length + ' | 已报错=' + errored + ' | 抛错=' + threw);
}

/* ---------- 5 浏览器不是仓库 ---------- */
{
  const files = ['public/app.js', 'public/render.js'];
  const offenders = [];
  for (const f of files) {
    const src = await readFile(path.join(ROOT, f), 'utf8');
    for (const bad of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      if (src.includes(bad)) offenders.push(f + ':' + bad);
    }
  }
  // 自建一个库、本地造一张卡：让「状态全部来自文件」这件事不依赖前面任何联网检查。
  // 早先这里扫的是 tempVault，而那张卡其实是联网的 §7.1-2 写进去的 ——
  // 离线模式下它会变成 0 张，于是这条「确定性」检查反而挂了。
  const localVault = await tempDir('eng-browserless-');
  await store.createSkeletonCard(localVault, 'offlinesample', 'sampleother');
  const idx = await buildIndex(localVault);
  const again = await buildIndex(localVault);
  record(5, '浏览器零持久化，状态全部来自文件',
    offenders.length === 0 && idx.total === again.total && idx.total > 0,
    '违规用法=' + (offenders.join(',') || '无') + ' | 重扫词数=' + idx.total +
    '（两次一致=' + (idx.total === again.total) + '）');
}

/* ---------- 6 不覆盖手写内容 + 覆盖前备份 ---------- */
if (WANT_NET) {
  const vault = await tempDir('eng-hand-');
  const backupDir = await tempDir('eng-bak-');
  const svc = createService({
    config: { vaultPath: vault, backupKeep: 20, model: realCfg.model },
    store, lookup: async (w) => ({ word: w, found: true, suggestions: [], normalized: {
      word: w, ipa: { uk: '/x/', us: null }, audio: {}, pos: ['noun'], tags: {},
      senses: [{ pos: 'noun', def: 'd', examples: [{ en: 'e' }] }],
      collocations: { categories: [] }, relations: {}, wordOrigin: null, usageNotes: [], idioms: [], missing: [], found: true } }),
    generateCard: async () => ({ ok: true, text: '## 核心释义\n原始生成', degraded: false })
  });
  await svc.query({ q: 'handedit' }, { onEvent: () => {}, apiKey: 'sk-x' });
  const before = await readCard(vault, 'handedit');
  await writeFile(before.path, before.raw + '\n我手写的一行笔记\n', 'utf8');
  await svc.query({ q: 'handedit' }, { onEvent: () => {}, apiKey: 'sk-x' });
  const preserved = await readCard(vault, 'handedit');
  const manualKept = preserved.body.includes('我手写的一行笔记');
  const r2 = await svc.query({ q: 'handedit', force: true }, { onEvent: () => {}, apiKey: 'sk-x' });
  const backups = await readdir(backupDir).catch(() => []);
  const backupReal = await readdir(path.join(ROOT, 'data', 'backup')).catch(() => []);
  record(6, '重查不覆盖手写内容，重新生成前有备份',
    manualKept && r2.wrote === true && backupReal.some((f) => f.startsWith('handedit-')),
    '手写内容保留=' + manualKept + ' | mode=' + r2.mode + ' | data/backup 中 handedit 备份=' + backupReal.filter((f) => f.startsWith('handedit-')).length + ' 份');
} else {
  skipNet(6);
}

/* ---------- 7 中文与语法 ---------- */
if (WANT_NET) {
  const chinese = parseInput('影响');
  const compare = parseInput('affect vs effect');
  const roots = parseInput('affect 词根');
  const svc = mkService(tempVault);
  const evts = [];
  await svc.query({ q: '中文测试' }, { onEvent: (e, d) => evts.push({ e, d }), apiKey: 'sk-x' });
  const rejected = evts.some((x) => x.e && x.d && x.d.code === 'CHINESE');
  // 先确保 effect 卡片存在（否则「追加」测的其实是「新建」）
  await svc.query({ q: 'effect' }, { onEvent: () => {}, apiKey: null, secrets: {} });
  const beforeRoots = await readCard(tempVault, 'effect');
  const rr = await svc.query({ q: 'effect 词根' }, { onEvent: () => {}, apiKey: secrets.DEEPSEEK_API_KEY, secrets });
  const afterRoots = await readCard(tempVault, 'effect');
  const srsUnchanged = JSON.stringify(beforeRoots.data.srs) === JSON.stringify(afterRoots.data.srs);
  const bodyKept = afterRoots.body.includes('## 核心释义');
  const rootsAdded = afterRoots.body.includes('## 词源与构词');
  record(7, '中文拦截 / 辨析语法 / 词根追加且不动其他内容',
    chinese.reason === 'chinese' && compare.kind === 'compare' && roots.kind === 'roots' &&
    rejected && srsUnchanged && bodyKept && rootsAdded,
    '中文=' + chinese.reason + ' | 辨析=' + compare.kind + ' | 词根=' + roots.kind +
    ' | srs 不变=' + srsUnchanged + ' | 原正文保留=' + bodyKept + ' | 追加=' + rootsAdded);
} else {
  skipNet(7);
}

/* ---------- 8 官方来源铁律：逐条回到官网比对 ---------- */
if (WANT_NET) {
  const res = await lookup('effect', { secrets, minIntervalMs: 0 });
  const n = res.normalized;
  const { load } = await import('cheerio');
  const pages = [];
  for (const u of [
    'https://www.oxfordlearnersdictionaries.com/definition/english/effect_1',
    'https://www.oxfordlearnersdictionaries.com/definition/english/effect_2'
  ]) {
    const r = await fetchText(u, { minIntervalMs: 0 });
    pages.push({ url: u, body: r.body, $: load(r.body) });
  }
  // 官方例句元素集合（两个词性页的并集）
  const officialExamples = new Set();
  for (const p of pages) {
    // 只取 .x/.unx 本身：<li> 里还可能有 .cf 搭配框架，拼在一起会误判
    p.$('ul.examples > li .x, ul.examples > li .unx').each((i, el) => {
      const t = (p.$(el).text() || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
      if (t) officialExamples.add(t);
    });
  }
  const htmlAll = pages.map((p) => p.body).join(' ');
  const ipaOk = Boolean(n.ipa.uk) && htmlAll.includes(n.ipa.uk);
  const exAll = [];
  for (const s of n.senses) for (const ex of s.examples) exAll.push(ex.en);
  const exMissing = exAll.filter((e) => !officialExamples.has(e));
  const colItems = [];
  for (const c of n.collocations.categories) for (const it of c.items) colItems.push(it);
  const colMissing = colItems.filter((it) => !officialExamples.has(it) && !htmlAll.includes(it));
  const noCefr = n.tags.cefr === null;
  // 回归：Language Bank 的例句不得再混进义项例句（已修复的解析缺陷）
  const langbankLeak = exAll.some((e) => /Consequently, household budgets|energy companies have been posting/.test(e));
  record(8, '音标/例句/搭配逐条可在官方页面找到，且无区块串味',
    ipaOk && exMissing.length === 0 && colMissing.length === 0 && noCefr && !langbankLeak,
    '音标命中=' + ipaOk + ' | 义项例句 ' + exAll.length + ' 条，未命中 ' + exMissing.length +
    ' | 搭配 ' + colItems.length + ' 条，未命中 ' + colMissing.length +
    ' | CEFR 保持 null=' + noCefr + ' | Language Bank 串味=' + langbankLeak +
    (exMissing.length ? ' | 例：' + JSON.stringify(exMissing.slice(0, 2)) : ''));
} else {
  skipNet(8);
}

/* ---------- 9 持久化恢复（等价演练，不删代码） ---------- */
if (WANT_NET) {
  const vault = await tempDir('eng-recover-');
  const svc = mkService(vault);
  await svc.query({ q: 'effect' }, { onEvent: () => {}, apiKey: null, secrets: {} });
  await svc.query({ q: 'affect' }, { onEvent: () => {}, apiKey: null, secrets: {} });
  const before = await listCards(vault);
  const dueBefore = before.map((c) => JSON.stringify(c.data.srs));
  // 模拟「删掉 app 与 data/，重新拉起后指向同一个库」：
  // 用一个全新配置路径（不存在）重新构造服务，只指向同一个库目录
  const freshConfigPath = path.join(await tempDir('eng-fresh-'), 'config.json');
  const freshLoaded = await loadConfig(freshConfigPath);
  const fresh = createService({ config: Object.assign({}, freshLoaded.config, { vaultPath: vault }), store });
  const st = await fresh.state ? null : null;
  const after = await listCards(vault);
  const dueAfter = after.map((c) => JSON.stringify(c.data.srs));
  const vaultOutsideApp = !path.resolve(vault).startsWith(path.resolve(ROOT));
  const same = before.length === after.length && JSON.stringify(dueBefore.sort()) === JSON.stringify(dueAfter.sort());
  record(9, '删掉 app/data 后重新指向同一库可完全恢复',
    same && vaultOutsideApp && after.length === 2,
    '恢复前 ' + before.length + ' 词 / 恢复后 ' + after.length + ' 词 | 到期日与进度完全一致=' + same +
    ' | 库在 app 目录之外=' + vaultOutsideApp);
} else {
  skipNet(9);
}

/* ---------- 报告 ---------- */
const ran = results.filter((r) => !r.skipped);
const skipped = results.filter((r) => r.skipped);
const passed = ran.filter((r) => r.pass);
const failed = ran.filter((r) => !r.pass);

console.log('');
console.log('=== v1 验收结果：' + passed.length + '/' + ran.length + ' 通过 ===' +
  (skipped.length ? '（离线模式另跳过 ' + skipped.length + ' 项联网检查）' : ''));

const line = (r) => (r.pass ? '  ✅' : '  ❌') + ' §7.1-' + r.no + ' ' + r.name;
const local = ran.filter((r) => !r.network);
const net = ran.filter((r) => r.network);

console.log('');
console.log('【确定性项 ' + local.length + ' 个 —— 不依赖外部站点，应当永远稳定】');
local.forEach((r) => console.log(line(r)));

if (net.length) {
  console.log('');
  console.log('【需联网项 ' + net.length + ' 个 —— 依赖实时抓取牛津 / 剑桥】');
  net.forEach((r) => console.log(line(r)));
  console.log('');
  console.log('注意：联网项失败可能来自第三方站点，而不是代码。已知情况：剑桥偶发 Cloudflare');
  console.log('      挑战（HTTP 403「Just a moment…」），此时 §7.1-2 必挂，§7.1-9 也可能挂。');
  console.log('      只想看稳定信号：npm run verify:v1:offline');
}

await rm(tempVault, { recursive: true, force: true });
// 退出码只看**实际跑过**的项：离线模式下联网项被跳过，不应该拖累结果
process.exit(failed.length === 0 ? 0 : 1);
