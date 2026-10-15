import { load } from 'cheerio';

function outline($, el, depth, maxDepth, out, budget) {
  if (depth > maxDepth || out.length > budget) return;
  const $el = $(el);
  const tag = el.tagName;
  if (!tag || tag === 'script' || tag === 'style') return;
  const cls = ($el.attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
  const id = $el.attr('id') || '';
  const own = $el.clone().children().remove().end().text().replace(/\s+/g, ' ').trim().slice(0, 55);
  out.push('  '.repeat(depth) + tag + (id ? '#' + id : '') + (cls ? '.' + cls : '') + (own ? '  "' + own + '"' : ''));
  $el.children().each((i, c) => outline($, c, depth + 1, maxDepth, out, budget));
}

const target = process.argv[2] || 'oald';
const sel = process.argv[3] || '#entryContent';
const maxDepth = Number(process.argv[4] || 5);
const fs = await import('node:fs/promises');
const html = await fs.readFile('fixtures/html/' + target + '.html', 'utf8');
const $ = load(html);

console.log('### ' + target + ' :: ' + sel + '  (matches=' + $(sel).length + ')');
const out = [];
outline($, $(sel).get(0), 0, maxDepth, out, 120);
console.log(out.join('\n'));
