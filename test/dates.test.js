import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, todayISO, parseISO, addDays, daysBetween, isDue, isFuture } from '../lib/dates.js';

test('todayISO 用本机时区的自然日（PRD：00:00 为界）', () => {
  const late = new Date(2026, 9, 15, 23, 59, 59);
  const early = new Date(2026, 9, 16, 0, 0, 1);
  assert.equal(todayISO(late), '2026-10-15');
  assert.equal(todayISO(early), '2026-10-16');
});

test('addDays 跨月/跨年/闰年正确', () => {
  assert.equal(addDays('2026-10-15', 1), '2026-10-16');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2026-10-15', 0), '2026-10-15');
  assert.equal(addDays('2026-10-15', 30), '2026-11-14');
});

test('首次入库 due = added + 1 天（附录 B）', () => {
  assert.equal(addDays('2026-10-15', 1), '2026-10-16');
});

test('daysBetween 与 SM-2 序列一致', () => {
  assert.equal(daysBetween('2026-10-15', '2026-10-18'), 3);
  assert.equal(daysBetween('2026-10-18', '2026-10-15'), -3);
  assert.equal(daysBetween('2026-10-15', '2026-10-15'), 0);
});

test('isDue / isFuture 边界：当天算到期', () => {
  const now = new Date(2026, 9, 15, 9, 0, 0);
  assert.equal(isDue('2026-10-15', now), true, '当天必须算到期');
  assert.equal(isDue('2026-10-14', now), true);
  assert.equal(isDue('2026-10-16', now), false);
  assert.equal(isFuture('2026-10-16', now), true);
  assert.equal(isFuture('2026-10-15', now), false);
  assert.equal(isDue('bad-date', now), false);
});

test('parseISO 校验格式', () => {
  assert.equal(parseISO('2026-10-15').getFullYear(), 2026);
  assert.equal(parseISO('2026-1-5'), null);
  assert.equal(parseISO(''), null);
  assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
});
