// Keeps the sign-in alive without the person noticing: the access token is renewed a little
// before it runs out, and once more when the server refuses a request for want of it.

const MOST_LEAD_MS = 60_000;
const RETRY_MS = 5_000;
// Whatever the clocks say, renewals never come closer together than this.
const LEAST_DELAY_MS = 1_000;
// The server's Date header counts whole seconds, so a smaller difference is not a wrong clock.
const CLOCK_SLACK_MS = 2_000;

// Two renewals in flight with one refresh token look like a stolen copy and end the sign-in,
// so every tab of Jet renews under one shared lock.
const sharedLock = (task) => globalThis.navigator?.locks?.request('jet-renew', task) ?? task();

/** Sends the person to sign in, and back to this page afterwards. */
function goToSignIn() {
  location.assign('/signin/?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
}

/**
 * @param {{ fetch: typeof fetch, signedOut?: () => void, now?: () => number,
 *           lock?: (task: () => Promise<any>) => Promise<any> }} options
 */
export function createSession({ fetch, signedOut = goToSignIn, now = Date.now, lock = sharedLock }) {
  let timer = null;
  let renewing = null;

  /**
   * Plans the next renewal for a token that runs out at `expiresAt`, in Unix seconds of the
   * server's clock, which read `serverNow` when it answered.
   */
  function renewBefore(expiresAt, serverNow = now()) {
    const left = expiresAt * 1000 - serverNow;
    renewIn(Math.max(LEAST_DELAY_MS, left - Math.min(MOST_LEAD_MS, left / 5)));
  }

  /** The server's time from its answer, since the browser's clock may be minutes out. */
  function serverTime(response) {
    const said = Date.parse(response.headers.get('Date') ?? '');
    return Number.isNaN(said) || Math.abs(said - now()) < CLOCK_SLACK_MS ? now() : said;
  }

  function renewIn(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => renew().catch((error) => {
      console.warn('the sign-in could not be renewed; trying again soon:', error);
      renewIn(RETRY_MS);
    }), Math.max(0, ms));
  }

  /** One renewal at a time; a caller that asks while one runs shares it. */
  function renew() {
    renewing ??= lock(async () => {
      const response = await fetch('/api/auth/refresh', { method: 'POST' });
      if (response.status === 401) {
        clearTimeout(timer);
        signedOut();
        throw { kind: 'signedOut', message: 'The sign-in has ended.' };
      }
      if (!response.ok) throw { kind: 'io', message: `The sign-in could not be renewed (HTTP ${response.status}).` };
      const answer = await response.json();
      renewBefore(answer.accessExpiresAt, serverTime(response));
      return answer;
    }).finally(() => { renewing = null; });
    return renewing;
  }

  /** `fetch`, except that a refusal for want of a sign-in renews it and asks once more. */
  async function signedFetch(input, init) {
    const response = await fetch(input, init);
    if (response.status !== 401) return response;
    await renew();
    return fetch(input, init);
  }

  /** Who is signed in. A sign-in that has run out is renewed first. */
  async function whoAmI() {
    const response = await signedFetch('/api/auth/me');
    if (!response.ok) throw { kind: 'io', message: `Jet could not say who is signed in (HTTP ${response.status}).` };
    const answer = await response.json();
    renewBefore(answer.accessExpiresAt, serverTime(response));
    return answer.user;
  }

  return { renewBefore, renew, whoAmI, fetch: signedFetch };
}
