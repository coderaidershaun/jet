// How the page writes times and days. Pure, and local time throughout.

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
