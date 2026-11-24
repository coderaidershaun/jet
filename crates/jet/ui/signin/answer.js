// What the sign-in page says about each answer of the server, and where it goes afterwards.

function wait(retryAfter) {
  const seconds = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) : null;
  if (seconds === null) return 'a few minutes';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/**
 * The words for a sign-in that did not work, and the field they belong to.
 * @param {{ status: number, kind?: string, retryAfter?: string | null }} refusal   status 0 when the server was not reached
 * @returns {{ text: string, field: 'email' | 'password' | null }}
 */
export function refusalMessage({ status, kind, retryAfter = null }) {
  if (kind === 'wrongPassword') return { text: 'That email and password don’t match. Check them and try again.', field: 'password' };
  if (kind === 'tooManyFailures') return { text: `Too many tries for now. For your safety, try again in ${wait(retryAfter)}.`, field: null };
  if (kind === 'crossSite') return { text: 'Jet only takes a sign-in from its own page. Open Jet’s own address and try again.', field: null };
  if (status === 0) return { text: 'You can’t reach Jet right now. Check your connection and try again.', field: null };
  return { text: `Something went wrong on Jet’s side (HTTP ${status}). Try again in a moment.`, field: null };
}

/**
 * The address to open once signed in: the `next` of the query when it stays on Jet, else `/`.
 * It is resolved the way the browser will resolve it, because the browser drops tabs and line
 * breaks and reads a backslash as a slash, so a check of the raw text can be fooled.
 * @param {string} search   `location.search`
 * @param {string} origin   `location.origin`
 */
export function nextAddress(search, origin) {
  const next = new URLSearchParams(search).get('next') ?? '/';
  let address;
  try { address = new URL(next, origin); } catch { return '/'; }
  const onJet = address.origin === origin && !address.pathname.startsWith('/signin');
  return onJet ? address.pathname + address.search + address.hash : '/';
}
