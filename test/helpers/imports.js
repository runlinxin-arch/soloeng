import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 找出「只在 import 语句里出现过」的绑定，也就是未使用的 import。
 *
 * 这是**保守**检测：标识符只要在文件其它地方出现过（哪怕只是在注释或字符串里），
 * 就判定为已使用。所以它不会误报（不会把在用的 import 说成未使用），
 * 但可能漏报少数藏在注释里的名字 —— 对一道防堆积的守卫来说，这个取舍是合适的。
 */

const SKIP_DIRS = new Set(['node_modules', 'data', '.git']);

/** 从一个 import 的说明符里取出绑定的本地名字 */
export function bindingsOf(spec) {
  const names = [];
  const s = String(spec).trim();
  const pushNamed = (inner) => {
    for (const part of inner.split(',')) {
      if (!part.trim()) continue;
      const as = part.split(/\s+as\s+/);
      names.push(as[as.length - 1].trim());
    }
  };
  if (s.startsWith('{')) {
    pushNamed(s.slice(1, s.lastIndexOf('}')));
  } else if (s.startsWith('*')) {
    const m = s.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (m) names.push(m[1]);
  } else if (s.includes('{')) {
    const def = s.slice(0, s.indexOf('{')).replace(/,\s*$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(def)) names.push(def);
    pushNamed(s.slice(s.indexOf('{') + 1, s.lastIndexOf('}')));
  } else if (/^[A-Za-z_$][\w$]*$/.test(s)) {
    names.push(s);
  }
  return names.filter(Boolean);
}

/** 扫描单个文件的源码，返回未使用的绑定名 */
export function unusedImportsInSource(src) {
  const re = /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g;
  const unused = [];
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec || spec.trim().startsWith('(')) continue;   // 动态 import
    const rest = src.slice(0, m.index) + src.slice(m.index + m[0].length);
    for (const name of bindingsOf(spec)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (!new RegExp('\\b' + name + '\\b').test(rest)) unused.push(name);
    }
  }
  return unused;
}

/** 递归扫描一个目录，返回 [{ file, name }] */
export function findUnusedImports(root) {
  const found = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      let src;
      try { src = readFileSync(p, 'utf8'); } catch (err) { continue; }
      for (const name of unusedImportsInSource(src)) found.push({ file: p, name });
    }
  })(root);
  return found;
}
