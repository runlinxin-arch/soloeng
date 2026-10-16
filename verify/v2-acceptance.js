/**
 * v2 验收（PRD §7.2 四项）。纯本地，不依赖网络。
 * 用法：node verify/v2-acceptance.js
 */
import { readFile, rm } from 'node:fs/promises';
// 复用测试的临时目录助手：进程退出时自动清理
import { tempDir } from '../test/helpers/tmp.js';
;
import path from 'node:path';
import { createService } from '../lib/service.js';
import * as store from '../lib/store.js';
import { readCard, writeCard } from '../lib/store.js';
;
import { todayISO, addDays } from '../lib/dates.js';

const results = [];
function record(no, name, pass, detail) {
  results.push({ no, name, pass: Boolean(pass) });
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] §7.2-' + no + ' ' + name + (detail ? '\n         ' + detail : ''));
}

const vault = await tempDir('eng-v2-');
const TODAY = todayISO();
const svc = createService({ config: { vaultPath: vault, dailyNewLimit: 10, dailyReviewLimit: 3, backupKeep: 20 }, store });

function mkWord(word, pos, opts) {
  const o = opts || {};
  return {
    word,
    data: {
      word, ipa_uk: '/x/', ipa_us: '/y/', audio_uk: 'https://www.oxfordlearnersdictionaries.com/media/a.mp3', audio_us: null,
      pos: [pos], oxford3000: false, opal: [], tags: [], added: '2026-01-01', suspended: [],
      srs: [{ pos, due: o.due || TODAY, interval: o.interval === undefined ? 1 : o.interval, ease: o.ease === undefined ? 2.5 : o.ease, reps: o.reps === undefined ? 0 : o.reps, lapses: 0, last: '2026-01-01' }]
    },
    body: '# ' + word + '\n\n## 核心释义\n**' + pos + '.** 测试\n\n## 易混词辨析\nvs [[x]]'
  };
}

console.log('=== v2 验收开始（库：' + vault + '）===');
console.log('');

/* ---------- 10 到期队列 ---------- */
{
  const due = mkWord('duenow', 'noun', { due: TODAY });
  const past = mkWord('overdue', 'verb', { due: addDays(TODAY, -5) });
  const future = mkWord('futureword', 'noun', { due: addDays(TODAY, 7) });
  for (const w of [due, past, future]) await writeCard(vault, w.word, w.data, w.body);
  const r = await svc.reviewToday({ continueAll: true });
  const words = r.items.map((i) => i.word);
  const onlyDue = words.includes('duenow') && words.includes('overdue') && !words.includes('futureword');
  record(10, '复习页只列今天到期的项，未来的不出现',
    onlyDue && r.items.every((i) => i.pos && i.word),
    '队列=' + JSON.stringify(words) + ' | 未来的 futureword 被排除=' + !words.includes('futureword') +
    ' | 每项都是「词+词性」=' + r.items.every((i) => Boolean(i.pos)));
}

/* ---------- 11 评分回写，且 Obsidian 里直接可见 ---------- */
{
  await writeCard(vault, 'grade3', mkWord('grade3', 'noun', { due: TODAY }).data, mkWord('grade3', 'noun').body);
  await writeCard(vault, 'grade2', Object.assign(mkWord('grade2', 'noun').data, {
    srs: [{ pos: 'noun', due: TODAY, interval: 10, ease: 2.5, reps: 2, lapses: 0, last: '2026-01-01' }]
  }), mkWord('grade2', 'noun').body);
  await writeCard(vault, 'grade1', Object.assign(mkWord('grade1', 'noun').data, {
    srs: [{ pos: 'noun', due: TODAY, interval: 18, ease: 2.5, reps: 4, lapses: 1, last: '2026-01-01' }]
  }), mkWord('grade1', 'noun').body);

  const r3 = await svc.rateWord({ word: 'grade3', pos: 'noun', grade: 3 });
  const r2 = await svc.rateWord({ word: 'grade2', pos: 'noun', grade: 2 });
  const r1 = await svc.rateWord({ word: 'grade1', pos: 'noun', grade: 1 });

  const ok3 = r3.entry.interval === 3 && r3.entry.ease === 2.6 && r3.entry.reps === 1;
  const ok2 = r2.entry.interval === 12 && r2.entry.ease === 2.45 && r2.entry.reps === 3;
  const ok1 = r1.entry.interval === 1 && r1.entry.ease === 2.3 && r1.entry.lapses === 2 && r1.entry.reps === 0;

  // 直接读磁盘上的 Markdown 文本，证明「在 Obsidian 里能看到」
  const raw3 = await readFile(path.join(vault, 'grade3.md'), 'utf8');
  const raw1 = await readFile(path.join(vault, 'grade1.md'), 'utf8');
  const visible = raw3.includes('interval: 3') && raw3.includes('ease: 2.6') && raw1.includes('lapses: 2');
  const dueIsFuture = r3.entry.due === addDays(TODAY, 3);

  record(11, '三档评分按附录 B 回写 frontmatter，且在 Obsidian 直接可见',
    ok3 && ok2 && ok1 && visible && dueIsFuture,
    '记得: ' + JSON.stringify(r3.entry) + '\n         模糊: ' + JSON.stringify(r2.entry) +
    '\n         忘了: ' + JSON.stringify(r1.entry) + '\n         Markdown 文本可见=' + visible);
}

/* ---------- 12 软上限与超额 ---------- */
{
  const vault2 = await tempDir('eng-v2limit-');
  const svc2 = createService({ config: { vaultPath: vault2, dailyNewLimit: 1, dailyReviewLimit: 2 }, store });
  for (let i = 0; i < 3; i++) {
    const w = mkWord('new' + i, 'noun', { due: TODAY, reps: 0 });
    await writeCard(vault2, w.word, w.data, w.body);
  }
  for (let i = 0; i < 5; i++) {
    const w = mkWord('rev' + i, 'noun', { due: TODAY, interval: 10, reps: 3 });
    await writeCard(vault2, w.word, w.data, w.body);
  }
  const limited = await svc2.reviewToday({});
  const all = await svc2.reviewToday({ continueAll: true });
  const capped = limited.items.length === 3 && limited.remaining === 5;
  const over = all.items.length === 8 && all.remaining === 0;
  record(12, '软上限生效且可「继续复习」超额',
    capped && over,
    '受限：' + limited.items.length + ' 张，remaining=' + limited.remaining +
    '（新词上限 1 + 复习上限 2）| 超额：' + all.items.length + ' 张，remaining=' + all.remaining);
  await rm(vault2, { recursive: true, force: true });
}

/* ---------- 13 移出复习队列：数据不删 ---------- */
{
  const s = await svc.setSuspended({ word: 'overdue', pos: 'verb', suspended: true });
  const afterSuspend = await svc.reviewToday({ continueAll: true });
  const gone = !afterSuspend.items.some((i) => i.word === 'overdue' && i.pos === 'verb');
  const card = await readCard(vault, 'overdue');
  const historyKept = card.exists && card.data.srs.length === 1 && card.data.srs[0].pos === 'verb';
  const bodyKept = card.body.includes('## 核心释义');
  const back = await svc.setSuspended({ word: 'overdue', pos: 'verb', suspended: false });
  const afterRestore = await svc.reviewToday({ continueAll: true });
  const returned = afterRestore.items.some((i) => i.word === 'overdue' && i.pos === 'verb');
  record(13, '移出队列后不再出现，但卡片与复习历史完整保留',
    s.ok && gone && historyKept && bodyKept && returned,
    '移出后消失=' + gone + ' | srs 历史保留=' + historyKept + ' | 正文保留=' + bodyKept +
    ' | suspended=' + JSON.stringify(back.suspended) + ' | 重新启用后回归=' + returned);
}

console.log('');
const pass = results.filter((r) => r.pass).length;
console.log('=== v2 验收结果：' + pass + '/' + results.length + ' 通过 ===');
for (const r of results) console.log((r.pass ? '  ✅' : '  ❌') + ' §7.2-' + r.no + ' ' + r.name);

await rm(vault, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);
