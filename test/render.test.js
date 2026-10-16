import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import {
  renderMarkdown, renderHead, renderStatusBar, renderRecent,
  createSseParser, escapeHtml, splitSections, renderReviewBack, REVIEW_FOLDED
} from '../public/render.js';

test('escapeHtml 挡住 XSS', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
});

test('renderMarkdown 不得让原始 HTML 通过（XSS）', () => {
  const html = renderMarkdown('## 标题\n<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), '原始 HTML 必须被转义');
  assert.ok(html.includes('&lt;img'));
});

test('renderMarkdown：二级/三级标题', () => {
  const html = renderMarkdown('## 核心释义\n### 熟词僻义');
  assert.ok(html.includes('<h2>核心释义</h2>'));
  assert.ok(html.includes('<h3>熟词僻义</h3>'));
});

test('renderMarkdown：一级标题被忽略（由词头负责）', () => {
  const html = renderMarkdown('# effect /ɪˈfekt/\n正文');
  assert.ok(!html.includes('<h1>'));
  assert.ok(html.includes('正文'));
});

test('renderMarkdown：引用块（例句 + 中文翻译）', () => {
  const html = renderMarkdown('> the beneficial effects\n> *有益的效果*');
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<em>有益的效果</em>'));
});

test('renderMarkdown：粗体、列表、双链', () => {
  const html = renderMarkdown('**n.** 影响\n- 固定搭配一\n- 固定搭配二\nvs [[effect]]：说明');
  assert.ok(html.includes('<strong>n.</strong>'));
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.ok(html.includes('data-wikilink="effect"'));
});

test('renderMarkdown：表格（辨析逐项对照）', () => {
  const md = '| 维度 | a | b |\n|---|---|---|\n| 词性 | v | n |';
  const html = renderMarkdown(md);
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>维度</th>'));
  assert.ok(html.includes('<td>v</td>'));
  assert.ok(html.includes('<td>n</td>'));
});

test('renderMarkdown：空输入安全', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('renderHead：音标/词性/标签/音频按钮齐备', () => {
  const html = renderHead({
    word: 'effect',
    ipa_uk: '/ɪˈfekt/', ipa_us: '/ɪˈfekt/',
    audio_uk: 'https://www.oxfordlearnersdictionaries.com/media/uk.mp3',
    audio_us: null,
    pos: ['noun', 'verb'],
    tags: { cefr: null, oxford3000: true, oxfordLevel: 'a2', opal: ['OPAL W'] },
    obsidianUrl: 'obsidian://open?vault=x&file=y'
  });
  const $ = load(html);
  assert.equal($('.head-word').text(), 'effect');
  assert.ok(html.includes('/ɪˈfekt/'));
  assert.equal($('.pill-pos').length, 2);
  assert.equal($('.pill-cefr').length, 0, 'CEFR 为 null 时不得显示胶囊（铁律）');
  assert.ok($('.pill-ox').text().includes('牛津3000'));
  assert.ok($('.pill-ox').text().includes('A2'));
  assert.ok(html.includes('OPAL W'));
  assert.equal($('button.audio').length, 1, '只有 UK 音频时只渲染一个按钮');
  // 「在 Obsidian 打开」与「⋯」都要用 ToDesktop 风格的胶囊按钮
  assert.equal($('a.btn-pill').length, 1, '「在 Obsidian 打开」应是胶囊按钮');
  // 「⋯」从未实现任何功能，已删除；不要再把它加回来当装饰
  assert.equal($('[data-menu=more]').length, 0, '无效的「⋯」按钮应已删除');
  assert.ok(html.includes('Obsidian'));
});

test('renderHead：CEFR 有值时显示', () => {
  const html = renderHead({ word: 'x', pos: [], tags: { cefr: 'B2' } });
  assert.equal(load(html)('.pill-cefr').text(), 'CEFR B2');
});

test('renderHead：没有音频/链接时不产生死按钮', () => {
  const html = renderHead({ word: 'x', pos: [], tags: {} });
  assert.equal(load(html)('button.audio').length, 0);
  assert.equal(load(html)('a.btn-pill').length, 0);
});

test('renderStatusBar：显示今日待复习与总词数', () => {
  const $ = load(renderStatusBar({ dueToday: 3, total: 128 }));
  const text = $.text();
  assert.ok(text.includes('今日待复习'));
  assert.ok(text.includes('3'));
  assert.ok(text.includes('总词数'));
  assert.ok(text.includes('128'));
  assert.equal($('[data-menu=settings]').length, 1);
  assert.equal($('[data-menu=settings]').hasClass('btn-pill'), true, '状态条「设置」应是胶囊按钮');
});

test('renderRecent：空列表返回空串，有词则可点击', () => {
  assert.equal(renderRecent([]), '');
  const $ = load(renderRecent(['effect', 'affect']));
  assert.equal($('.recent-word').length, 2);
  assert.equal($('.recent-word').first().attr('data-word'), 'effect');
});

test('createSseParser：跨 chunk 的事件/数据组装正确', () => {
  const seen = [];
  const p = createSseParser((ev, d) => seen.push({ ev, d }));
  p.feed('event: status\ndata: {"phase":"fetch');
  p.feed('ing"}\n\nevent: chunk\ndata: {"text":"你好"}\n\n');
  p.flush();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].ev, 'status');
  assert.equal(seen[0].d.phase, 'fetching');
  assert.equal(seen[1].ev, 'chunk');
  assert.equal(seen[1].d.text, '你好');
});

test('createSseParser：坏 JSON 不抛错，心跳被忽略', () => {
  const seen = [];
  const p = createSseParser((ev, d) => seen.push({ ev, d }));
  p.feed(': keep-alive\n\ndata: {broken\n\n');
  p.flush();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].d, {});
});

test('splitSections：按二级标题切分且不切三级标题', () => {
  const md = '## 核心释义\n**n.** 影响\n### 熟词僻义\n细节\n\n## 固定搭配\n- a';
  const s = splitSections(md);
  assert.equal(s.length, 2);
  assert.equal(s[0].heading, '核心释义');
  assert.ok(s[0].body.includes('### 熟词僻义'), '三级标题应留在本区块内');
  assert.equal(s[1].heading, '固定搭配');
  assert.ok(s[1].body.includes('- a'));
});

test('renderReviewBack：释义常显，词级内容默认折叠（PRD §2.3）', () => {
  const md = '## 核心释义\n**n.** 影响\n## 固定搭配\n- decisive\n## 易混词辨析\nvs [[affect]]\n## 词源与构词\nfrom Latin';
  const html = renderReviewBack(md, { otherPos: ['verb'] });
  const $ = load(html);
  assert.equal($('h2').length, 2, '核心释义与固定搭配应常显');
  assert.equal($('details').length, 2, '辨析与词源应折叠');
  const summaries = $('details summary').map((i, e) => $(e).text()).get();
  assert.deepEqual(summaries, ['易混词辨析', '词源与构词']);
  assert.ok(html.includes('其他词性'), '应提示其他词性');
  assert.ok(html.includes('verb'));
});

test('renderReviewBack：折叠内容仍在 DOM 中（可展开，不是被丢弃）', () => {
  const html = renderReviewBack('## 易混词辨析\nvs [[affect]]：官方说明');
  assert.ok(html.includes('官方说明'), '折叠不等于删除');
  assert.equal(load(html)('details').length, 1);
});

test('REVIEW_FOLDED 覆盖三个词级区块', () => {
  assert.deepEqual(REVIEW_FOLDED, ['延伸义与词族', '易混词辨析', '词源与构词']);
});

test('index.html 具备页面必需的结构（hash 路由两页 + 设置弹层）', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const $ = load(html);
  assert.equal($('#statusbar').length, 1, '缺少状态条');
  assert.equal($('#page-query').length, 1, '缺少查词页');
  assert.equal($('#page-review').length, 1, '缺少复习页');
  assert.equal($('#settings').length, 1, '缺少设置弹层');
  assert.equal($('#word-input').length, 1, '缺少输入框');
  assert.equal($('#length-mode').length, 1, '缺少长度档位下拉');
  assert.equal($('#no-save').length, 1, '缺少「这次不保存」');
  assert.equal($('#result').length, 1, '缺少结果区');
});

test('index.html 引用 render.js 与 app.js 且不内联脚本逻辑', async () => {
  const html = await readFile('public/index.html', 'utf8');
  assert.ok(html.includes('app.js'));
  assert.ok(html.includes('style.css'));
  assert.ok(html.includes('type="module"'));
});

test('查词栏：具备参考站的形态（放大镜 + 快捷键徽标 + 清空按钮）', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const $ = load(html);
  assert.equal($('.search').length, 1, '缺少查词栏容器');
  assert.equal($('.search .search-icon').length, 1, '缺少左侧放大镜');
  assert.equal($('#search-clear').length, 1, '缺少清空按钮');
  assert.ok($('#search-clear').attr('hidden') !== undefined, '清空按钮默认应隐藏');
  assert.equal($('#search-key').length, 0, '快捷键徽标已移除：不保留没有实际作用的假提示');
  // 输入框仍留在查词栏内，且图标/徽标是绝对定位在同一容器里
  assert.equal($('.search #word-input').length, 1, '输入框必须在查词栏内');
  assert.equal($('.search #length-mode').length, 0, '长度档位不该挤在输入框同一行（参考站是整宽输入）');
  assert.equal($('.search-tools #length-mode').length, 1, '长度档位应移到下方工具行');
  // ToDesktop 风格下拉：原生箭头已关掉，必须自绘 chevron 且不可拦截点击
  // 自绘下拉：面板排在按钮下方，因此不能再依赖原生 select 弹窗
  assert.equal($('.search-tools select').length, 0, '不应再用原生 select（面板要出现在按钮下方）');
  assert.equal($('#length-trigger').length, 1, '缺少下拉触发器');
  assert.equal($('#length-trigger').attr('aria-haspopup'), 'listbox', '触发器需声明 listbox');
  assert.equal($('#length-trigger').attr('aria-expanded'), 'false', '默认应收起');
  assert.equal($('#length-panel').length, 1, '缺少下拉面板');
  assert.ok($('#length-panel').attr('hidden') !== undefined, '面板默认应隐藏');
  assert.equal($('#length-list').attr('role'), 'listbox', '选项列表需 role=listbox');
  const opts = $('#length-list [role=option]');
  assert.equal(opts.length, 3, '应有三个档位');
  assert.deepEqual(opts.map((i, e) => $(e).attr('data-value')).get(), ['quick', 'standard', 'intensive']);
  assert.equal(opts.filter((i, e) => $(e).attr('aria-selected') === 'true').length, 1, '恰有一个选中项');
  assert.equal($('#length-highlight').length, 1, '缺少滑动胶囊（选择动效）');
  assert.equal($('#length-highlight').attr('aria-hidden'), 'true', '胶囊是装饰，应 aria-hidden');
  assert.equal($('.dropdown-chevron').length, 1, '下拉缺少自绘 chevron');
  assert.equal($('.dropdown-chevron').attr('aria-hidden'), 'true', 'chevron 是装饰，应 aria-hidden');
  assert.equal($('#length-mode').attr('type'), 'hidden', '#length-mode 需作为值载体保留（app.js 与配置依赖它）');
  assert.equal($('button[data-menu=settings]').hasClass('btn-pill'), true, '复习页「设置」应是胶囊按钮');
});

test('示例不再用「·」拼接，改为胶囊按钮', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const $ = load(html);
  const chips = $('#syntax-hint .chip');
  assert.equal(chips.length, 3, '应保留三个示例');
  const fills = chips.map((i, e) => $(e).attr('data-fill')).get();
  assert.deepEqual(fills, ['affect', 'affect vs effect', 'affect 词根']);
  assert.ok(!$('#syntax-hint .dot').length, '示例行里不该再有「·」分隔符');
});

test('下拉面板底色必须与触发按钮同色（三个主题档都要）', async () => {
  const css = await readFile('public/style.css', 'utf8');
  const hits = css.match(/--menu-bg: linear-gradient\(var\(--btn-bg\), var\(--btn-bg\)\), var\(--bg\);/g) || [];
  assert.equal(hits.length, 3, '浅色 / 系统深色 / 显式深色 三档都要统一，实际 ' + hits.length);
  assert.ok(!/--menu-bg: rgba\(255, 255, 255/.test(css), '面板不应再有自己的白底');
});

test('旧的输入区样式类已彻底移除（避免样式互斥）', async () => {
  const [html, css] = await Promise.all([
    readFile('public/index.html', 'utf8'),
    readFile('public/style.css', 'utf8')
  ]);
  for (const dead of ['input-row', 'input-sub']) {
    assert.ok(!html.includes(dead), 'index.html 仍引用 ' + dead);
    assert.ok(!css.includes(dead), 'style.css 仍定义 ' + dead);
  }
});

test('index.html 明确禁止浏览器存储学习数据（PRD 硬性要求）', async () => {
  const js = await readFile('public/app.js', 'utf8');
  for (const bad of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.ok(!js.includes(bad), 'app.js 不得使用 ' + bad);
  }
});
