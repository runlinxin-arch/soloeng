import { load } from 'cheerio';
import { mkdir, writeFile } from 'node:fs/promises';
import { fetchText } from '../lib/fetcher.js';

const URLS = {
  oald: 'https://www.oxfordlearnersdictionaries.com/definition/english/effect_1',
  cambridge: 'https://dictionary.cambridge.org/dictionary/english/effect',
  coll: 'https://www.oxfordlearnersdictionaries.com/definition/collocations/effect_1'
};

const target = process.argv[2] || 'oald';
const url = URLS[target];
const r = await fetchText(url);
console.log('[' + target + '] status=' + r.status + ' ms=' + r.ms + ' bytes=' + r.body.length);
await mkdir('fixtures/html', { recursive: true });
await writeFile('fixtures/html/' + target + '.html', r.body);
const $ = load(r.body);

if (target === 'oald') {
  console.log('\n--- phonetics ---');
  console.log('phons_br  :', $('.phons_br .phon').map((i, e) => $(e).text()).get());
  console.log('phons_n_am:', $('.phons_n_am .phon').map((i, e) => $(e).text()).get());
  console.log('audio:', $('[data-src-mp3]').map((i, e) => $(e).attr('data-src-mp3')).get().slice(0, 4));
  console.log('\n--- senses: li.sense count =', $('li.sense').length, '| .def count =', $('.def').length);
  $('li.sense').slice(0, 3).each((i, el) => {
    const s = $(el);
    console.log('  sense#' + i,
      '| pos=', JSON.stringify(s.find('.pos').first().text()),
      '| def=', JSON.stringify(s.find('.def').first().text().slice(0, 70)),
      '| examples=', s.find('ul.examples li .x').length,
      '| labels=', JSON.stringify(s.find('.labels').first().text()),
      '| cefr=', JSON.stringify(s.find('.cefr').first().text()));
  });
  console.log('\n--- unbox sections (.unbox[unbox]) ---');
  $('.unbox[unbox]').each((i, el) => {
    console.log('  ', $(el).attr('unbox'), '| title=', JSON.stringify($(el).find('.box_title').text()),
      '| bodyLen=', $(el).find('.body').text().length);
  });
  console.log('\n--- xrefs ---');
  $('.xrefs[xt]').slice(0, 6).each((i, el) => {
    console.log('  xt=' + $(el).attr('xt'), '=>', $(el).find('.xh').map((j, x) => $(x).text()).get().join(', '));
  });
  console.log('\n--- tag symbols ---');
  console.log('  cefr:', $('.cefr').map((i, e) => $(e).text()).get().slice(0, 3));
  console.log('  opal_symbol:', $('.opal_symbol').length, '| symbols:', $('.symbols').length);
}

if (target === 'cambridge') {
  console.log('\n--- cambridge entry body ---');
  console.log('pos-header count:', $('.pos-header').length, '| .def count:', $('.def').length);
  $('.entry-body__el').slice(0, 2).each((i, el) => {
    const s = $(el);
    console.log('  block#' + i, '| pos=', JSON.stringify(s.find('.pos').first().text()),
      '| ipa=', JSON.stringify(s.find('.ipa').first().text()),
      '| defs=', s.find('.def').length, '| examples=', s.find('.eg').length);
  });
  console.log('  ipa samples:', $('.ipa').map((i, e) => $(e).text()).get().slice(0, 4));
  console.log('  region:', $('.region').map((i, e) => $(e).text()).get().slice(0, 4));
}

if (target === 'coll') {
  console.log('\n--- collocations page: hunting the content ---');
  const classes = {};
  $('[class]').each((i, el) => {
    const c = $(el).attr('class') || '';
    for (const k of c.split(/\s+/)) if (k) classes[k] = (classes[k] || 0) + 1;
  });
  const hit = Object.keys(classes).filter((k) => /colloc|entry|content|body|main|wotd|list|listitem|block|box/i.test(k));
  console.log('candidate classes:', hit.sort().map((k) => k + '(' + classes[k] + ')').join(', '));
  console.log('\n--- #main_content / .entry text length:', $('#main_content').text().length);
  const bodyText = ($('#main_content').text() || '').replace(/\s+/g, ' ').trim();
  console.log('main_content text (1200):', bodyText.slice(0, 1200));
  console.log('\n--- script tags with json/initial state ---');
  console.log('scripts:', $('script').length, '| #__NEXT_DATA__:', $('#__NEXT_DATA__').length, '| window.* :', $('script:contains("collocation")').length);
}

console.log('\nTOTAL .def in page:', $('.def').length);
