import { uniq, clean } from './parser.js';

/**
 * 多源合并 → NormalizedWord（开发计划 §4.3）。
 * 铁律：每个字段要么有官方值，要么进 missing；下游不得为 missing 字段产出内容。
 */
export function normalize(input) {
  const {
    word, oaldEntries = [], camEntries = [],
    mwCollegiate = null, mwThesaurus = null, sources = {}
  } = input || {};

  const out = {
    word: word || null,
    ipa: { uk: null, us: null, source: null },
    audio: { uk: null, us: null },
    pos: [],
    tags: { cefr: null, oxford3000: false, oxford5000: false, oxfordLevel: null, opal: [] },
    senses: [],
    collocations: { categories: [], seeFullEntry: null },
    relations: { synonyms: [], antonyms: [], wordFamily: null, synonymsBlock: null },
    wordOrigin: null,
    usageNotes: [],
    idioms: [],
    sources,
    missing: []
  };

  for (const e of oaldEntries) {
    if (!e) continue;
    if (e.pos) out.pos.push(e.pos);
    if (!out.ipa.uk && e.ipa && e.ipa.uk) { out.ipa.uk = e.ipa.uk; out.ipa.source = 'oald'; }
    if (!out.ipa.us && e.ipa && e.ipa.us) out.ipa.us = e.ipa.us;
    if (!out.audio.uk && e.audio && e.audio.uk) out.audio.uk = e.audio.uk;
    if (!out.audio.us && e.audio && e.audio.us) out.audio.us = e.audio.us;
    const t = e.tags || {};
    if (!out.tags.cefr && t.cefr) out.tags.cefr = t.cefr;
    out.tags.oxford3000 = out.tags.oxford3000 || Boolean(t.oxford3000);
    out.tags.oxford5000 = out.tags.oxford5000 || Boolean(t.oxford5000);
    if (!out.tags.oxfordLevel && t.oxfordLevel) out.tags.oxfordLevel = t.oxfordLevel;
    out.tags.opal = uniq(out.tags.opal.concat(t.opal || []));
    for (const s of e.senses || []) out.senses.push(s);
    const c = e.collocations;
    if (c && c.categories && c.categories.length) {
      for (const cat of c.categories) {
        const found = out.collocations.categories.find((x) => x.type === cat.type);
        if (found) found.items = uniq(found.items.concat(cat.items));
        else out.collocations.categories.push({ type: cat.type, items: cat.items.slice() });
      }
      if (!out.collocations.seeFullEntry && c.seeFullEntry) out.collocations.seeFullEntry = c.seeFullEntry;
    }
    if (!out.wordOrigin && e.wordOrigin) out.wordOrigin = e.wordOrigin;
    if (e.wordFamily && !out.relations.wordFamily) out.relations.wordFamily = e.wordFamily;
    if (e.synonymsBlock && !out.relations.synonymsBlock) out.relations.synonymsBlock = e.synonymsBlock;
    for (const n of e.usageNotes || []) {
      const key = (n.title || '') + '|' + (n.text || '');
      if (!out.usageNotes.some((x) => ((x.title || '') + '|' + (x.text || '')) === key)) out.usageNotes.push(n);
    }
    for (const i of e.idioms || []) out.idioms.push(i);
  }

  // 剑桥仅补 OALD 缺的，不覆盖
  if (camEntries && camEntries.length) {
    const needIpa = !out.ipa.uk || !out.ipa.us;
    const needSenses = out.senses.length === 0;
    for (const e of camEntries) {
      if (!e) continue;
      if (needIpa) {
        if (!out.ipa.uk && e.ipa && e.ipa.uk) { out.ipa.uk = e.ipa.uk; if (!out.ipa.source) out.ipa.source = 'cambridge'; }
        if (!out.ipa.us && e.ipa && e.ipa.us) { out.ipa.us = e.ipa.us; if (!out.ipa.source) out.ipa.source = 'cambridge'; }
      }
      if (needSenses) {
        for (const s of e.senses || []) out.senses.push(s);
      }
      if (e.pos && !out.pos.includes(e.pos)) out.pos.push(e.pos);
    }
  }

  if (mwCollegiate && !out.wordOrigin && mwCollegiate.etymology) {
    out.wordOrigin = mwCollegiate.etymology;
  }
  if (mwThesaurus) {
    out.relations.synonyms = uniq(out.relations.synonyms.concat(mwThesaurus.synonyms || []));
    out.relations.antonyms = uniq(out.relations.antonyms.concat(mwThesaurus.antonyms || []));
  }

  out.pos = uniq(out.pos);

  if (!out.ipa.uk && !out.ipa.us) out.missing.push('pronunciation');
  if (!out.senses.length) out.missing.push('senses');
  if (!out.collocations.categories.length) out.missing.push('collocations');
  if (!out.wordOrigin) out.missing.push('wordOrigin');
  if (!out.relations.synonyms.length && !out.relations.antonyms.length && !out.relations.wordFamily) {
    out.missing.push('relations');
  }
  if (!out.usageNotes.length) out.missing.push('compareNotes');

  out.found = out.senses.length > 0 || out.pos.length > 0;
  return out;
}
