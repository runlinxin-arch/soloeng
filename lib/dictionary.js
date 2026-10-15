import { fetchText as realFetchText, fetchJson as realFetchJson } from './fetcher.js';
import {
  OALD_BASE, CAMBRIDGE_BASE,
  parseOald, parseCambridge, parseOaldSuggestions, isOaldNotFound,
  discoverEntryUrls, parseMWCollegiate, parseMWThesaurus, clean
} from './parser.js';
import { normalize } from './normalize.js';
import { getSecrets } from './secrets.js';
import { info, warn, bumpCounter } from './log.js';

const MAX_POS_PAGES = 4;

function oaldUrl(word, n) {
  return OALD_BASE + '/definition/english/' + encodeURIComponent(word) + '_' + n;
}

export function cambridgeUrl(word) {
  return CAMBRIDGE_BASE + '/dictionary/english/' + encodeURIComponent(word);
}

export function mwUrls(word, keys) {
  return {
    collegiate: 'https://www.dictionaryapi.com/api/v3/references/collegiate/json/' +
      encodeURIComponent(word) + '?key=' + (keys.MW_COLLEGIATE_KEY || ''),
    thesaurus: 'https://www.dictionaryapi.com/api/v3/references/thesaurus/json/' +
      encodeURIComponent(word) + '?key=' + (keys.MW_THESAURUS_KEY || '')
  };
}

export function spellcheckUrl(word) {
  return OALD_BASE + '/spellcheck/english/?q=' + encodeURIComponent(word);
}

/**
 * 抓取 + 解析一个词，返回 { found, normalized, suggestions, sources }。
 * 任一来源失败都不允许整次查词失败（PRD 附录 A）。
 * fetchText / fetchJson 可注入，便于离线测试。
 */
export async function lookup(word, opts) {
  const o = opts || {};
  const fetchTextImpl = o.fetchText || realFetchText;
  const fetchJsonImpl = o.fetchJson || realFetchJson;
  const minIntervalMs = o.minIntervalMs === undefined ? 1500 : o.minIntervalMs;
  const deadlineMs = o.deadlineMs || 20000;
  const started = Date.now();
  const left = () => Math.max(0, deadlineMs - (Date.now() - started));

  const secrets = o.secrets || (await getSecrets()).values;
  const enableMW = o.enableMW !== false && Boolean(secrets.MW_COLLEGIATE_KEY);

  const sources = { oald: 'skipped', cambridge: 'skipped', mw: 'skipped' };
  const suggestions = [];
  let oaldEntries = [];
  let camEntries = [];
  let mwCollegiate = null;
  let mwThesaurus = null;

  /* ---- 主源：OALD（一词性一页，需互链发现） ---- */
  try {
    const first = await fetchTextImpl(oaldUrl(word, 1), { minIntervalMs, timeoutMs: o.timeoutMs });
    await bumpCounter('fetch.oald');
    if (isOaldNotFound(first.body)) {
      sources.oald = 'missing';
      const s = parseOaldSuggestions(first.body);
      for (const x of s) suggestions.push(x);
      if (!suggestions.length) {
        try {
          const sp = await fetchTextImpl(spellcheckUrl(word), { minIntervalMs, timeoutMs: o.timeoutMs });
          await bumpCounter('fetch.spellcheck');
          for (const x of parseOaldSuggestions(sp.body)) suggestions.push(x);
        } catch (e) { warn('spellcheck 失败', e.message); }
      }
    } else {
      const parsed = parseOald(first.body);
      oaldEntries = parsed.entries.filter(Boolean);
      if (!oaldEntries.length) {
        // 有响应但解析不出词条 → 等同未收录，绝不对外报 ok
        sources.oald = 'missing';
        for (const x of parseOaldSuggestions(first.body)) suggestions.push(x);
      } else {
      sources.oald = 'ok';
      const urls = discoverEntryUrls(first.body, oaldUrl(word, 1))
        .filter((u) => u !== oaldUrl(word, 1))
        .slice(0, MAX_POS_PAGES - 1);
      for (const u of urls) {
        if (left() < 3000) break;
        try {
          const r = await fetchTextImpl(u, { minIntervalMs, timeoutMs: o.timeoutMs });
          await bumpCounter('fetch.oald');
          if (!isOaldNotFound(r.body)) {
            const p = parseOald(r.body);
            for (const e of p.entries) if (e) oaldEntries.push(e);
          }
        } catch (e) { warn('OALD 其他词性页失败 ' + u, e.message); }
      }
      }
    }
  } catch (e) {
    sources.oald = 'error';
    warn('OALD 抓取失败', e.message);
  }

  /* ---- 回退源：剑桥（补 OALD 缺词，或补缺块） ---- */
  const needCam = sources.oald !== 'ok' || oaldEntries.length === 0 ||
    !oaldEntries.some((e) => (e.senses || []).length);
  if (needCam) {
    try {
      const rc = await fetchTextImpl(cambridgeUrl(word), { minIntervalMs, timeoutMs: o.timeoutMs });
      await bumpCounter('fetch.cambridge');
      const cam = parseCambridge(rc.body);
      camEntries = cam.entries || [];
      sources.cambridge = camEntries.length ? 'ok' : 'missing';
    } catch (e) {
      sources.cambridge = 'error';
      warn('剑桥抓取失败', e.message);
    }
  }

  /* ---- 补强源：MW（key 缺失自动跳过） ---- */
  if (enableMW) {
    const urls = mwUrls(word, secrets);
    try {
      const r = await fetchJsonImpl(urls.collegiate, { minIntervalMs, timeoutMs: o.timeoutMs });
      mwCollegiate = parseMWCollegiate(r.json);
      await bumpCounter('fetch.mw.collegiate');
      if (mwCollegiate.suggestions.length && !suggestions.length) {
        for (const s of mwCollegiate.suggestions) suggestions.push(s);
      }
      sources.mw = 'ok';
    } catch (e) { sources.mw = 'error'; warn('MW Collegiate 失败', e.message); }
    if (secrets.MW_THESAURUS_KEY && left() > 3000) {
      try {
        const r = await fetchJsonImpl(urls.thesaurus, { minIntervalMs, timeoutMs: o.timeoutMs });
        mwThesaurus = parseMWThesaurus(r.json);
        await bumpCounter('fetch.mw.thesaurus');
      } catch (e) { warn('MW Thesaurus 失败', e.message); }
    }
  }

  const normalized = normalize({
    word, oaldEntries, camEntries, mwCollegiate, mwThesaurus, sources
  });
  const found = normalized.found;
  info('lookup ' + word, { sources, found, missing: normalized.missing });

  return {
    word,
    found,
    normalized,
    suggestions: found ? [] : Array.from(new Set(suggestions)).slice(0, 8),
    sources
  };
}

/** 仅取 OALD 官方拼写建议（无词条时用） */
export async function suggest(word, opts) {
  const o = opts || {};
  const fetchTextImpl = o.fetchText || realFetchText;
  const r = await fetchTextImpl(spellcheckUrl(word), { minIntervalMs: o.minIntervalMs });
  return parseOaldSuggestions(r.body);
}
