import { parseInput } from './parse-input.js';
import { lookup as realLookup } from './dictionary.js';
import { generateCard, generateCompare, generateRoots, LENGTH_GUIDE } from './llm.js';
import * as realStore from './store.js';
import { todayISO } from './dates.js';
import { buildQueue, rate as srsRate } from './srs.js';
import { resolveVaultInfo, obsidianUrlFor } from './config.js';
import { info, warn } from './log.js';

/**
 * 查词流水线（把 HTTP 与业务分开，便于离线测试）。
 * 不变式：
 *  - 抓取失败绝不写文件（§4.3-5）
 *  - 生成失败不阻塞：官方内容照常入库并标注（§4.3-6）
 *  - 覆盖已有卡片前必须先备份（§4.3-4）
 */
export function createService(opts) {
  const o = opts || {};
  const deps = {
    lookup: o.lookup || realLookup,
    generateCard: o.generateCard || generateCard,
    generateCompare: o.generateCompare || generateCompare,
    generateRoots: o.generateRoots || generateRoots,
    store: o.store || realStore
  };
  let config = o.config || {};
  let vaultInfoCache = { vaultPath: null, info: null };

  /**
   * 卡片对应的 obsidian:// 链接。
   * 库信息按 vaultPath 缓存，避免每次查词都去 stat .obsidian。
   */
  async function cardObsidianUrl(vaultPath, word) {
    if (!vaultPath) return null;
    if (vaultInfoCache.vaultPath !== vaultPath) {
      const info = await resolveVaultInfo(vaultPath, (config || {}).obsidianVaultName);
      vaultInfoCache = { vaultPath, info };
    }
    if (!vaultInfoCache.info || !vaultInfoCache.info.name) return null;
    return obsidianUrlFor(vaultInfoCache.info, deps.store.cardPath(vaultPath, word));
  }

  async function query(params, ctx) {
    const p = params || {};
    const c = ctx || {};
    const emit = c.onEvent || function () {};
    const signal = c.signal;
    const cfg = config || {};
    const store = deps.store;
    const vaultPath = cfg.vaultPath;
    const lengthMode = p.lengthMode || cfg.lengthMode || 'standard';
    const model = cfg.model || 'deepseek-flash';
    const thinkingMode = cfg.thinkingMode || 'off';

    const parsed = parseInput(p.q);
    if (parsed.kind === 'empty') {
      emit('error', { code: 'EMPTY', message: '请输入一个英文单词' });
      return { ok: false, code: 'EMPTY', wrote: false };
    }
    if (parsed.kind === 'invalid') {
      emit('error', { code: parsed.reason === 'chinese' ? 'CHINESE' : 'INVALID', message: parsed.message });
      return { ok: false, code: parsed.reason, wrote: false };
    }

    if (!vaultPath) {
      emit('error', { code: 'NO_VAULT', message: '尚未配置 Obsidian 库路径，请打开设置' });
      return { ok: false, code: 'NO_VAULT', wrote: false };
    }

    /* ---------- 词根追加模式：对已有卡片是「追加」，不动其他内容 ---------- */
    if (parsed.kind === 'roots') {
      const existing = await store.readCard(vaultPath, parsed.word);
      emit('status', { phase: 'fetching', text: '正在读取牛津官方词典…' });
      const res = await deps.lookup(parsed.word, { enableMW: cfg.enableMW, secrets: c.secrets });
      if (!res.found) {
        emit('suggestions', { words: res.suggestions || [] });
        emit('error', { code: 'NOT_FOUND', message: '官方词典未收录该词' });
        return { ok: false, code: 'NOT_FOUND', wrote: false };
      }
      emit('status', { phase: 'generating', text: '正在生成「词源与构词」…' });
      const gen = await deps.generateRoots(res.normalized, { apiKey: c.apiKey, model, lengthMode, thinkingMode, signal });
      if (!existing.exists) {
        // 没有卡片时，按完整卡片写入（含词源区块）
        const data = store.buildCardData(res.normalized, { added: todayISO() });
        const body = store.buildCardBody(res.normalized, gen.text);
        if (p.noSave) {
          emit('done', { mode: 'unsaved', word: parsed.word, llmFailed: gen.degraded });
          return { ok: true, wrote: false, mode: 'unsaved' };
        }
        const path = await store.writeCard(vaultPath, parsed.word, data, body);
        emit('done', { mode: 'saved', path, word: parsed.word, llmFailed: gen.degraded });
        return { ok: true, wrote: true, mode: 'saved', path, generated: gen };
      }
      if (p.noSave) {
        emit('done', { mode: 'unsaved', word: parsed.word, llmFailed: gen.degraded });
        return { ok: true, wrote: false, mode: 'unsaved' };
      }
      const section = gen.ok && gen.text.trim() ? gen.text.trim() : store.ROOTS_HEADING + '\n' + (res.normalized.wordOrigin || '> 官方词典未收录');
      const backup = await store.backupCard(vaultPath, parsed.word, existing.raw, { keep: cfg.backupKeep });
      await store.upsertSection(vaultPath, parsed.word, store.ROOTS_HEADING, section);
      emit('done', { mode: 'appended', path: existing.path, word: parsed.word, llmFailed: gen.degraded, backup });
      return { ok: true, wrote: true, mode: 'appended', path: existing.path, backup };
    }

    /* ---------- 辨析模式 ---------- */
    if (parsed.kind === 'compare') {
      emit('status', { phase: 'fetching', text: '正在读取牛津官方词典…' });
      const a = await deps.lookup(parsed.word, { enableMW: cfg.enableMW, secrets: c.secrets });
      const b = await deps.lookup(parsed.other, { enableMW: cfg.enableMW, secrets: c.secrets });
      if (!a.found && !b.found) {
        emit('error', { code: 'NOT_FOUND', message: '官方词典未收录这两个词' });
        return { ok: false, code: 'NOT_FOUND', wrote: false };
      }
      emit('status', { phase: 'generating', text: '正在生成辨析…' });
      const gen = await deps.generateCompare(a.normalized, b.normalized, { apiKey: c.apiKey, model, lengthMode, thinkingMode, signal });
      // 对方词不在库 → 建骨架卡，避免死链
      const otherCard = await store.readCard(vaultPath, parsed.other);
      let skeleton = null;
      if (!otherCard.exists && b.found) {
        skeleton = await store.createSkeletonCard(vaultPath, parsed.other, parsed.word);
      }
      if (!gen.ok && gen.degraded) {
        emit('missing', { block: 'compare', reason: gen.error });
      }
      emit('chunk', { text: gen.text || '' });
      const existing = await store.readCard(vaultPath, parsed.word);
      if (p.noSave) {
        emit('done', { mode: 'unsaved', word: parsed.word, llmFailed: gen.degraded, skeleton: skeleton && skeleton.created });
        return { ok: true, wrote: false, mode: 'unsaved', skeleton };
      }
      if (!existing.exists) {
        const data = store.buildCardData(a.normalized, { added: todayISO() });
        const body = store.buildCardBody(a.normalized, gen.text);
        const path = await store.writeCard(vaultPath, parsed.word, data, body);
        emit('done', { mode: 'saved', path, word: parsed.word, llmFailed: gen.degraded, skeleton: skeleton && skeleton.created });
        return { ok: true, wrote: true, mode: 'saved', path, skeleton };
      }
      // 已有卡片：只替换「易混词辨析」区块，其余与 srs 一字不动
      const backup = await store.backupCard(vaultPath, parsed.word, existing.raw, { keep: cfg.backupKeep });
      const section = gen.ok && gen.text.trim() ? gen.text.trim() : '## 易混词辨析\n> 官方词典未收录';
      await store.upsertSection(vaultPath, parsed.word, '## 易混词辨析', section);
      emit('done', { mode: 'updated', path: existing.path, word: parsed.word, llmFailed: gen.degraded, backup, skeleton: skeleton && skeleton.created });
      return { ok: true, wrote: true, mode: 'updated', path: existing.path, backup, skeleton };
    }

    /* ---------- 单查 ---------- */
    const existing = await store.readCard(vaultPath, parsed.word);
    if (existing.exists && !p.force) {
      // 默认不覆盖、不调 API（PRD §7.1-6）
      emit('existing', {
        word: parsed.word,
        path: existing.path,
        updated: existing.data && existing.data.added,
        body: existing.body,
        data: existing.data,
        obsidianUrl: await cardObsidianUrl(vaultPath, parsed.word)
      });
      emit('done', { mode: 'existing', path: existing.path, word: parsed.word });
      return { ok: true, wrote: false, mode: 'existing', path: existing.path };
    }

    emit('status', { phase: 'fetching', text: '正在读取牛津官方词典…' });
    const res = await deps.lookup(parsed.word, { enableMW: cfg.enableMW, secrets: c.secrets });
    if (!res.found) {
      emit('suggestions', { words: res.suggestions || [] });
      emit('error', {
        code: 'NOT_FOUND',
        message: (res.suggestions && res.suggestions.length) ? '官方词典未收录该词，你是不是想查…' : '官方词典未收录该词'
      });
      return { ok: false, code: 'NOT_FOUND', wrote: false };  // 绝不写半张卡
    }

    const n = res.normalized;
    // 词头就要能用：链接指向即将写下的那个文件路径
    const obsidianUrl = p.noSave ? null : await cardObsidianUrl(vaultPath, parsed.word);
    emit('head', {
      word: n.word,
      ipa_uk: n.ipa.uk, ipa_us: n.ipa.us,
      audio_uk: n.audio.uk, audio_us: n.audio.us,
      pos: n.pos, tags: n.tags,
      obsidianUrl
    });
    for (const m of n.missing) emit('missing', { block: m, reason: '官方词典未收录' });

    emit('status', { phase: 'generating', text: '正在生成讲解…' });
    const gen = await deps.generateCard(n, { apiKey: c.apiKey, model, lengthMode, thinkingMode, signal });
    if (gen.ok && gen.text) {
      // 逐块推送，前端才有流式观感
      const parts = String(gen.text).match(/[\s\S]{1,120}/g) || [];
      for (const part of parts) {
        if (signal && signal.aborted) break;
        emit('chunk', { text: part });
      }
    }
    if (!gen.ok) emit('missing', { block: 'explanation', reason: gen.error });

    const data = store.buildCardData(n, { added: todayISO() });
    const body = store.buildCardBody(n, gen.ok ? gen.text : '');

    if (p.noSave) {
      emit('done', { mode: 'unsaved', word: n.word, llmFailed: gen.degraded });
      return { ok: true, wrote: false, mode: 'unsaved', normalized: n, llmFailed: gen.degraded, body };
    }

    let backup = null;
    if (existing.exists) backup = await store.backupCard(vaultPath, parsed.word, existing.raw, { keep: cfg.backupKeep });
    const path = await store.writeCard(vaultPath, parsed.word, data, body);
    info('卡片已写入 ' + parsed.word, { path, llmFailed: gen.degraded });
    emit('done', { mode: existing.exists ? 'regenerated' : 'saved', path, word: n.word, llmFailed: gen.degraded, backup });
    return { ok: true, wrote: true, mode: existing.exists ? 'regenerated' : 'saved', path, normalized: n, llmFailed: gen.degraded, backup };
  }

  /* ============================ v2 复习 ============================ */

  /** 今日队列（词 + 词性）。软上限由 config 控制，可 continueAll 超额。 */
  async function reviewToday(params) {
    const p = params || {};
    const cfg = config || {};
    const store = deps.store;
    if (!cfg.vaultPath) return { ok: false, error: 'NO_VAULT', items: [] };
    const cards = await store.listCards(cfg.vaultPath);
    const q = buildQueue(cards, {
      newLimit: cfg.dailyNewLimit,
      reviewLimit: cfg.dailyReviewLimit,
      continueAll: Boolean(p.continueAll),
      now: p.now
    });
    const items = q.items.map((it) => ({
      word: it.word,
      pos: it.pos,
      due: it.entry.due,
      reps: it.entry.reps,
      ipa_uk: it.data.ipa_uk || null,
      ipa_us: it.data.ipa_us || null,
      audio_uk: it.data.audio_uk || null,
      audio_us: it.data.audio_us || null,
      otherPos: (it.data.pos || []).filter((x) => x !== it.pos)
    }));
    return {
      ok: true, items, done: 0, remaining: q.remaining, dueTotal: q.dueTotal,
      newDue: q.newDue, reviewDue: q.reviewDue, limits: q.limits, today: q.today
    };
  }

  /** 评分回写：只更新对应词性的 srs 条目，正文与其它字段一字不动。 */
  async function rateWord(params) {
    const p = params || {};
    const cfg = config || {};
    const store = deps.store;
    if (!cfg.vaultPath) return { ok: false, error: 'NO_VAULT' };
    const grade = Number(p.grade);
    if (![1, 2, 3].includes(grade)) return { ok: false, error: 'BAD_GRADE' };
    const card = await store.readCard(cfg.vaultPath, p.word);
    if (!card.exists) return { ok: false, error: 'CARD_NOT_FOUND' };
    const srs = Array.isArray(card.data.srs) ? card.data.srs.slice() : [];
    const idx = srs.findIndex((e) => e.pos === p.pos);
    if (idx < 0) return { ok: false, error: 'ENTRY_NOT_FOUND' };
    const next = srsRate(srs[idx], grade, p.today || todayISO());
    srs[idx] = next;
    const data = Object.assign({}, card.data, { srs });
    await store.writeCard(cfg.vaultPath, p.word, data, card.body);
    info('评分回写 ' + p.word + '/' + p.pos, { grade, due: next.due, interval: next.interval });
    return { ok: true, entry: next };
  }

  /** 移出 / 重新加入复习队列：只改 suspended 数组，数据不删（PRD §7.2-13）。 */
  async function setSuspended(params) {
    const p = params || {};
    const cfg = config || {};
    const store = deps.store;
    if (!cfg.vaultPath) return { ok: false, error: 'NO_VAULT' };
    const card = await store.readCard(cfg.vaultPath, p.word);
    if (!card.exists) return { ok: false, error: 'CARD_NOT_FOUND' };
    const set = new Set(Array.isArray(card.data.suspended) ? card.data.suspended : []);
    if (p.suspended) set.add(p.pos); else set.delete(p.pos);
    const data = Object.assign({}, card.data, { suspended: Array.from(set) });
    await store.writeCard(cfg.vaultPath, p.word, data, card.body);
    return { ok: true, suspended: Array.from(set) };
  }

  return {
    query,
    reviewToday,
    rateWord,
    setSuspended,
    setConfig(c) { config = c || {}; },
    getConfig() { return config; },
    deps
  };
}
