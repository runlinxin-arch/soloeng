const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const WORD = /^[a-zA-Z][a-zA-Z'\-]*$/;

/**
 * 解析输入框内容。
 * 支持：单查 / X vs Y 辨析 / X 词根 追加词源 / 中文拦截
 */
export function parseInput(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { kind: 'empty', raw: text };

  // 注意：语法关键词本身可能是中文（对比 / 词根 / 词源），
  // 因此必须先识别语法，再判定「是不是纯中文输入」。
  const vs = text.match(/^([a-zA-Z][a-zA-Z'\-]*)\s+(?:vs\.?|VS\.?|对比|辨析)\s+([a-zA-Z][a-zA-Z'\-]*)$/);
  if (vs) {
    return { kind: 'compare', word: vs[1].toLowerCase(), other: vs[2].toLowerCase(), raw: text };
  }

  const rootsAfter = text.match(/^([a-zA-Z][a-zA-Z'\-]*)\s+(?:词根词缀|词根|词源)$/);
  if (rootsAfter) return { kind: 'roots', word: rootsAfter[1].toLowerCase(), raw: text };
  const rootsBefore = text.match(/^(?:词根词缀|词根|词源)\s+([a-zA-Z][a-zA-Z'\-]*)$/);
  if (rootsBefore) return { kind: 'roots', word: rootsBefore[1].toLowerCase(), raw: text };

  // 语法都没匹配上，此时才把中文当作「非英文输入」拦截
  if (CJK.test(text)) return { kind: 'invalid', reason: 'chinese', raw: text, message: '请输入英文单词' };

  if (WORD.test(text)) return { kind: 'single', word: text.toLowerCase(), raw: text };

  return { kind: 'invalid', reason: 'not_single_word', raw: text, message: '一次只能查一个英文单词' };
}
