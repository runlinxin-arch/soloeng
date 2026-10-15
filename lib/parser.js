import { load } from 'cheerio';

export const OALD_BASE = 'https://www.oxfordlearnersdictionaries.com';
export const CAMBRIDGE_BASE = 'https://dictionary.cambridge.org';

/** 统一清洗：去零宽字符、折叠空白 */
export function clean(s) {
  return (s || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

export function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

/* ------------------------------------------------------------------ *
 * MW 标记清洗：{bc} {it} {qword} {sx|a|b|} 等
 * ------------------------------------------------------------------ */
export function mwStrip(s) {
  let x = String(s == null ? '' : s);
  x = x.replace(/\{sx\|([^|}]*)\|[^}]*\}/g, '$1');
  x = x.replace(/\{d_link\|([^|}]*)\|[^}]*\}/g, '$1');
  x = x.replace(/\{a_link\|([^|}]*)\}/g, '$1');
  x = x.replace(/\{word\|([^}]*)\}/g, '$1');
  x = x.replace(/\{\/?(it|qword|wi|phrase|ldquo|rdquo|sc|sup|sub)\}/gi, '');
  x = x.replace(/\{bc\}/gi, ' • ');
  x = x.replace(/\{[a-z_]+\|[^}]*\}/gi, ' ');
  x = x.replace(/[{}]/g, ' ');
  return clean(x);
}

/* ------------------------------------------------------------------ *
 * OALD
 * ------------------------------------------------------------------ */
function collectUnboxes($, $scope) {
  const boxes = {};
  $scope.find('.unbox[unbox]').each((i, el) => {
    const $el = $(el);
    const name = $el.attr('unbox');
    if (!name) return;
    if (!boxes[name]) boxes[name] = [];
    boxes[name].push({
      title: clean($el.find('.box_title').text()),
      closed: clean($el.find('.box_title .closed').text()),
      text: clean($el.find('.body').text())
    });
  });
  return boxes;
}

/**
 * OALD 标签。
 * 重要：只在词条自身范围内找 CEFR。页面上另有 .wotd-box 的 .cefr，
 * 那是「Word of the Day」别的词的等级，抓了就等于编造（铁律）。
 */
function parseTags($, $scope) {
  const tags = { cefr: null, oxford3000: false, oxford5000: false, oxfordLevel: null, opal: [] };
  const cefr = clean($scope.find('.cefr').first().text());
  if (cefr && /^[abc][12]$/i.test(cefr)) tags.cefr = cefr.toUpperCase();
  $scope.find('.symbols a[href]').each((i, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const symClass = $a.find('span').attr('class') || '';
    const list = href.match(/list=(ox3000|ox5000)/);
    const lvl = href.match(/level=([a-z0-9]+)/);
    if (list) {
      if (list[1] === 'ox3000') tags.oxford3000 = true;
      if (list[1] === 'ox5000') tags.oxford5000 = true;
      if (lvl) tags.oxfordLevel = lvl[1];
    }
    if (/opal/i.test(href) || /opal_symbol/.test(symClass)) {
      const label = clean($a.text());
      // 形如 OPAL_Written::Sublist_1 → "Sublist 1"，只保留可读部分，避免 frontmatter 里出现冗余串
      const raw = $a.find('span').attr('href') || '';
      const sub = raw.split('::')[1];
      if (label) tags.opal.push(sub ? label + ' (' + sub.replace(/_/g, ' ') + ')' : label);
    }
  });
  tags.opal = uniq(tags.opal);
  return tags;
}

function parsePhonetics($, $scope) {
  const out = { ipa: { uk: null, us: null }, audio: { uk: null, us: null } };
  const uk = $scope.find('.phons_br').first();
  const us = $scope.find('.phons_n_am').first();
  if (uk.length) {
    out.ipa.uk = clean(uk.find('.phon').first().text()) || null;
    const a = uk.find('[data-src-mp3]').first();
    if (a.length) out.audio.uk = a.attr('data-src-mp3') || null;
  }
  if (us.length) {
    out.ipa.us = clean(us.find('.phon').first().text()) || null;
    const a = us.find('[data-src-mp3]').first();
    if (a.length) out.audio.us = a.attr('data-src-mp3') || null;
  }
  if (!out.ipa.uk && !out.ipa.us) {
    out.ipa.uk = clean($scope.find('.phon').first().text()) || null;
  }
  return out;
}

function parseExamples($, $scope) {
  const ex = [];
  $scope.find('ul.examples > li').each((i, el) => {
    const $li = $(el);
    // 折叠区块（Language Bank / Which Word / Word Family）里的例句属于那个区块，
    // 不属于当前义项，否则义项例句会被污染。
    if ($li.closest('.unbox[unbox]').length) return;
    const text = clean($li.find('.x').first().text()) || clean($li.find('.unx').first().text());
    // .cf = 官方给的搭配框架（如 "effect on somebody/something"），是官方数据，别丢
    const frame = clean($li.find('.cf').first().text());
    if (text) ex.push(frame ? { en: text, frame } : { en: text });
  });
  return ex;
}

/** OALD 官方分类搭配（免费片段）：span.unbox(类目) + ul.collocs_list > li */
function parseCollocations($, $scope) {
  const categories = [];
  let seeFullEntry = null;
  $scope.find('.unbox[unbox=snippet]').each((i, el) => {
    const $s = $(el);
    if (!/collocation/i.test(clean($s.find('.box_title').text()))) return;
    let current = null;
    $s.find('.body').children().each((j, ch) => {
      const $ch = $(ch);
      if (ch.tagName === 'span' && $ch.hasClass('unbox')) {
        current = { type: clean($ch.text()), items: [] };
        categories.push(current);
      } else if (ch.tagName === 'ul' && current) {
        $ch.children('li').each((k, li) => {
          const item = clean($(li).text());
          if (item && item !== '…' && item !== '...') current.items.push(item);
        });
      } else if (ch.tagName === 'span' && $ch.hasClass('xref_to_full_entry')) {
        const a = $ch.find('a.Ref').attr('href');
        if (a) seeFullEntry = a;
      }
    });
  });
  const merged = [];
  const idx = {};
  for (const c of categories) {
    if (!c.items.length) continue;
    if (idx[c.type] === undefined) { idx[c.type] = merged.length; merged.push({ type: c.type, items: c.items.slice() }); }
    else merged[idx[c.type]].items = uniq(merged[idx[c.type]].items.concat(c.items));
  }
  return { categories: merged, seeFullEntry, missing: merged.length === 0 };
}

export function parseOaldEntry($, entryEl) {
  const $e = $(entryEl);
  const $web = $e.find('> .top-container .webtop').first();
  const pos = clean($web.find('> span.pos').first().text()) || null;
  const headword = clean($web.find('h1.headword').first().text()) || null;
  const phon = parsePhonetics($, $web);
  const tags = parseTags($, $web);

  let $senses = $e.children('ol.senses_multiple, ol.senses, ol.sense_single').children('li.sense');
  if (!$senses.length) $senses = $e.find('ol.senses_multiple > li.sense, ol.senses > li.sense, ol.sense_single > li.sense');
  if (!$senses.length) $senses = $e.find('li.sense');

  const senses = [];
  $senses.each((i, el) => {
    const $s = $(el);
    const def = clean($s.find('> span.def').first().text()) || clean($s.find('span.def').first().text());
    if (!def) return;
    senses.push({
      pos,
      grammar: clean($s.find('> span.grammar').first().text()) || null,
      labels: clean($s.find('> .labels').first().text()) || clean($s.find('.labels').first().text()) || null,
      def,
      examples: parseExamples($, $s)
    });
  });

  const boxes = collectUnboxes($, $e);
  const idioms = [];
  $e.find('.idioms .idm-g').each((i, el) => {
    const $g = $(el);
    const idm = clean($g.find('.idm').first().text());
    if (idm) idioms.push({ idiom: idm, examples: parseExamples($, $g) });
  });

  const xrefs = [];
  $e.find('.xrefs[xt]').each((i, el) => {
    const $x = $(el);
    xrefs.push({
      type: $x.attr('xt'),
      prefix: clean($x.find('.prefix').first().text()),
      words: $x.find('.xh').map((j, w) => clean($(w).text())).get().filter(Boolean)
    });
  });

  return {
    headword,
    pos,
    ipa: phon.ipa,
    audio: phon.audio,
    tags,
    senses,
    collocations: parseCollocations($, $e),
    wordOrigin: clean((boxes.wordorigin && boxes.wordorigin[0].text) || '') || null,
    wordFamily: clean((boxes.wordfamily && boxes.wordfamily[0].text) || '') || null,
    synonymsBlock: boxes.synonyms ? { title: boxes.synonyms[0].title, text: boxes.synonyms[0].text } : null,
    usageNotes: (boxes.which_word || []).map((b) => ({ type: 'which_word', title: b.title, text: b.text })),
    idioms,
    xrefs
  };
}

export function isOaldNotFound(html) {
  const $ = load(html);
  if ($('#entryContent .entry').length) return false;
  if ($('.didyoumean').length) return true;
  const title = clean($('title').text());
  if (/did you spell it correctly|no exact match/i.test(title)) return true;
  // 空响应 / 无词条容器 / 无 headword → 一律视为未收录，绝不当作「有词条但解析为空」
  return $('h1.headword').length === 0;
}

export function parseOald(html) {
  const $ = load(html);
  const entries = [];
  $('#entryContent .entry').each((i, el) => entries.push(parseOaldEntry($, el)));
  if (!entries.length) $('.entry').each((i, el) => entries.push(parseOaldEntry($, el)));
  return { entries, notFound: entries.length === 0 || isOaldNotFound(html) };
}

/** 发现同词其他词性页面 /definition/{dataset}/{word}_{n} */
export function discoverEntryUrls(html, baseUrl) {
  const $ = load(html);
  const m = baseUrl.match(/\/definition\/(english|american_english|academic)\/([^_/]+)(?:_(\d+))?/);
  if (!m) return [baseUrl];
  const dataset = m[1];
  const word = m[2];
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('/definition/' + dataset + '/' + esc + '_(\\d+)(?:[#?]|$)');
  const urls = {};
  urls[baseUrl.split('#')[0]] = 1;
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (re.test(href)) urls[href.split('#')[0]] = 1;
  });
  return Object.keys(urls).sort((a, b) => {
    const na = Number((a.match(/_(\d+)$/) || [])[1] || 1);
    const nb = Number((b.match(/_(\d+)$/) || [])[1] || 1);
    return na - nb;
  });
}

/** OALD 拼写建议：.result-list 中的 a.dym-link */
export function parseOaldSuggestions(html) {
  const $ = load(html);
  const out = [];
  $('.result-list a.dym-link, .didyoumean a.dym-link').each((i, el) => {
    const t = clean($(el).text());
    if (t) out.push(t);
  });
  if (!out.length) {
    $('a[href*="/search/english/"]').each((i, el) => {
      const t = clean($(el).text());
      if (t && /^[a-zA-Z][a-zA-Z'’-]*$/.test(t)) out.push(t);
    });
  }
  return uniq(out).slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * 剑桥（回退源）
 * ------------------------------------------------------------------ */
export function parseCambridge(html) {
  const $ = load(html);
  const raw = [];
  $('.entry-body__el').each((i, el) => {
    const $e = $(el);
    const pos = clean($e.find('.pos.dpos').first().text()) || clean($e.find('.pos').first().text()) || null;
    // 剑桥 DOM：div.pos-header > span.uk.dpron-i > span.pron.dpron > span.ipa
    const ipa = {
      uk: clean($e.find('.pos-header .uk .ipa').first().text()) || clean($e.find('span.uk .ipa').first().text()) || null,
      us: clean($e.find('.pos-header .us .ipa').first().text()) || clean($e.find('span.us .ipa').first().text()) || null
    };
    const senses = [];
    $e.find('.def-block').each((j, db) => {
      const $db = $(db);
      const def = clean($db.find('.def.ddef_d').first().text()) || clean($db.find('.def').first().text());
      if (!def) return;
      const examples = [];
      $db.find('.eg.deg').each((k, eg) => {
        const t = clean($(eg).text());
        if (t) examples.push({ en: t });
      });
      senses.push({ pos, def, level: clean($db.find('.epp-xref').first().text()) || null, examples });
    });
    if (!senses.length) {
      const def = clean($e.find('.def.ddef_d').first().text()) || clean($e.find('.def').first().text());
      if (def) senses.push({ pos, def, level: null, examples: parseExamples($, $e) });
    }
    if (senses.length || pos) raw.push({ pos, ipa, senses });
  });
  // 剑桥页面会重复同一词性块（多词典），保留最完整的一份
  const byPos = {};
  for (const e of raw) {
    const key = (e.pos || '_').toLowerCase();
    if (!byPos[key] || e.senses.length > byPos[key].senses.length) byPos[key] = e;
  }
  const entries = Object.keys(byPos).map((k) => byPos[k]);
  return { entries, notFound: entries.length === 0, duplicatesRemoved: raw.length - entries.length };
}

/* ------------------------------------------------------------------ *
 * Merriam-Webster
 * ------------------------------------------------------------------ */
export function isMwSuggestion(payload) {
  return Array.isArray(payload) && payload.length > 0 && payload.every((x) => typeof x === 'string');
}

function mwVisFromDefs(defs) {
  const out = [];
  for (const d of defs || []) {
    for (const seq of (d && d.sseq) || []) {
      for (const pair of seq || []) {
        const sense = pair && pair[1];
        if (!sense || !Array.isArray(sense.dt)) continue;
        for (const item of sense.dt) {
          if (Array.isArray(item) && item[0] === 'vis' && Array.isArray(item[1])) {
            for (const v of item[1]) if (v && v.t) out.push({ en: mwStrip(v.t), source: 'mw' });
          }
        }
      }
    }
  }
  return out;
}

export function parseMWCollegiate(payload) {
  const out = { etymology: null, shortdefs: [], pos: [], examples: [], pronunciation: null, suggestions: [] };
  if (isMwSuggestion(payload)) { out.suggestions = payload.slice(0, 12); return out; }
  if (!Array.isArray(payload)) return out;
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    if (!out.etymology && entry.et) {
      const t = mwStrip(Array.isArray(entry.et) ? entry.et.map((p) => (Array.isArray(p) ? p[1] : p)).join('') : entry.et);
      if (t) out.etymology = t;
    }
    if (entry.fl) out.pos.push(clean(entry.fl));
    if (Array.isArray(entry.shortdef)) out.shortdefs.push.apply(out.shortdefs, entry.shortdef.map(clean));
    if (!out.pronunciation && entry.hwi && Array.isArray(entry.hwi.prs)) {
      const p = entry.hwi.prs.map((x) => clean((x && (x.mw || x.ipa)) || '')).filter(Boolean);
      if (p.length) out.pronunciation = p.join(', ');
    }
    if (Array.isArray(entry.quotes)) {
      for (const q of entry.quotes) if (q && q.t) out.examples.push({ en: mwStrip(q.t), source: 'mw' });
    }
    out.examples.push.apply(out.examples, mwVisFromDefs(entry.def));
  }
  out.shortdefs = uniq(out.shortdefs);
  out.pos = uniq(out.pos);
  out.examples = out.examples.slice(0, 12);
  return out;
}

export function parseMWThesaurus(payload) {
  const out = { synonyms: [], antonyms: [], examples: [], suggestions: [] };
  if (isMwSuggestion(payload)) { out.suggestions = payload.slice(0, 12); return out; }
  if (!Array.isArray(payload)) return out;
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const meta = entry.meta || {};
    if (Array.isArray(meta.syns)) for (const grp of meta.syns) if (Array.isArray(grp)) out.synonyms.push.apply(out.synonyms, grp.map(clean));
    if (Array.isArray(meta.ants)) for (const grp of meta.ants) if (Array.isArray(grp)) out.antonyms.push.apply(out.antonyms, grp.map(clean));
    if (Array.isArray(entry.def)) {
      for (const d of entry.def) {
        for (const seq of (d && d.sseq) || []) {
          for (const pair of seq || []) {
            const sense = pair && pair[1];
            if (!sense) continue;
            if (Array.isArray(sense.syn_list)) {
              for (const grp of sense.syn_list) if (Array.isArray(grp)) for (const w of grp) if (w && w.wd) out.synonyms.push(clean(w.wd));
            }
            if (Array.isArray(sense.ant_list)) {
              for (const grp of sense.ant_list) if (Array.isArray(grp)) for (const w of grp) if (w && w.wd) out.antonyms.push(clean(w.wd));
            }
            if (Array.isArray(sense.dt)) {
              for (const item of sense.dt) {
                if (Array.isArray(item) && item[0] === 'vis' && Array.isArray(item[1])) {
                  for (const v of item[1]) if (v && v.t) out.examples.push({ en: mwStrip(v.t), source: 'mw' });
                }
              }
            }
          }
        }
      }
    }
  }
  out.synonyms = uniq(out.synonyms);
  out.antonyms = uniq(out.antonyms);
  out.examples = out.examples.slice(0, 12);
  return out;
}
