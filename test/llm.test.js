import { test } from 'node:test';
import assert from 'node:assert/strict';
;
import {
  parseSse, extractDelta, renderPrompt, streamChat, generateCard,
  toPromptData, loadPrompt, LENGTH_GUIDE, buildThinkingParams, THINKING_MODES
} from '../lib/llm.js';
;

async function collect(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}
function sseStream(pieces) {
  return (async function* () { for (const p of pieces) yield p; })();
}

test('parseSse：一行被拆到两个 chunk 也要正确还原（关键边界）', async () => {
  const lines = await collect(parseSse(sseStream(['data: {"a"', ':1}\n\ndata: {"b":2}\n'])));
  assert.deepEqual(lines, ['data: {"a":1}', '', 'data: {"b":2}']);
});

test('parseSse：处理 CRLF 与结尾无换行', async () => {
  const lines = await collect(parseSse(sseStream(['data: 1\r\n', 'data: 2'])));
  assert.deepEqual(lines, ['data: 1', 'data: 2']);
});

test('extractDelta：正常/心跳/[DONE]/坏 JSON', () => {
  assert.equal(extractDelta('data: {"choices":[{"delta":{"content":"你好"}}]}'), '你好');
  assert.equal(extractDelta('data: {"choices":[{"delta":{"content":""}}]}'), '');
  assert.equal(extractDelta('data: {"choices":[{"delta":{}}]}'), null);
  assert.equal(extractDelta('data: [DONE]'), null);
  assert.equal(extractDelta('data: {broken'), null);
  assert.equal(extractDelta(': keep-alive'), null);
  assert.equal(extractDelta('event: ping'), null);
});

test('streamChat：用注入的 fetch 组装完整文本并逐块回调', async () => {
  // 用 JSON.stringify 构造，避免手写转义产生非法 JSON
  const evt = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
  const pieces = [
    evt({ choices: [{ delta: { content: '## 核心释义' } }] }),
    evt({ choices: [{ delta: { content: '\n影响' } }] }),
    evt({ choices: [{ delta: { content: '结束' } }] }),
    'data: [DONE]\n\n'
  ];
  const seen = [];
  const fakeFetch = async (url, init) => {
    assert.ok(url.includes('/chat/completions'));
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(init.headers.Authorization, 'Bearer sk-test');
    return { ok: true, status: 200, body: sseStream(pieces) };
  };
  const text = await streamChat({
    apiKey: 'sk-test', messages: [{ role: 'user', content: 'hi' }],
    fetch: fakeFetch, onDelta: (d) => seen.push(d)
  });
  assert.equal(text, '## 核心释义\n影响结束');
  assert.deepEqual(seen, ['## 核心释义', '\n影响', '结束']);
});

test('streamChat：HTTP 非 2xx 必须抛错（由上层降级）', async () => {
  const fakeFetch = async () => ({ ok: false, status: 402, text: async () => 'Insufficient Balance' });
  await assert.rejects(
    () => streamChat({ apiKey: 'sk-x', messages: [], fetch: fakeFetch }),
    /DeepSeek HTTP 402/
  );
});

test('streamChat：缺 key 直接抛错', async () => {
  await assert.rejects(() => streamChat({ apiKey: '', messages: [] }), /缺少 DeepSeek API key/);
});

test('renderPrompt：替换已知变量、未知变量留空、不影响正文花括号', () => {
  const out = renderPrompt('A={{a}} B={{ unknown }} C={{c}}', { a: '1', c: '3' });
  assert.equal(out, 'A=1 B= C=3');
  const keep = renderPrompt('json: {"k": 1}', {});
  assert.equal(keep, 'json: {"k": 1}', '普通花括号不得被吃掉');
});

test('三个 prompt 文件都存在且能渲染出无残留占位符', async () => {
  for (const f of ['card.md', 'diff.md', 'roots.md']) {
    const tpl = await loadPrompt(f);
    assert.ok(tpl.length > 100, f + ' 内容过短');
    const rendered = renderPrompt(tpl, {
      word: 'effect', other: 'affect', lengthMode: 'standard',
      lengthGuide: LENGTH_GUIDE.standard, missing: 'cefr', data: '{}', dataA: '{}', dataB: '{}'
    });
    assert.ok(!/\{\{/.test(rendered), f + ' 渲染后仍有未替换占位符');
  }
});

test('LENGTH_GUIDE 覆盖三个档位', () => {
  assert.deepEqual(Object.keys(LENGTH_GUIDE).sort(), ['intensive', 'quick', 'standard']);
});

test('generateCard：无 key 时降级且不抛错（PRD §7.1-3）', async () => {
  const r = await generateCard({ word: 'effect', missing: [] }, { apiKey: null });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.error, /DeepSeek key/);
});

test('generateCard：LLM 抛错时降级为官方内容（不阻塞入库）', async () => {
  const fakeFetch = async () => { throw new Error('network down'); };
  const r = await generateCard(
    { word: 'effect', senses: [], missing: ['collocations'] },
    { apiKey: 'sk-test', fetch: fakeFetch }
  );
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.error, /network down/);
  assert.equal(r.text, '');
});

test('toPromptData 只带必要字段并截断', () => {
  const n = {
    word: 'effect', ipa: { uk: '/x/' }, pos: ['noun'],
    senses: Array.from({ length: 20 }, (i, k) => ({ pos: 'noun', def: 'd' + k, examples: Array.from({ length: 9 }, (x, j) => ({ en: 'e' + j })) })),
    collocations: { categories: [{ type: 'adj', items: ['a'] }] },
    relations: { synonyms: Array.from({ length: 50 }, (i, k) => 's' + k), antonyms: [] },
    wordOrigin: 'o', usageNotes: [], idioms: Array.from({ length: 30 }, (i, k) => ({ idiom: 'i' + k }))
  };
  const d = toPromptData(n);
  assert.equal(d.senses.length, 8, '义项最多 8');
  assert.equal(d.senses[0].examples.length, 3, '例句最多 3');
  assert.equal(d.relations.synonyms.length, 15, '同义最多 15');
  assert.equal(d.idioms.length, 8, '习语最多 8');
  assert.equal(d.word, 'effect');
});

test('toPromptData 保留官方搭配框架（.cf）', () => {
  const d = toPromptData({
    word: 'effect',
    senses: [{ pos: 'noun', def: 'd', examples: [{ en: 'Her tears had no effect on him.', frame: 'effect on somebody/something' }] }]
  });
  assert.deepEqual(d.senses[0].examples[0], { frame: 'effect on somebody/something', en: 'Her tears had no effect on him.' });
});

test('streamChat 必须忽略 reasoning_content，只取正文（真实接口行为）', async () => {
  const evt = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
  const pieces = [
    evt({ choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] }),
    evt({ choices: [{ delta: { content: null, reasoning_content: '我需要先想一想' } }] }),
    evt({ choices: [{ delta: { content: '', reasoning_content: '继续想' } }] }),
    evt({ choices: [{ delta: { content: '## 核心释义', reasoning_content: null } }] }),
    evt({ choices: [{ delta: { content: '\n影响' } }] }),
    'data: [DONE]\n\n'
  ];
  const seen = [];
  const text = await streamChat({
    apiKey: 'sk-test', messages: [], onDelta: (d) => seen.push(d),
    fetch: async () => ({ ok: true, status: 200, body: sseStream(pieces) })
  });
  assert.equal(text, '## 核心释义\n影响', '思考内容绝不能进入卡片正文');
  assert.ok(!text.includes('想'), '不得混入 reasoning_content');
  assert.deepEqual(seen, ['## 核心释义', '\n影响'], '空字符串不应触发回调');
});

test('generateCard：思考占满导致正文为空 → 必须判失败，而不是写出空卡片', async () => {
  const evt = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
  const pieces = [
    evt({ choices: [{ delta: { content: null, reasoning_content: '大量思考……' } }] }),
    evt({ choices: [{ delta: { content: null, reasoning_content: '仍然在想' } }] }),
    'data: [DONE]\n\n'
  ];
  const r = await generateCard(
    { word: 'effect', senses: [], missing: [] },
    { apiKey: 'sk-test', fetch: async () => ({ ok: true, status: 200, body: sseStream(pieces) }) }
  );
  assert.equal(r.ok, false, '空正文必须判失败');
  assert.equal(r.degraded, true);
  assert.equal(r.text, '');
  assert.match(r.error, /未返回正文/);
});

test('buildThinkingParams：三档映射（off 为默认，满足 G1 的 10 秒预算）', () => {
  assert.deepEqual(buildThinkingParams('off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(buildThinkingParams('low'), { reasoning_effort: 'low' });
  assert.deepEqual(buildThinkingParams('high'), {});
  assert.deepEqual(buildThinkingParams(undefined), { thinking: { type: 'disabled' } });
  assert.deepEqual(THINKING_MODES, ['off', 'low', 'high']);
});

test('streamChat：默认关闭思考，且绝不默认下发 max_tokens', async () => {
  let captured = null;
  await streamChat({
    apiKey: 'sk-test', messages: [],
    fetch: async (url, init) => { captured = JSON.parse(init.body); return { ok: true, status: 200, body: sseStream(['data: [DONE]\n\n']) }; }
  });
  assert.deepEqual(captured.thinking, { type: 'disabled' }, '默认必须关闭思考');
  assert.equal(captured.reasoning_effort, undefined);
  assert.equal(captured.max_tokens, undefined, '不得默认下发 max_tokens：会把思考算进预算导致正文为空');
});

test('streamChat：thinkingMode=low 时改用 reasoning_effort', async () => {
  let captured = null;
  await streamChat({
    apiKey: 'sk-test', messages: [], thinkingMode: 'low',
    fetch: async (url, init) => { captured = JSON.parse(init.body); return { ok: true, status: 200, body: sseStream(['data: [DONE]\n\n']) }; }
  });
  assert.equal(captured.reasoning_effort, 'low');
  assert.equal(captured.thinking, undefined);
});
