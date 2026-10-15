import { load } from 'cheerio';
import { readFile, writeFile } from 'node:fs/promises';
import { applyNetworkMode, fetchJson } from '../lib/fetcher.js';
import { getSecrets } from '../lib/secrets.js';

const t = (s) => (s || '').replace(/\s+/g, ' ').trim();

const $ = load(await readFile('fixtures/html/oald.html', 'utf8'));

console.log('##### 1) wotd-box: is B2 effect\'s? #####');
const wotd = $('.wotd-box').first();
console.log('  text:', t(wotd.text()).slice(0, 220));
console.log('  nearest heading:', JSON.stringify(t(wotd.closest('.responsive_entry_center_right').find('h2, .wotd-h').first().text())));
console.log('  parent id/class:', wotd.parent().attr('id') || '', wotd.parent().attr('class') || '');

console.log();
console.log('##### 2) full webtop .symbols html #####');
console.log(t($('#entryContent .webtop .symbols').first().html()));

console.log();
console.log('##### 3) any CEFR badge inside #entryContent #####');
console.log('  #entryContent .cefr count:', $('#entryContent .cefr').length);
console.log('  #entryContent [class*=cefr] count:', $('#entryContent [class*=cefr]').length);
$('#entryContent [class*=cefr]').slice(0, 5).each((i, el) => {
  console.log('   [' + i + '] tag=' + $(el).get(0).tagName + ' class=' + JSON.stringify($(el).attr('class')) + ' text=' + JSON.stringify(t($(el).text())));
});

console.log();
console.log('##### 4) spellcheck .didyoumean markup #####');
const $s = load(await readFile('fixtures/html/spellcheck.html', 'utf8'));
console.log('  count:', $s('.didyoumean').length);
$s('.didyoumean').slice(0, 2).each((i, el) => {
  console.log('  [' + i + '] html:', t($s(el).html()).slice(0, 400));
});
console.log('  .result-list[0] html:', t($s('.result-list').first().html()).slice(0, 300));

console.log();
console.log('##### 5) MW thesaurus raw shape #####');
applyNetworkMode('direct');
const secrets = await getSecrets();
const r = await fetchJson('https://www.dictionaryapi.com/api/v3/references/thesaurus/json/effect?key=' + secrets.values.MW_THESAURUS_KEY);
await writeFile('fixtures/mw-thesaurus-raw.json', JSON.stringify(r.json, null, 2));
const e0 = r.json[0];
console.log('  keys:', Object.keys(e0).join(', '));
console.log('  meta keys:', Object.keys(e0.meta || {}).join(', '));
console.log('  meta.syns[0] (first 6):', JSON.stringify((e0.meta.syns || [])[0] || []).slice(0, 160));
console.log('  meta.ants:', JSON.stringify(e0.meta.ants || []).slice(0, 120));
console.log('  def[0].sseq[0][0] sample:', JSON.stringify((e0.def || [])[0] && e0.def[0].sseq && e0.def[0].sseq[0] && e0.def[0].sseq[0][0]).slice(0, 300));
const vis = [];
for (const d of e0.def || []) for (const seq of d.sseq || []) for (const pair of seq) {
  const sense = pair[1];
  if (sense && sense.vis) for (const v of sense.vis) vis.push(v);
}
console.log('  vis count:', vis.length, JSON.stringify(vis.slice(0, 3)));
