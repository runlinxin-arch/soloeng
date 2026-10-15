/**
 * 零依赖 frontmatter 读写（PRD：只允许 1 个第三方依赖，且仅用于 HTML 解析）。
 * 支持本项目卡片规格用到的 YAML 子集：
 *   - 标量：字符串 / 数字 / 布尔 / null / 带引号字符串
 *   - 行内数组：[a, b]
 *   - 对象数组（srs）：
 *       srs:
 *         - pos: noun
 *           due: 2026-10-18
 */

export function parseScalar(input) {
  const s = String(input == null ? '' : input).trim();
  if (s === '') return null;
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if (a === '"' && b === '"') {
      try { return JSON.parse(s); } catch (e) { return s.slice(1, -1); }
    }
    if (a === "'" && b === "'") return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) return parseFlowArray(s);
  return s;
}

export function parseFlowArray(s) {
  const inner = String(s).slice(1, -1).trim();
  if (!inner) return [];
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => parseScalar(x)).filter((x) => x !== null);
}

const indentOf = (l) => (l.match(/^ */) || [''])[0].length;
const isBlank = (l) => !l.trim() || l.trim().startsWith('#');

function parseList(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (isBlank(raw)) { i++; continue; }
    const cur = indentOf(raw);
    if (cur < indent) break;
    if (cur > indent) { i++; continue; }
    const line = raw.slice(indent);
    if (!line.startsWith('- ')) break;
    const itemText = line.slice(2).trim();
    const m = itemText.match(/^([^:]+):(.*)$/);
    if (m) {
      const obj = {};
      obj[m[1].trim()] = parseScalar(m[2]);
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) { i++; continue; }
        const ci = indentOf(l);
        if (ci <= indent) break;
        const t = l.trim();
        if (t.startsWith('- ')) break;
        const mm = t.match(/^([^:]+):(.*)$/);
        if (mm) obj[mm[1].trim()] = parseScalar(mm[2]);
        i++;
      }
      items.push(obj);
    } else {
      items.push(parseScalar(itemText));
      i++;
    }
  }
  return { items, next: i };
}

function parseBlock(lines, start, indent, out) {
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (isBlank(raw)) { i++; continue; }
    const cur = indentOf(raw);
    if (cur < indent) break;
    if (cur > indent) { i++; continue; }
    const line = raw.slice(indent);
    if (line.startsWith('- ')) break;
    const m = line.match(/^([^:]+):(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1].trim();
    const rest = m[2].trim();
    if (rest !== '') { out[key] = parseScalar(rest); i++; continue; }
    let j = i + 1;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j >= lines.length) { out[key] = null; i = j; continue; }
    const childIndent = indentOf(lines[j]);
    if (childIndent <= indent) { out[key] = null; i = j; continue; }
    if (lines[j].slice(childIndent).startsWith('- ')) {
      const r = parseList(lines, j, childIndent);
      out[key] = r.items;
      i = r.next;
    } else {
      const obj = {};
      i = parseBlock(lines, j, childIndent, obj);
      out[key] = Object.keys(obj).length ? obj : null;
    }
  }
  return i;
}

export function parseYaml(text) {
  const out = {};
  parseBlock(String(text || '').split(/\r?\n/), 0, 0, out);
  return out;
}

export function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: src, hasFrontmatter: false };
  return { data: parseYaml(m[1]), body: src.slice(m[0].length), hasFrontmatter: true };
}

export function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/^\s|\s$/.test(s)) return JSON.stringify(s);
  if (/[,:\[\]{}#]/.test(s)) return JSON.stringify(s);
  return s;
}

export function stringifyYamlValue(key, v, lines) {
  if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') {
    lines.push(key + ':');
    for (const item of v) {
      const entries = Object.entries(item);
      entries.forEach((kv, idx) => {
        lines.push((idx === 0 ? '  - ' : '    ') + kv[0] + ': ' + formatScalar(kv[1]));
      });
    }
  } else if (Array.isArray(v)) {
    lines.push(key + ': [' + v.map(formatScalar).join(', ') + ']');
  } else {
    lines.push(key + ': ' + formatScalar(v));
  }
}

export function stringifyFrontmatter(data, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data || {})) stringifyYamlValue(k, v, lines);
  lines.push('---');
  const head = lines.join('\n') + '\n';
  return head + (body == null ? '' : String(body));
}
