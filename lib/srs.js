import { addDays, todayISO, isDue } from './dates.js';

export const MIN_EASE = 1.3;
export const INITIAL_EASE = 2.5;
export const INITIAL_INTERVAL = 1;
export const GRADE = { FORGOT: 1, FUZZY: 2, REMEMBERED: 3 };

export const GRADE_LABEL = { 1: '忘了', 2: '模糊', 3: '记得' };

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 简化 SM-2（PRD 附录 B），纯函数：输入输出都可读可测。
 *
 *   忘了 → 间隔重置为 1 天，ease −0.20，lapses +1
 *   模糊 → 间隔 × 1.2，ease −0.05
 *   记得 → 间隔 × ease（初始 2.5），ease +0.10
 *
 * ease 有下限 MIN_EASE，避免连续「忘了」把间隔压死。
 */
export function rate(state, grade, today) {
  const s = state || {};
  const g = Number(grade);
  const day = today || todayISO();
  const cur = {
    pos: s.pos,
    interval: Math.max(1, num(s.interval, INITIAL_INTERVAL)),
    ease: Math.max(MIN_EASE, num(s.ease, INITIAL_EASE)),
    reps: Math.max(0, num(s.reps, 0)),
    lapses: Math.max(0, num(s.lapses, 0)),
    last: s.last || null,
    due: s.due || null
  };

  let interval;
  if (g === GRADE.FORGOT) {
    interval = 1;
    cur.ease = round2(cur.ease - 0.2);
    cur.lapses += 1;
    cur.reps = 0;
  } else if (g === GRADE.FUZZY) {
    interval = Math.max(1, Math.round(cur.interval * 1.2));
    cur.ease = round2(cur.ease - 0.05);
    cur.reps += 1;
  } else {
    interval = Math.max(1, Math.round(cur.interval * cur.ease));
    cur.ease = round2(cur.ease + 0.1);
    cur.reps += 1;
  }

  cur.ease = Math.max(MIN_EASE, round2(cur.ease));
  cur.interval = interval;
  cur.last = day;
  cur.due = addDays(day, interval);
  return cur;
}

/** 新的复习条目（首次入库，1 天后进入第一轮） */
export function initialEntry(pos, added) {
  const day = added || todayISO();
  return {
    pos,
    due: addDays(day, 1),
    interval: INITIAL_INTERVAL,
    ease: INITIAL_EASE,
    reps: 0,
    lapses: 0,
    last: day
  };
}

/** 某词性条目是否今天到期（suspended 排除在外） */
export function isEntryDue(entry, suspended, today) {
  if (!entry) return false;
  if (Array.isArray(suspended) && suspended.indexOf(entry.pos) >= 0) return false;
  return isDue(entry.due, today ? new Date(today) : undefined);
}

/**
 * 今日队列：把卡片展开成「词 + 词性」的复习项。
 * 软上限：新词（reps=0）最多 newLimit，复习项最多 reviewLimit；
 * 入库不受上限限制（PRD 附录 B）。
 */
export function buildQueue(cards, opts) {
  const o = opts || {};
  const newLimit = o.newLimit === undefined ? 10 : o.newLimit;
  const reviewLimit = o.reviewLimit === undefined ? 50 : o.reviewLimit;
  const now = o.now || new Date();
  const today = todayISO(now);

  const fresh = [];
  const review = [];
  for (const c of cards || []) {
    const data = c.data || {};
    const srs = Array.isArray(data.srs) ? data.srs : [];
    const suspended = Array.isArray(data.suspended) ? data.suspended : [];
    for (const entry of srs) {
      if (!isEntryDue(entry, suspended, today)) continue;
      const item = { word: c.word, pos: entry.pos, entry, data, path: c.path };
      if (num(entry.reps, 0) === 0) fresh.push(item);
      else review.push(item);
    }
  }
  const order = (a, b) => String(a.entry.due).localeCompare(String(b.entry.due)) || a.word.localeCompare(b.word);
  fresh.sort(order);
  review.sort(order);

  const requested = o.continueAll ? Infinity : null;
  const shownNew = requested === Infinity ? fresh : fresh.slice(0, newLimit);
  const shownReview = requested === Infinity ? review : review.slice(0, reviewLimit);
  const items = shownNew.concat(shownReview);
  const dueTotal = fresh.length + review.length;

  return {
    items,
    dueTotal,
    remaining: dueTotal - items.length,
    newDue: fresh.length,
    reviewDue: review.length,
    limits: { newLimit, reviewLimit },
    today
  };
}

/** 复习项正面 = 词 + 词性（唯一回忆线索）；背面按复习速度分层 */
export function buildReviewItem(card, entry, normalizedIpa) {
  const data = card.data || {};
  const body = card.body || '';
  const pos = entry.pos;
  const otherPos = (data.pos || []).filter((p) => p !== pos);
  return {
    word: card.word,
    pos,
    ipa_uk: data.ipa_uk || (normalizedIpa && normalizedIpa.uk) || null,
    ipa_us: data.ipa_us || (normalizedIpa && normalizedIpa.us) || null,
    otherPos,
    back: body,
    entry
  };
}
