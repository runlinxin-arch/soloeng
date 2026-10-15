import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROMPTS_DIR } from './paths.js';
import { getSecrets } from './secrets.js';
import { info, warn } from './log.js';

export const DEEPSEEK_BASE = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';

export const LENGTH_GUIDE = {
  quick: '约 150–250 字（速查）',
  standard: '约 400–600 字（标准）',
  intensive: '约 800–1200 字（精读）'
};

/**
 * 思考档位。实测（同一张 effect 卡、官方数据齐全）：
 *   off  → 思考 0 字，    正文首字 0.4s，总 ~3s   ← 默认，为满足 G1 的 10 秒预算
 *   low  → 思考 ~1.4k 字，正文首字 4.5s，总 ~10s
 *   high → 思考 ~4.4k 字，正文首字 8.8s，总 ~27s（接口默认，太慢）
 * 卡片正文本质是「把官方数据翻译整理成中文」，思考并不必需；需要更强推理时
 * 可在 config.json 把 thinkingMode 改为 low/high。
 *
 * 注意：**不要**用 max_tokens 限制长度。该接口把「思考 + 正文」算进同一个
 * 预算，一旦思考占满，正文就是空的。长度只能靠 prompt 约束。
 */
export const THINKING_MODES = ['off', 'low', 'high'];
export const DEFAULT_THINKING = 'off';

export function buildThinkingParams(mode) {
  const m = mode || DEFAULT_THINKING;
  if (m === 'off') return { thinking: { type: 'disabled' } };
  if (m === 'low') return { reasoning_effort: 'low' };
  return {};
}

export function renderPrompt(tpl, vars) {
  return String(tpl == null ? '' : tpl).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => {
    const v = vars ? vars[k] : undefined;
    return v === undefined || v === null ? '' : String(v);
  });
}

export async function loadPrompt(name, dir) {
  return readFile(path.join(dir || PROMPTS_DIR, name), 'utf8');
}

/**
 * 手工解析 SSE。必须能处理「一行被拆到两个 chunk」的情况，
 * 因此内部维护 buffer，只在遇到换行时 yield。
 */
export async function* parseSse(source) {
  let buf = '';
  for await (const chunk of source) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.length) yield buf.replace(/\r$/, '');
}

export function extractDelta(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  if (!t.startsWith('data:')) return null;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const obj = JSON.parse(payload);
    const d = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
    // 该接口会先流 reasoning_content（思考，常为 null content），
    // 那不属于卡片正文，必须忽略；只取 content。
    if (d && typeof d.content === 'string') return d.content;
    return null;
  } catch (e) { return null; }
}

async function* iterText(body) {
  if (!body) return;
  const dec = new TextDecoder();
  if (typeof body === 'string') { yield body; return; }
  for await (const chunk of body) {
    yield typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
  }
}

/**
 * DeepSeek 流式调用。失败一律抛错，由上层降级（PRD：生成失败不阻塞入库）。
 */
export async function streamChat(opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || fetch;
  const apiKey = o.apiKey;
  if (!apiKey) throw new Error('缺少 DeepSeek API key');
  const model = o.model || DEFAULT_MODEL;
  const payload = {
    model,
    messages: o.messages || [],
    stream: true,
    temperature: o.temperature === undefined ? 0.3 : o.temperature
  };
  Object.assign(payload, o.thinking ? o.thinking : buildThinkingParams(o.thinkingMode));
  // max_tokens 仅作显式覆盖用；默认绝不下发（会把思考算进预算导致正文为空）
  if (o.maxTokens) payload.max_tokens = o.maxTokens;

  const res = await fetchImpl(DEEPSEEK_BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify(payload),
    signal: o.signal
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { detail = ''; }
    throw new Error('DeepSeek HTTP ' + res.status + ' ' + String(detail).slice(0, 200));
  }
  let full = '';
  for await (const line of parseSse(iterText(res.body))) {
    const d = extractDelta(line);
    if (d) { full += d; if (o.onDelta) o.onDelta(d); }
  }
  return full;
}

/** 压缩官方数据，避免浪费 token（只带必要字段） */
export function toPromptData(n) {
  const senses = (n.senses || []).slice(0, 8).map((s) => ({
    pos: s.pos,
    grammar: s.grammar || undefined,
    labels: s.labels || undefined,
    def: s.def,
    examples: (s.examples || []).slice(0, 3).map((x) => (x.frame ? { frame: x.frame, en: x.en } : { en: x.en }))
  }));
  return {
    word: n.word,
    ipa: n.ipa,
    pos: n.pos,
    tags: n.tags,
    senses,
    collocations: n.collocations && n.collocations.categories,
    relations: {
      synonyms: (n.relations && n.relations.synonyms || []).slice(0, 15),
      antonyms: (n.relations && n.relations.antonyms || []).slice(0, 10),
      wordFamily: n.relations && n.relations.wordFamily
    },
    wordOrigin: n.wordOrigin,
    usageNotes: n.usageNotes,
    idioms: (n.idioms || []).slice(0, 8)
  };
}

/**
 * 生成卡片正文。
 * 返回 { ok, text, model, degraded, error }；degraded=true 表示讲解生成失败，
 * 但官方内容仍应照常入库（由调用方决定）。
 */
export async function generateCard(normalized, opts) {
  const o = opts || {};
  const apiKey = o.apiKey !== undefined ? o.apiKey : (await getSecrets()).values.DEEPSEEK_API_KEY;
  const model = o.model || DEFAULT_MODEL;
  if (!apiKey) {
    warn('generateCard 降级：未找到 DeepSeek key');
    return { ok: false, text: '', model, degraded: true, error: '未找到 DeepSeek key（~/.secrets 的 DEEPSEEK_API_KEY）' };
  }
  try {
    const tpl = await loadPrompt(o.promptFile || 'card.md', o.promptsDir);
    const prompt = renderPrompt(tpl, {
      word: normalized.word,
      lengthMode: o.lengthMode || 'standard',
      lengthGuide: LENGTH_GUIDE[o.lengthMode || 'standard'] || LENGTH_GUIDE.standard,
      missing: (normalized.missing || []).join(', ') || '无',
      data: JSON.stringify(toPromptData(normalized), null, 2)
    });
    const text = await streamChat(Object.assign({}, o, {
      apiKey, model,
      messages: [{ role: 'user', content: prompt }]
    }));
    if (!text || !text.trim()) {
      // 静默空输出必须当成失败，否则会写出一张没有讲解的「成功」卡片
      warn('generateCard 空输出（思考可能占满预算）');
      return { ok: false, text: '', model, degraded: true, error: '模型未返回正文' };
    }
    info('generateCard 完成 ' + normalized.word, { model, chars: text.length });
    return { ok: true, text, model, degraded: false, error: null };
  } catch (e) {
    warn('generateCard 失败（降级为只给官方内容）', e.message);
    return { ok: false, text: '', model, degraded: true, error: String(e.message) };
  }
}

/** 辨析模式生成 */
export async function generateCompare(a, b, opts) {
  const o = opts || {};
  const apiKey = o.apiKey !== undefined ? o.apiKey : (await getSecrets()).values.DEEPSEEK_API_KEY;
  const model = o.model || DEFAULT_MODEL;
  if (!apiKey) return { ok: false, text: '', model, degraded: true, error: '未找到 DeepSeek key' };
  try {
    const tpl = await loadPrompt(o.promptFile || 'diff.md', o.promptsDir);
    const prompt = renderPrompt(tpl, {
      word: a.word, other: b.word,
      lengthMode: o.lengthMode || 'standard',
      lengthGuide: LENGTH_GUIDE[o.lengthMode || 'standard'] || LENGTH_GUIDE.standard,
      dataA: JSON.stringify(toPromptData(a), null, 2),
      dataB: JSON.stringify(toPromptData(b), null, 2)
    });
    const text = await streamChat(Object.assign({}, o, {
      apiKey, model,
      messages: [{ role: 'user', content: prompt }]
    }));
    if (!text || !text.trim()) return { ok: false, text: '', model, degraded: true, error: '模型未返回正文' };
    return { ok: true, text, model, degraded: false, error: null };
  } catch (e) {
    return { ok: false, text: '', model, degraded: true, error: String(e.message) };
  }
}

/** 词源追加模式生成 */
export async function generateRoots(normalized, opts) {
  const o = opts || {};
  const apiKey = o.apiKey !== undefined ? o.apiKey : (await getSecrets()).values.DEEPSEEK_API_KEY;
  const model = o.model || DEFAULT_MODEL;
  if (!apiKey) return { ok: false, text: '', model, degraded: true, error: '未找到 DeepSeek key' };
  try {
    const tpl = await loadPrompt(o.promptFile || 'roots.md', o.promptsDir);
    const prompt = renderPrompt(tpl, {
      word: normalized.word,
      lengthMode: o.lengthMode || 'standard',
      lengthGuide: LENGTH_GUIDE[o.lengthMode || 'standard'] || LENGTH_GUIDE.standard,
      data: JSON.stringify({ word: normalized.word, wordOrigin: normalized.wordOrigin }, null, 2)
    });
    const text = await streamChat(Object.assign({}, o, {
      apiKey, model,
      messages: [{ role: 'user', content: prompt }]
    }));
    if (!text || !text.trim()) return { ok: false, text: '', model, degraded: true, error: '模型未返回正文' };
    return { ok: true, text, model, degraded: false, error: null };
  } catch (e) {
    return { ok: false, text: '', model, degraded: true, error: String(e.message) };
  }
}
