/**
 * 前端纯函数层：可被浏览器与 node 测试共用（无 DOM 依赖）。
 */

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 行内标记：**粗**、*斜*、\`code\`、[[双链]] */
export function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/\[\[([^\]]+)\]\]/g, '<a class="wikilink" data-wikilink="$1">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  return s;
}

function isTableSep(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * 极简 Markdown → HTML，覆盖卡片实际用到的语法。
 * 全部先转义再拼标签，避免 XSS。
 */
export function renderMarkdown(md) {
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  const out = [];
  let i = 0;
  let list = null;

  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { closeList(); i++; continue; }

    if (/^#{1,6}\s/.test(t)) {
      closeList();
      const level = t.match(/^#+/)[0].length;
      if (level === 1) { i++; continue; } // 一级标题由词头负责
      out.push('<h' + level + '>' + renderInline(t.replace(/^#+\s*/, '')) + '</h' + level + '>');
      i++; continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); out.push('<hr>'); i++; continue; }

    if (t.startsWith('> ')) {
      closeList();
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('> ') || (i < lines.length && lines[i].trim() === '>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + buf.map((b) => renderInline(b)).join('<br>') + '</blockquote>');
      continue;
    }

    if (t.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = splitRow(t);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      let html = '<table><thead><tr>' + head.map((h) => '<th>' + renderInline(h) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows) html += '<tr>' + r.map((c) => '<td>' + renderInline(c) + '</td>').join('') + '</tr>';
      out.push(html + '</tbody></table>');
      continue;
    }

    if (/^[-*]\s/.test(t)) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + renderInline(t.replace(/^[-*]\s/, '')) + '</li>');
      i++; continue;
    }
    if (/^\d+\.\s/.test(t)) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + renderInline(t.replace(/^\d+\.\s/, '')) + '</li>');
      i++; continue;
    }

    closeList();
    const buf = [t];
    i++;
    while (i < lines.length) {
      const nxt = lines[i].trim();
      if (!nxt || /^#{1,6}\s/.test(nxt) || nxt.startsWith('> ') || /^[-*]\s/.test(nxt) || /^\d+\.\s/.test(nxt) || nxt.startsWith('|') || /^(-{3,})$/.test(nxt)) break;
      buf.push(nxt); i++;
    }
    out.push('<p>' + buf.map((b) => renderInline(b)).join('<br>') + '</p>');
  }
  closeList();
  return out.join('\n');
}

/** 按二级标题切分正文（保留标题与内容） */
export function splitSections(md) {
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^##\s+/.test(line.trim())) {
      if (cur) sections.push(cur);
      cur = { heading: line.trim().replace(/^##\s*/, ''), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      if (!sections.length) sections.push({ heading: null, body: [] });
      sections[sections.length - 1].body.push(line);
    }
  }
  if (cur) sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

/** 复习背面默认折叠的词级内容（PRD §2.3：辨析/词源/词族一律折叠） */
export const REVIEW_FOLDED = ['延伸义与词族', '易混词辨析', '词源与构词'];

/** 词性全名 → 正文里的行内标记（LLM 用缩写标注词性） */
export const POS_LABEL = {
  noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.',
  preposition: 'prep.', conjunction: 'conj.', pronoun: 'pron.',
  determiner: 'det.', interjection: 'interj.', numeral: 'num.'
};

/**
 * 把一个区块的正文按**行内的词性标记**切块。
 *
 * 正文由 LLM 生成，词性不是标题而是行内标注（`**n.** …` / `**v.** …`），
 * 所以这里按空行切段，再看每段开头有没有词性标记：
 *   - 有标记 → 开新块
 *   - 标题行（# 开头）→ 自成一块（否则会被并进上一个词性的块里）
 *   - 其它段落 → 跟随上一块（LLM 常把同一词性的续写单独成段）
 */
export function groupByPos(text) {
  const groups = [];
  let pending = [];   // 攒着的标题行：它属于紧随其后的那块内容，不能自成一块

  const flushTo = (group) => {
    if (!pending.length) return;
    group.text = pending.join('\n\n') + '\n\n' + group.text;
    pending = [];
  };

  for (const raw of String(text == null ? '' : text).split(/\n\s*\n/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/^\*\*\s*([A-Za-z]+)\.\s*(?:（[^）]*）)?\s*\*\*/);
    const label = m ? m[1].toLowerCase() + '.' : null;

    if (label) {
      const g = { label, text: t };
      flushTo(g);
      groups.push(g);
    } else if (/^#{1,6}\s/.test(t)) {
      // 例如「### 熟词僻义」—— 它的内容是后面那些块，所以先攒着。
      // 早先把它当独立块，结果复习动词时正文里会留下一个**空标题**。
      pending.push(t);
    } else if (groups.length) {
      flushTo(groups[groups.length - 1]);
      groups[groups.length - 1].text += '\n\n' + t;
    } else {
      groups.push({ label: null, text: t });
    }
  }
  if (pending.length) groups.push({ label: null, text: pending.join('\n\n') });
  return groups;
}

/**
 * 复习背面渲染（PRD §2.3）：
 *   - 只展示**当前词性**的释义；其他词性的内容折叠成一行「该词还有其他词性：v.」，点开可看
 *   - 词级内容（辨析 / 词源 / 词族）一律折叠
 *
 * 传了 opts.pos 才做词性切分；没传就退回「按区块折叠 + 一行提示」的旧行为，
 * 这样调用方可以渐进接入，已有测试与用法也不会被打断。
 */
export function renderReviewBack(md, opts) {
  const o = opts || {};
  const folded = o.folded || REVIEW_FOLDED;
  const wantLabel = o.pos ? (POS_LABEL[o.pos] || null) : null;
  const sections = splitSections(md);
  const out = [];
  const otherChunks = [];
  const otherLabels = [];

  for (const s of sections) {
    if (!s.heading) {
      if (s.body) out.push(renderMarkdown(s.body));
      continue;
    }
    let body = s.body;
    let skipped = false;
    if (wantLabel) {
      const groups = groupByPos(body);
      if (groups.some((g) => g.label)) {
        const mine = groups.filter((g) => !g.label || g.label === wantLabel);
        const other = groups.filter((g) => g.label && g.label !== wantLabel);
        for (const g of other) if (otherLabels.indexOf(g.label) < 0) otherLabels.push(g.label);
        body = mine.map((g) => g.text).join('\n\n');
        if (other.length) {
          otherChunks.push('<h3>' + escapeHtml(s.heading) + '</h3>' + renderMarkdown(other.map((g) => g.text).join('\n\n')));
        }
        // 整个区块都属于别的词性（例如复习动词时的「熟词僻义」）→ 不在这里渲染
        if (!body.trim()) skipped = true;
      }
    }
    if (!skipped) {
      const html = renderMarkdown(body);
      if (folded.indexOf(s.heading) >= 0) {
        out.push('<details><summary>' + escapeHtml(s.heading) + '</summary>' + html + '</details>');
      } else {
        out.push('<h2>' + escapeHtml(s.heading) + '</h2>' + html);
      }
    }
  }

  if (wantLabel && otherChunks.length) {
    const names = (o.otherPos && o.otherPos.length)
      ? o.otherPos.map((p) => POS_LABEL[p] || p)
      : otherLabels;
    out.push('<details class="other-pos"><summary>该词还有其他词性：' + escapeHtml(names.join('、')) +
      '（不影响本次评分）</summary>' + otherChunks.join('') + '</details>');
  } else if (o.otherPos && o.otherPos.length) {
    out.push('<div class="notice">该词还有其他词性：' + escapeHtml(o.otherPos.join('、')) + '（不影响本次评分）</div>');
  }
  return out.join('\n');
}

const TAG_CLASS = { '学术词': 'opal', 'OPAL W': 'opal', 'OPAL S': 'opal' };

/** 词头区域 */
export function renderHead(h) {
  const tags = h.tags || {};
  const chips = [];
  for (const p of (h.pos || [])) chips.push('<span class="pill pill-pos">' + escapeHtml(p) + '</span>');
  if (tags.cefr) chips.push('<span class="pill pill-cefr">CEFR ' + escapeHtml(tags.cefr) + '</span>');
  if (tags.oxford3000) chips.push('<span class="pill pill-ox">牛津3000' + (tags.oxfordLevel ? ' ' + escapeHtml(String(tags.oxfordLevel).toUpperCase()) : '') + '</span>');
  if (tags.oxford5000) chips.push('<span class="pill pill-ox">牛津5000</span>');
  for (const o of (tags.opal || [])) chips.push('<span class="pill ' + (TAG_CLASS[o] || 'opal') + '">' + escapeHtml(o) + '</span>');

  const audio = (url, label) => url
    ? '<button class="audio" data-audio="' + escapeHtml(url) + '" title="朗读">' + label + '</button>'
    : '';

  const ipa = (val, label) => val
    ? '<span class="ipa"><span class="ipa-label">' + label + '</span>' + escapeHtml(val) + '</span>'
    : '';

  return '' +
    '<div class="head-word">' + escapeHtml(h.word) + '</div>' +
    '<div class="head-meta">' +
      ipa(h.ipa_uk, '英') + audio(h.audio_uk, '🔊英') +
      ipa(h.ipa_us, '美') + audio(h.audio_us, '🔊美') +
    '</div>' +
    '<div class="head-tags">' + chips.join('') + '</div>' +
    '<div class="head-actions">' +
      (h.obsidianUrl ? '<a class="btn-pill" href="' + escapeHtml(h.obsidianUrl) + '">在 Obsidian 打开</a>' : '') +
    '</div>';
}

/** 状态条 */
export function renderStatusBar(s) {
  return '<span class="stat">今日待复习 <b>' + (s.dueToday || 0) + '</b></span>' +
    '<span class="dot">·</span>' +
    '<span class="stat">总词数 <b>' + (s.total || 0) + '</b></span>' +
    '<span class="spacer"></span>' +
    '<button class="btn-pill" data-menu="settings">设置</button>';
}

/** 最近词列表 */
export function renderRecent(words) {
  if (!words || !words.length) return '';
  return '<div class="recent">最近查过：' + words.map((w) =>
    '<button class="link recent-word" data-word="' + escapeHtml(w) + '">' + escapeHtml(w) + '</button>'
  ).join('<span class="dot">·</span>') + '</div>';
}

/** 增量 SSE 解析器（服务端与浏览器行为必须一致） */
export function createSseParser(onEvent) {
  let buf = '';
  function handleLine(line) {
    if (!line || line.startsWith(':')) return;
    const m = line.match(/^event:\s*(.*)$/);
    if (m) { buf_event = m[1].trim(); return; }
    const d = line.match(/^data:\s*(.*)$/);
    if (d) {
      let payload = {};
      try { payload = JSON.parse(d[1]); } catch (e) { payload = {}; }
      if (onEvent) onEvent(buf_event || 'message', payload);
    }
  }
  let buf_event = '';
  return {
    feed(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    },
    flush() {
      if (buf.trim()) { handleLine(buf.replace(/\r$/, '')); buf = ''; }
    }
  };
}
