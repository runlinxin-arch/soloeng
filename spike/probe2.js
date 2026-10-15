import { load } from 'cheerio';
import { readFile } from 'node:fs/promises';

const $ = load(await readFile('fixtures/html/oald.html', 'utf8'));

console.log('=== entries (one per POS?) ===');
console.log('count:', $('#entryContent .entry').length);
$('#entryContent .entry').each((i, el) => {
  const s = $(el);
  console.log('  #' + s.attr('id'),
    '| hw=' + JSON.stringify(s.find('h1.headword').first().text()),
    '| pos=' + JSON.stringify(s.find('> .top-container .webtop > span.pos').first().text()),
    '| senses=' + s.find('li.sense').length);
});

console.log('\n=== .symbols blocks (CEFR/OPAL/3000 tags) ===');
$('.symbols').slice(0, 6).each((i, el) => {
  const s = $(el);
  console.log('  [' + i + '] text=' + JSON.stringify(s.text().replace(/\s+/g, ' ').trim().slice(0, 40)));
  console.log('       html=' + s.html().replace(/\s+/g, ' ').slice(0, 220));
});

console.log('\n=== unbox ownership (which entry / where) ===');
$('.unbox[unbox]').each((i, el) => {
  const s = $(el);
  const entry = s.closest('.entry');
  console.log('  ' + (s.attr('unbox') || '').padEnd(16),
    'entry=' + (entry.attr('id') || 'NONE'),
    'title=' + JSON.stringify(s.find('.box_title').text()),
    'bodyLen=' + s.find('.body').text().length);
});

console.log('\n=== grammar / labels on first 3 senses ===');
$('li.sense').slice(0, 3).each((i, el) => {
  const s = $(el);
  console.log('  #' + i, 'grammar=' + JSON.stringify(s.find('> .sensetop ~ span.grammar, > span.grammar').first().text()),
    'labels=' + JSON.stringify(s.find('.labels').first().text()),
    'def=' + JSON.stringify(s.find('span.def').first().text().slice(0, 50)));
});

console.log('\n=== examples shape (first sense) ===');
$('li.sense').first().find('ul.examples > li').slice(0, 3).each((i, el) => {
  const s = $(el);
  console.log('  ex#' + i, 'x=' + JSON.stringify(s.find('.x').text().slice(0, 70)), '| unx=' + JSON.stringify(s.find('.unx').text().slice(0, 40)));
});
