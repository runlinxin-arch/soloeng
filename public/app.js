import {
  renderMarkdown, renderHead, renderStatusBar, renderRecent, createSseParser,
  renderReviewBack, escapeHtml
} from './render.js';

/**
 * 浏览器只当界面，不做任何持久化存储（PRD 硬性要求）：
 * 所有学习数据都在服务端文件里，刷新/清缓存都不丢。
 */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

const el = {
  statusbar: $('#statusbar'),
  input: $('#word-input'),
  lengthMode: $('#length-mode'),
  noSave: $('#no-save'),
  hint: $('#input-hint'),
  recent: $('#recent'),
  result: $('#result'),
  pageQuery: $('#page-query'),
  pageReview: $('#page-review'),
  reviewBody: $('#review-body'),
  reviewActions: $('#review-actions'),
  reviewProgress: $('#review-progress'),
  settings: $('#settings')
};

const state = {
  config: null,
  options: null,
  vault: null,
  vaultName: null,
  controller: null,
  lastQuery: null,
  lastBody: '',
  streaming: false
};

/* ============================ 通用 ============================ */

async function api(path, opts) {
  const res = await fetch(path, opts);
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

function applyTheme(theme) {
  if (!theme || theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function showHint(msg) {
  el.hint.textContent = msg || '';
}

/* ============================ 状态条 ============================ */

async function refreshState() {
  const { json } = await api('/api/state');
  if (!json) return;
  el.statusbar.innerHTML = renderStatusBar(json);
  el.statusbar.querySelector('[data-menu=settings]').addEventListener('click', openSettings);
  if (json.keyStatus && state.config) state.keyStatus = json.keyStatus;
}

/* ============================ 查词 ============================ */

/* ============ 长度档位下拉（自绘，ToDesktop 风格） ============ */

let syncLengthDropdown = () => {};

function initLengthDropdown() {
  const root = $('#length-dropdown');
  const trigger = $('#length-trigger');
  const panel = $('#length-panel');
  const list = $('#length-list');
  const valueEl = $('#length-value');
  const hidden = $('#length-mode');
  const highlight = $('#length-highlight');
  if (!root || !trigger || !panel || !list || !valueEl || !hidden || !highlight) return;

  const options = Array.prototype.slice.call(list.querySelectorAll('[role="option"]'));
  if (!options.length) return;
  let activeIndex = 0;
  let open = false;

  function indexOfValue(v) {
    for (let i = 0; i < options.length; i++) if (options[i].getAttribute('data-value') === v) return i;
    return 0;
  }

  /** 把胶囊移到第 i 项；animate=false 时瞬移（打开瞬间用，避免从上一位置飞过来） */
  function moveHighlight(i, animate) {
    const opt = options[i];
    if (!opt) return;
    if (!animate) highlight.style.transition = 'none';
    highlight.style.height = opt.offsetHeight + 'px';
    highlight.style.transform = 'translateY(' + opt.offsetTop + 'px)';
    if (!animate) {
      void highlight.offsetHeight;        // 强制重排，让后续改动重新走过渡
      highlight.style.transition = '';
    }
  }

  function setActive(i, animate) {
    activeIndex = Math.max(0, Math.min(options.length - 1, i));
    for (let k = 0; k < options.length; k++) {
      const on = k === activeIndex;
      options[k].classList.toggle('is-active', on);
      if (on) list.setAttribute('aria-activedescendant', options[k].id);
    }
    moveHighlight(activeIndex, animate);
  }

  function openPanel() {
    if (open) return;
    open = true;
    panel.hidden = false;
    void panel.offsetHeight;              // 先把初始态画出来，再过渡到打开态
    panel.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
    setActive(indexOfValue(hidden.value), false);
    list.focus();
  }

  function closePanel(refocus) {
    if (!open) return;
    open = false;
    panel.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
    window.setTimeout(() => { if (!open) panel.hidden = true; }, 460);
    if (refocus) trigger.focus();
  }

  function choose(i) {
    const opt = options[i];
    if (!opt) return;
    for (const o of options) o.setAttribute('aria-selected', o === opt ? 'true' : 'false');
    valueEl.textContent = (opt.textContent || '').trim();
    hidden.value = opt.getAttribute('data-value');
    setActive(i, true);
    hidden.dispatchEvent(new Event('change', { bubbles: true }));  // 复用既有的保存逻辑
    closePanel(true);
  }

  /** 外部改了隐藏值（如启动时读 config）后，同步文案与选中态 */
  syncLengthDropdown = function () {
    const i = indexOfValue(hidden.value);
    for (let k = 0; k < options.length; k++) {
      options[k].setAttribute('aria-selected', k === i ? 'true' : 'false');
    }
    valueEl.textContent = (options[i].textContent || '').trim();
  };

  trigger.addEventListener('click', () => { if (open) closePanel(true); else openPanel(); });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openPanel(); }
  });

  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1, true); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0, true); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1, true); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(activeIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); closePanel(true); }
    else if (e.key === 'Tab') { closePanel(false); }
  });

  options.forEach((opt, i) => {
    opt.addEventListener('mouseenter', () => setActive(i, true));
    opt.addEventListener('click', () => choose(i));
  });

  document.addEventListener('click', (e) => { if (open && !root.contains(e.target)) closePanel(false); });
  window.addEventListener('resize', () => { if (open) setActive(activeIndex, false); });

  syncLengthDropdown();
}

/** 「清空」只在有输入时出现，避免空状态占位 */
function syncSearchAffordance() {
  const clear = $('#search-clear');
  if (clear) clear.hidden = el.input.value.length === 0;
}

function setBusy(busy) {
  state.streaming = busy;
  el.input.disabled = busy;
  $('#syntax-hint').hidden = busy;
}

function stopQuery() {
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  setBusy(false);
  showHint('已停止');
}

async function runQuery(force) {
  const q = el.input.value.trim();
  if (!q) return;
  if (CJK.test(q)) { showHint('请输入英文单词'); return; }
  showHint('');

  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;

  state.lastQuery = q;
  state.lastBody = '';
  setBusy(true);

  const body = {
    q,
    force: Boolean(force),
    noSave: el.noSave.checked,
    lengthMode: el.lengthMode.value
  };

  let head = null;
  let streamed = '';
  let footer = null;
  let errorInfo = null;
  let missing = [];

  el.result.innerHTML = '<div class="thinking">正在读取牛津官方词典…</div>';

  const renderStreaming = () => {
    const headHtml = head ? '<div class="head">' + renderHead(head) + '</div>' : '';
    const missingHtml = missing.length
      ? '<div class="notice">官方词典未收录：' + missing.map((m) => escapeHtml(m.block)).join('、') + '</div>'
      : '';
    el.result.innerHTML = headHtml + missingHtml +
      '<div class="body">' + renderMarkdown(streamed) + (state.streaming ? '<span class="cursor"></span>' : '') + '</div>';
    bindAudio();
    el.result.scrollIntoView({ block: 'nearest' });
  };

  try {
    const res = await fetch('/api/query/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok || !res.body) throw new Error('服务未响应');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser((ev, data) => {
      if (ev === 'status') {
        if (!head) el.result.innerHTML = '<div class="thinking">' + escapeHtml(data.text || '处理中…') + '</div>';
      } else if (ev === 'head') {
        head = data;
        renderStreaming();
      } else if (ev === 'chunk') {
        streamed += data.text || '';
        if (streamed) renderStreaming();
      } else if (ev === 'missing') {
        missing.push(data);
        renderStreaming();
      } else if (ev === 'existing') {
        head = { word: data.word, pos: (data.data && data.data.pos) || [], tags: {
          cefr: null, oxford3000: Boolean(data.data && data.data.oxford3000), opal: (data.data && data.data.opal) || [] } };
        head.ipa_uk = data.data && data.data.ipa_uk;
        head.ipa_us = data.data && data.data.ipa_us;
        head.audio_uk = data.data && data.data.audio_uk;
        head.audio_us = data.data && data.data.audio_us;
        head.obsidianUrl = data.obsidianUrl || null;
        state.lastBody = data.body || '';
        el.result.innerHTML =
          '<div class="notice">该词已在库中' + (data.updated ? '（上次更新 ' + escapeHtml(data.updated) + '）' : '') + '</div>' +
          '<div class="head">' + renderHead(head) + '</div>' +
          '<div class="body">' + renderMarkdown(data.body || '') + '</div>';
        bindAudio();
      } else if (ev === 'suggestions') {
        if (data.words && data.words.length) {
          el.result.innerHTML = '<div class="notice">你是不是想查：' +
            data.words.map((w) => '<button class="link" data-word="' + escapeHtml(w) + '">' + escapeHtml(w) + '</button>').join('、') +
            '</div>';
          bindWordButtons();
        }
      } else if (ev === 'done') {
        footer = data;
      } else if (ev === 'error') {
        errorInfo = data;
      }
    });

    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parser.feed(decoder.decode(r.value, { stream: true }));
    }
    parser.flush();
  } catch (e) {
    if (e && e.name === 'AbortError') { setBusy(false); return; }
    errorInfo = { code: 'NETWORK', message: '服务连接失败' };
  }

  state.streaming = false;
  setBusy(false);

  if (errorInfo) {
    const retry = '<button class="btn" id="btn-retry">重试</button>';
    el.result.innerHTML = '<div class="notice notice-error">' + escapeHtml(errorInfo.message || '出错了') + '</div>' + retry;
    const b = $('#btn-retry');
    if (b) b.addEventListener('click', () => runQuery(state.lastQuery && force));
    refreshState();
    return;
  }

  const headHtml = head ? '<div class="head">' + renderHead(head) + '</div>' : '';
  const missingHtml = missing.length
    ? '<div class="notice">官方词典未收录：' + missing.map((m) => escapeHtml(m.block) + (m.reason && m.reason !== '官方词典未收录' ? '（' + escapeHtml(m.reason) + '）' : '')).join('、') + '</div>'
    : '';
  const bodyHtml = '<div class="body">' + renderMarkdown(streamed || state.lastBody) + '</div>';
  const footerHtml = renderFooter(footer);
  el.result.innerHTML = headHtml + missingHtml + bodyHtml + footerHtml;
  bindAudio();
  bindFooter();
  refreshState();
  loadRecent();
}

function renderFooter(done) {
  if (!done) return '';
  let line = '';
  if (done.mode === 'saved' || done.mode === 'regenerated') {
    line = '已写入 ' + escapeHtml(done.path || '') + (done.llmFailed ? ' · 讲解生成失败' : '');
  } else if (done.mode === 'appended' || done.mode === 'updated') {
    line = '已更新 ' + escapeHtml(done.path || '') + (done.backup ? ' · 已备份原卡片' : '');
  } else if (done.mode === 'unsaved') {
    line = '未保存 · 未加入复习队列';
  } else if (done.mode === 'existing') {
    return '';
  }
  return '<div class="footer-line"><span>' + line + '</span>' +
    (done.mode === 'unsaved' ? '' : '<button class="link" id="btn-regen">重新生成</button>') +
    '</div>';
}

function bindFooter() {
  const regen = $('#btn-regen');
  if (regen) regen.addEventListener('click', () => runQuery(true));
}

function bindAudio() {
  $$('.audio', el.result).forEach((b) => {
    b.addEventListener('click', () => {
      const url = b.getAttribute('data-audio');
      if (!url) return;
      const a = new Audio('/api/audio?url=' + encodeURIComponent(url));
      a.play().catch(() => showHint('音频播放失败'));
    });
  });
  $$('.wikilink', el.result).forEach((l) => {
    l.addEventListener('click', () => {
      el.input.value = l.getAttribute('data-wikilink');
      runQuery(false);
    });
  });
}

function bindWordButtons(root) {
  $$('[data-word]', root || el.result).forEach((b) => {
    b.addEventListener('click', () => {
      el.input.value = b.getAttribute('data-word');
      runQuery(false);
    });
  });
}

async function loadRecent() {
  const { json } = await api('/api/state');
  if (!json) return;
  el.recent.innerHTML = renderRecent(json.recent);
  bindWordButtons(el.recent);
}

/* ============================ 设置 ============================ */

async function openSettings() {
  const { json } = await api('/api/config');
  if (!json) return;
  state.config = json.config;
  state.options = json.options;
  state.vaultName = json.vaultName;

  $('#cfg-vault').value = json.config.vaultPath || '';
  $('#cfg-new-limit').value = json.config.dailyNewLimit;
  $('#cfg-review-limit').value = json.config.dailyReviewLimit;
  $('#cfg-mw').checked = Boolean(json.config.enableMW);
  $('#cfg-theme').value = json.config.theme || 'system';
  $('#cfg-model').innerHTML = (json.options.models || []).map((m) =>
    '<option value="' + escapeHtml(m.id) + '"' + (m.id === json.config.model ? ' selected' : '') + '>' + escapeHtml(m.label) + '</option>'
  ).join('');

  const vaultPath = String(json.config.vaultPath || '').trim();
  $('#vault-status').textContent = !vaultPath
    ? '尚未配置：填入你的 Obsidian 库目录后点「检测」'
    : (json.vault.exists
      ? (json.vault.writable ? '目录存在且可写' : '目录存在但不可写：' + (json.vault.error || ''))
      : ('目录不存在：' + (json.vault.error || '') + '（点「检测」会自动创建）'));
  $('#mw-status').textContent = json.keyStatus.mwCollegiate ? '已配置' : '未配置';
  $('#ds-status').textContent = json.keyStatus.deepseek ? '已读取 ~/.secrets' : '未找到';
  $('#data-dir').textContent = json.dataDir || '';
  $('#save-status').textContent = '';
  el.settings.hidden = false;
}

async function saveSettings() {
  const payload = {
    vaultPath: $('#cfg-vault').value.trim(),
    dailyNewLimit: Number($('#cfg-new-limit').value),
    dailyReviewLimit: Number($('#cfg-review-limit').value),
    model: $('#cfg-model').value,
    enableMW: $('#cfg-mw').checked,
    theme: $('#cfg-theme').value
  };
  const { json } = await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (json && json.config) {
    state.config = json.config;
    applyTheme(json.config.theme);
    $('#save-status').textContent = '已保存';
    refreshState();
  } else {
    $('#save-status').textContent = '保存失败';
  }
}

async function checkVault() {
  const vaultPath = $('#cfg-vault').value.trim();
  const { json } = await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'checkVault', vaultPath })
  });
  if (!json) return;
  if (json.vault.exists) {
    $('#vault-status').textContent = json.vault.writable ? '目录存在且可写' : '目录存在但不可写';
  } else {
    $('#vault-status').textContent = '目录不存在，可点「创建」';
    await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ensureVault', vaultPath })
    });
    const again = await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'checkVault', vaultPath })
    });
    if (again.json && again.json.vault.writable) $('#vault-status').textContent = '已创建并可写';
  }
}

/* ============================ 路由 ============================ */

function route() {
  const hash = location.hash || '#/';
  const isReview = hash.startsWith('#/review');
  el.pageQuery.hidden = isReview;
  el.pageReview.hidden = !isReview;
  if (isReview) loadReview();
  else el.input.focus();
}

/* ============================ 复习（v2） ============================ */

async function loadReview(continueAll) {
  const { status, json } = await api('/api/review/today' + (continueAll ? '?continue=1' : ''));
  if (status !== 200 || !json) {
    el.reviewProgress.textContent = '';
    el.reviewBody.innerHTML = '<div class="notice">复习功能尚未启用</div>';
    el.reviewActions.innerHTML = '';
    return;
  }
  window.__review = json;
  window.__reviewIndex = 0;
  window.__reviewDone = 0;
  window.__reviewPaused = false;
  renderReviewItem();
}

function currentReviewItem() {
  const data = window.__review || {};
  return (data.items || [])[window.__reviewIndex || 0] || null;
}

function renderReviewItem() {
  const data = window.__review || {};
  const items = data.items || [];
  const idx = window.__reviewIndex || 0;
  const item = items[idx];
  if (!item) {
    const left = data.remaining || 0;
    el.reviewProgress.textContent = '今日已完成 ' + (window.__reviewDone || 0) + ' 张';
    el.reviewBody.innerHTML = '<div class="notice">今日已完成' +
      (left ? ' · 还有 ' + left + ' 张到期，继续复习？' : '') + '</div>';
    el.reviewActions.innerHTML =
      (left ? '<button class="btn btn-primary" id="btn-more">继续复习 ' + left + ' 张</button>' : '') +
      '<button class="btn" data-nav="#/">去查词</button>';
    const more = $('#btn-more');
    if (more) more.addEventListener('click', () => loadReview(true));
    bindNavButtons(el.reviewActions);
    return;
  }
  el.reviewProgress.textContent = '今日复习 ' + (idx + 1) + ' / ' + items.length;
  const front = '<div class="front-word">' + escapeHtml(item.word) + '</div>' +
    '<div class="front-pos">' + escapeHtml(item.pos) + '</div>' +
    (item.ipa_uk ? '<div class="front-pos">' + escapeHtml(item.ipa_uk) + ' 英' +
      (item.ipa_us ? '    ' + escapeHtml(item.ipa_us) + ' 美' : '') + '</div>' : '') +
    (item.audio_uk ? '<button class="audio" data-audio="' + escapeHtml(item.audio_uk) + '">🔊英</button>' : '') +
    (item.audio_us ? '<button class="audio" data-audio="' + escapeHtml(item.audio_us) + '">🔊美</button>' : '');

  if (!window.__reviewPaused) {
    el.reviewBody.innerHTML = '<div class="review-card" id="review-flip">' + front +
      '<div class="muted" style="margin-top:12px">点击 / → / Enter 翻面</div></div>';
    $('#review-flip').addEventListener('click', flipReview);
    el.reviewActions.innerHTML = '';
  } else {
    el.reviewBody.innerHTML = '<div class="review-card back">' + front + '<hr>' +
      renderReviewBack(item.__body || '', { pos: item.pos, otherPos: item.otherPos }) + '</div>';
    el.reviewActions.innerHTML =
      '<button class="btn" data-grade="1">忘了 1</button>' +
      '<button class="btn" data-grade="2">模糊 2</button>' +
      '<button class="btn" data-grade="3">记得 3</button>' +
      '<button class="btn" id="btn-skip">跳过</button>' +
      '<button class="btn" id="btn-suspend" title="移出复习队列（数据不删）">移出队列</button>';
    $$('[data-grade]', el.reviewActions).forEach((b) => b.addEventListener('click', () => rateCurrent(Number(b.getAttribute('data-grade')))));
    $('#btn-skip').addEventListener('click', skipCurrent);
    $('#btn-suspend').addEventListener('click', suspendCurrent);
  }
  bindAudio2();
}

function bindAudio2() {
  $$('.audio', el.reviewBody).forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const url = b.getAttribute('data-audio');
    if (url) new Audio('/api/audio?url=' + encodeURIComponent(url)).play().catch(() => {});
  }));
}

/** 翻面：正文按需拉取，避免一次把整库正文都塞进页面 */
async function flipReview() {
  const item = currentReviewItem();
  if (!item) return;
  if (item.__body === undefined) {
    const { json } = await api('/api/card?word=' + encodeURIComponent(item.word));
    item.__body = (json && json.body) || '';
  }
  window.__reviewPaused = true;
  renderReviewItem();
}

async function rateCurrent(grade) {
  const item = currentReviewItem();
  if (!item) return;
  await api('/api/review/rate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: item.word, pos: item.pos, grade })
  });
  window.__reviewPaused = false;
  window.__reviewIndex = (window.__reviewIndex || 0) + 1;
  window.__reviewDone = (window.__reviewDone || 0) + 1;
  const data = window.__review || {};
  data.remaining = Math.max(0, (data.remaining || 0) - 1);
  renderReviewItem();
}

function skipCurrent() {
  const data = window.__review || {};
  const items = data.items || [];
  const i = window.__reviewIndex || 0;
  const item = items[i];
  if (!item) return;
  items.splice(i, 1);
  items.push(item); // 排到当日队列末尾，不计入完成数
  window.__reviewPaused = false;
  renderReviewItem();
}

/** 移出复习队列：只打 suspended 标记，复习历史与正文都不删（PRD §7.2-13） */
async function suspendCurrent() {
  const item = currentReviewItem();
  if (!item) return;
  await api('/api/review/suspend', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: item.word, pos: item.pos, suspended: true })
  });
  const items = (window.__review || {}).items || [];
  const i = window.__reviewIndex || 0;
  items.splice(i, 1);
  window.__reviewPaused = false;
  renderReviewItem();
}

function bindNavButtons(root) {
  $$('[data-nav]', root).forEach((b) => b.addEventListener('click', () => { location.hash = b.getAttribute('data-nav'); }));
}

/* ============================ 事件绑定 ============================ */

function bindGlobal() {
  initLengthDropdown();

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.streaming) stopQuery();
      else runQuery(false);
    }
    if (e.key === 'Escape') {
      if (state.streaming) stopQuery();
      else { el.result.innerHTML = ''; showHint(''); }
    }
  });
  el.input.addEventListener('input', () => {
    if (CJK.test(el.input.value)) showHint('请输入英文单词');
    else showHint('');
    syncSearchAffordance();
  });

  $('#search-clear').addEventListener('click', () => {
    el.input.value = '';
    showHint('');
    syncSearchAffordance();
    el.input.focus();
  });

  $('#syntax-hint').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fill]');
    if (!b) return;
    el.input.value = b.getAttribute('data-fill');
    syncSearchAffordance();
    el.input.focus();
  });

  $$('[data-menu=settings]').forEach((b) => b.addEventListener('click', openSettings));
  $('#btn-save-config').addEventListener('click', saveSettings);
  $('#btn-check-vault').addEventListener('click', checkVault);
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => { el.settings.hidden = true; }));
  el.settings.addEventListener('click', (e) => { if (e.target === el.settings) el.settings.hidden = true; });
  el.lengthMode.addEventListener('change', async () => {
    await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lengthMode: el.lengthMode.value })
    });
  });

  document.addEventListener('keydown', (e) => {
    if (el.settings.hidden === false) { if (e.key === 'Escape') el.settings.hidden = true; return; }

    if (el.pageReview.hidden) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') { if (!window.__reviewPaused) flipReview(); }
    else if (e.key === '1' || e.key === '2' || e.key === '3') { if (window.__reviewPaused) rateCurrent(Number(e.key)); }
    else if (e.key === 'Escape') location.hash = '#/';
  });

  window.addEventListener('hashchange', route);
}

/* ============================ 启动 ============================ */

async function init() {
  bindGlobal();
  const { json } = await api('/api/config');
  if (json && json.config) {
    state.config = json.config;
    state.options = json.options;
    applyTheme(json.config.theme);
    if (json.config.lengthMode) el.lengthMode.value = json.config.lengthMode;
  }
  syncLengthDropdown();
  syncSearchAffordance();
  refreshState();
  loadRecent();
  route();
  el.input.focus();
}

init();
