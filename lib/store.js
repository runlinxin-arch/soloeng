import { readFile, writeFile, mkdir, readdir, stat, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from './markdown.js';
import { BACKUP_DIR } from './paths.js';
import { todayISO, addDays } from './dates.js';

const FM_HEAD_BYTES = 16384;
export const ROOTS_HEADING = '## 词源与构词';

export function sanitizeWord(word) {
  return String(word == null ? '' : word).toLowerCase().replace(/[^a-z0-9'\-]/g, '');
}

export function cardPath(vaultPath, word) {
  return path.join(vaultPath, sanitizeWord(word) + '.md');
}

export function obsidianRelPath(vaultRoot, absPath) {
  return path.relative(vaultRoot, absPath).replace(/\\/g, '/');
}

/* ------------------------- 读 ------------------------- */

export async function readCard(vaultPath, word) {
  const p = cardPath(vaultPath, word);
  try {
    const raw = await readFile(p, 'utf8');
    const fm = parseFrontmatter(raw);
    return { exists: true, path: p, data: fm.data, body: fm.body, raw, hasFrontmatter: fm.hasFrontmatter };
  } catch (e) {
    return { exists: false, path: p, data: {}, body: '', raw: '', error: e.code === 'ENOENT' ? null : String(e.message) };
  }
}

/** 只读文件头部若干字节，避免为建索引读入整篇正文（资源预算 60–70MB） */
async function readFrontmatterHead(file, maxBytes) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes || FM_HEAD_BYTES);
    const r = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, r.bytesRead).toString('utf8');
    const fm = parseFrontmatter(text);
    return fm.hasFrontmatter ? fm.data : {};
  } catch (e) {
    return {};
  } finally {
    try { await fh.close(); } catch (e) { /* ignore */ }
  }
}

export async function listCards(vaultPath) {
  let names = [];
  try { names = await readdir(vaultPath); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || !/\.md$/i.test(name)) continue;
    const p = path.join(vaultPath, name);
    let st;
    try { st = await stat(p); } catch (e) { continue; }
    if (!st.isFile()) continue;
    out.push({
      word: name.replace(/\.md$/i, ''),
      path: p,
      data: await readFrontmatterHead(p),
      mtimeMs: st.mtimeMs
    });
  }
  return out;
}

export async function buildIndex(vaultPath) {
  const cards = await listCards(vaultPath);
  const byWord = new Map();
  for (const c of cards) byWord.set(c.word.toLowerCase(), c);
  return { cards, byWord, total: cards.length };
}

/** 最近查过的 N 个词（按 mtime 倒序） */
export async function recentWords(vaultPath, n) {
  const cards = await listCards(vaultPath);
  return cards.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, n || 5).map((c) => c.word);
}

/** 今日待复习数量（词性级；词级 suspended 的不计） */
export function countDueToday(cards, now) {
  const today = todayISO(now);
  let count = 0;
  for (const c of cards || []) {
    const srs = (c.data && c.data.srs) || [];
    const suspended = (c.data && c.data.suspended) || [];
    for (const s of srs) {
      if (suspended.includes(s.pos)) continue;
      if (s.due && String(s.due) <= today) count++;
    }
  }
  return count;
}

/* ------------------------- 写 ------------------------- */

export async function writeCard(vaultPath, word, data, body) {
  await mkdir(vaultPath, { recursive: true });
  const p = cardPath(vaultPath, word);
  await writeFile(p, stringifyFrontmatter(data, body), 'utf8');
  return p;
}

/** 拆分原文，保留 frontmatter 原样（用户可能在 Obsidian 手改过） */
export function splitRaw(raw) {
  const m = String(raw || '').match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) return { head: '', body: String(raw || '') };
  return { head: m[1], body: m[2] };
}

/**
 * 覆盖前备份（PRD 不变式 4）。保留最近 keep 份。
 */
export async function backupCard(vaultPath, word, raw, opts) {
  const o = opts || {};
  const dir = o.backupDir || BACKUP_DIR;
  const keep = o.keep === undefined ? 20 : o.keep;
  if (!raw) return null;
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = sanitizeWord(word) + '-' + ts;
  // 序号固定宽度且始终存在：保证「按文件名排序 == 按时间排序」，
  // 否则同一毫秒内的多份备份会让「保留最近 N 份」删错对象。
  let seq = 0;
  let file;
  do {
    file = path.join(dir, base + '-' + String(seq).padStart(3, '0') + '.md');
    seq++;
  } while (await fileExists(file));
  await writeFile(file, raw, 'utf8');
  await pruneBackups(dir, word, keep);
  return file;
}

async function fileExists(p) {
  try { await stat(p); return true; } catch (e) { return false; }
}

export async function pruneBackups(dir, word, keep) {
  const prefix = sanitizeWord(word) + '-';
  let names = [];
  try { names = await readdir(dir); } catch (e) { return []; }
  const mine = names.filter((n) => n.startsWith(prefix) && n.endsWith('.md')).sort();
  const removed = [];
  while (mine.length > keep) {
    const victim = mine.shift();
    try { await unlink(path.join(dir, victim)); removed.push(victim); } catch (e) { /* ignore */ }
  }
  return removed;
}

/**
 * 追加「词源与构词」区块：只改正文，frontmatter 与其它正文一字不动（T5.5）。
 * 若已存在同名区块则替换，避免重复堆叠。
 */
export async function upsertSection(vaultPath, word, heading, sectionMarkdown) {
  const card = await readCard(vaultPath, word);
  if (!card.exists) return { ok: false, reason: 'card_not_found', path: card.path };
  const { head, body } = splitRaw(card.raw);
  const esc = String(heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\n*' + esc + '[\\s\\S]*?(?=\\n## |$)');
  const withoutOld = body.replace(re, '');
  const trimmed = withoutOld.replace(/\s+$/, '');
  const nextBody = trimmed + '\n\n' + String(sectionMarkdown || '').trim() + '\n';
  await writeFile(card.path, head + nextBody, 'utf8');
  return { ok: true, path: card.path };
}

export async function appendRootsSection(vaultPath, word, sectionMarkdown) {
  return upsertSection(vaultPath, word, ROOTS_HEADING, sectionMarkdown);
}

/**
 * 骨架卡：辨析对象不在库时创建。只含词名 + 辨析链接 + 占位 frontmatter，
 * srs 为空 → 不进复习队列（PRD §2.2）。
 */
export async function createSkeletonCard(vaultPath, word, otherWord, opts) {
  const o = opts || {};
  const existing = await readCard(vaultPath, word);
  if (existing.exists) return { created: false, path: existing.path };
  const added = o.added || todayISO(o.now);
  const data = {
    word: String(word).toLowerCase(),
    ipa_uk: null,
    ipa_us: null,
    pos: [],
    oxford3000: false,
    opal: [],
    tags: otherWord ? ['易混:' + String(otherWord).toLowerCase()] : [],
    added,
    suspended: [],
    srs: []
  };
  const body = '# ' + word + '\n\n## 易混词辨析\nvs [[' + otherWord + ']]：待生成（点「重新生成」补全）\n';
  const p = await writeCard(vaultPath, word, data, body);
  return { created: true, path: p };
}

/* ------------------------- 卡片组装 ------------------------- */

/** 依据官方数据构造 frontmatter（§3.3）。首次入库 due = added + 1 天（附录 B）。 */
export function buildCardData(normalized, opts) {
  const o = opts || {};
  const added = o.added || todayISO(o.now);
  const n = normalized || {};
  const pos = n.pos || [];
  const srs = pos.map((p) => ({
    pos: p,
    due: addDays(added, 1),
    interval: 1,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    last: added
  }));
  return {
    word: n.word,
    ipa_uk: (n.ipa && n.ipa.uk) || null,
    ipa_us: (n.ipa && n.ipa.us) || null,
    // 只存音频地址，不落盘音频文件本身（PRD §6 发音音频不落盘）
    audio_uk: (n.audio && n.audio.uk) || null,
    audio_us: (n.audio && n.audio.us) || null,
    pos,
    oxford3000: Boolean(n.tags && n.tags.oxford3000),
    opal: (n.tags && n.tags.opal) || [],
    tags: o.tags || [],
    added,
    suspended: [],
    srs
  };
}

function blockOrMissing(text, isMissing) {
  return isMissing ? '> 官方词典未收录\n' : text;
}

/** LLM 失败时的降级正文：只给官方内容 + 明确标注（PRD §7.1-3） */
export function officialFallbackBody(normalized) {
  const n = normalized || {};
  const missing = new Set(n.missing || []);
  const lines = [];
  lines.push('> 讲解生成失败 · 点「重新生成」重试');
  lines.push('> 以下为官方词典原始内容（未做中文讲解）');
  lines.push('');

  lines.push('## 核心释义');
  if (!n.senses || !n.senses.length) lines.push('> 官方词典未收录');
  else {
    for (const s of n.senses) {
      lines.push('**' + (s.pos || '') + '** ' + (s.def || ''));
      for (const ex of (s.examples || []).slice(0, 2)) lines.push('> ' + ex.en);
      lines.push('');
    }
  }

  lines.push('## 固定搭配');
  if (!n.collocations || !n.collocations.categories || !n.collocations.categories.length) lines.push('> 官方词典未收录');
  else {
    for (const c of n.collocations.categories) lines.push('- **' + c.type + '**：' + c.items.join(', '));
  }
  lines.push('');

  lines.push('## 延伸义与词族');
  const rel = n.relations || {};
  const relEmpty = !(rel.synonyms || []).length && !(rel.antonyms || []).length && !rel.wordFamily;
  if (relEmpty) lines.push('> 官方词典未收录');
  else {
    if ((rel.synonyms || []).length) lines.push('- 近义词：' + rel.synonyms.join(', '));
    if ((rel.antonyms || []).length) lines.push('- 反义词：' + rel.antonyms.join(', '));
    if (rel.wordFamily) lines.push('- 词族：' + rel.wordFamily);
  }
  lines.push('');

  lines.push('## 易混词辨析');
  if (!(n.usageNotes || []).length) lines.push('> 官方词典未收录');
  else for (const u of n.usageNotes) lines.push(u.text);
  lines.push('');

  if (n.wordOrigin) {
    lines.push(ROOTS_HEADING);
    lines.push(n.wordOrigin);
    lines.push('');
  }

  return blockOrMissing(lines.join('\n').replace(/\n{3,}/g, '\n\n'), false);
}

/** 组装完整卡片正文（一级标题 + 正文） */
export function buildCardBody(normalized, llmText, opts) {
  const n = normalized || {};
  const head = '# ' + n.word + ((n.ipa && n.ipa.uk) ? ' ' + n.ipa.uk : '') + '\n';
  const o = opts || {};
  if (llmText && String(llmText).trim()) {
    return head + '\n' + String(llmText).trim() + '\n';
  }
  return head + '\n' + officialFallbackBody(n);
}
