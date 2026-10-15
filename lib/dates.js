/** 本机自然日（PRD：跨天以本机自然日 00:00 为界），一律用本地时区。 */

export function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

export function todayISO(now) {
  return formatDate(now || new Date());
}

export function parseISO(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  if (!d) return null;
  d.setDate(d.getDate() + Number(n || 0));
  return formatDate(d);
}

/** a 到 b 的天数差（b - a） */
export function daysBetween(a, b) {
  const da = parseISO(a);
  const db = parseISO(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

export function isDue(dueIso, now) {
  const d = parseISO(dueIso);
  if (!d) return false;
  const t = parseISO(todayISO(now));
  return d.getTime() <= t.getTime();
}

export function isFuture(dueIso, now) {
  const d = parseISO(dueIso);
  if (!d) return false;
  const t = parseISO(todayISO(now));
  return d.getTime() > t.getTime();
}
