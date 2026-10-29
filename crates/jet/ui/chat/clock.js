// The page's clock: the real time source that timed modules use unless a test gives them their own,
// and how the page writes times and days, which is pure and in local time throughout.

export const realClock = {
  now: () => performance.now(),
  after(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** "09:16", 24 hour. @param {number} ms */
export function clockTime(ms) {
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** One string per calendar day, for comparing days. @param {number} ms */
export function dayKey(ms) {
  const date = new Date(ms);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/** "Today", "Yesterday" or "Mon 13 Oct". @param {number} ms @param {number} nowMs */
export function dayLabel(ms, nowMs) {
  if (dayKey(ms) === dayKey(nowMs)) return 'Today';
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(ms) === dayKey(yesterday.getTime())) return 'Yesterday';
  const date = new Date(ms);
  return WEEKDAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()];
}

/** "Wed 14 Oct 2026, 09:16", the line that tells Jet what time it is for the user. @param {number} ms */
export function localTimeLabel(ms) {
  const date = new Date(ms);
  return WEEKDAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()] + ' ' + date.getFullYear() + ', ' + clockTime(ms);
}
