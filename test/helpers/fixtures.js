import { existsSync } from 'node:fs';
import { test as nodeTest } from 'node:test';

/**
 * 抓取到的官方词典原文受版权保护，不随仓库分发（见 README「测试数据」），
 * 需要时由 npm run spike 在本机再生。
 *
 * 这里的关键是**按用例**声明依赖，而不是按文件：
 * 早先的写法是「文件里缺任意一个 fixture 就跳过整个文件」，后果是
 * CI 在没有 MW 密钥时（只能拿到牛津/剑桥的 HTML）连 10 个纯 HTML 的解析测试
 * 也一起跳过 —— 而解析恰是本项目最复杂的部分。
 */

export const FIXTURE = {
  oald: 'fixtures/html/oald.html',
  oald2: 'fixtures/html/oald_2.html',
  cambridge: 'fixtures/html/cambridge.html',
  cambridgeAffect: 'fixtures/html/cambridge-affect.html',
  spellcheck: 'fixtures/html/spellcheck.html',
  spellcheckNone: 'fixtures/html/spellcheck-none.html',
  mwCollegiate: 'fixtures/mw-collegiate-raw.json',
  mwThesaurus: 'fixtures/mw-thesaurus-raw.json'
};

/** dictionary.test.js 的 makeFake() 会一次性读取这 5 个 HTML fixture */
export const ALL_HTML = [
  FIXTURE.oald,
  FIXTURE.oald2,
  FIXTURE.cambridge,
  FIXTURE.cambridgeAffect,
  FIXTURE.spellcheck
];

export const MW_RAW = [FIXTURE.mwCollegiate, FIXTURE.mwThesaurus];

/** 返回 false 表示可以执行；否则返回跳过原因（会显示在测试输出里） */
export function skipReason(fixtures) {
  const missing = (fixtures || []).filter((f) => !existsSync(f));
  if (!missing.length) return false;
  return '缺少 ' + missing.join('、') + '（未随仓库分发）：先运行 npm run spike 重新抓取（需联网）';
}

/** 用法：test([FIXTURE.oald], '用例名', fn)；不需要 fixture 的用例传 [] */
export function testWith(fixtures, name, fn) {
  return nodeTest(name, { skip: skipReason(fixtures) }, fn);
}
