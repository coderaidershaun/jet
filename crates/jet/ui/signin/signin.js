// The sign-in page. A person whose sign-in can still be renewed never sees it: the page renews
// silently and goes straight back to Jet.

import { icon } from '/dom.js';
import { createDirector } from '/jet/director.js';
import { mountJet } from '/jet/draw/view.js';
import { createPlayer } from '/jet/player.js';
import { nextAddress, refusalMessage } from './answer.js';
import { createSession } from './session.js';

const HELLO_AFTER_MS = 700;

const $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the sign-in page has no #${id}`);
  return element;
};
const page = $('signin'), form = $('form'), email = $('email'), password = $('password');
const reveal = $('reveal'), error = $('error'), submit = $('submit'), submitLabel = $('submit-label');
const next = nextAddress(location.search, location.origin);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
document.documentElement.classList.toggle('reduced', reduced.matches);

const kite = $('kite');
const draw = mountJet(kite);
const player = createPlayer({ reducedMotion: reduced.matches });
const director = createDirector({ player });
player.rest({ standing: false });
function frame(now) {
  director.tick(now);
  draw(player.frame, { unitPx: Math.max(kite.getBoundingClientRect().width / 200, 0.001) });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

reveal.append(icon('eye'));
reveal.addEventListener('click', () => {
  const showing = password.type === 'password';
  password.type = showing ? 'text' : 'password';
  const label = showing ? 'Hide password' : 'Show password';
  reveal.replaceChildren(icon(showing ? 'eyeOff' : 'eye'));
  reveal.setAttribute('aria-pressed', String(showing));
  reveal.setAttribute('aria-label', label);
  reveal.title = label;
  password.focus();
});

/** Shows `text` under the fields and marks the `invalid` ones. */
function showError(text, invalid = []) {
  error.textContent = text;
  for (const input of [email, password]) input.setAttribute('aria-invalid', String(invalid.includes(input)));
}
const clearError = () => { if (error.textContent) showError(''); };
email.addEventListener('input', clearError);
password.addEventListener('input', clearError);

function busy(on) {
  submit.disabled = on;
  submit.setAttribute('aria-busy', String(on));
  submitLabel.textContent = on ? 'Signing in…' : 'Sign in';
}

async function signIn() {
  let response;
  try {
    response = await fetch('/api/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    });
  } catch {
    return { ok: false, status: 0, kind: 'network' };
  }
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => ({}));
  return { ok: false, status: response.status, kind: body.kind, retryAfter: response.headers.get('Retry-After') };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const missing = !email.value.trim() ? email : !password.value ? password : null;
  if (missing) { showError('Enter your email and password.', [missing]); missing.focus(); return; }
  busy(true);
  const answer = await signIn();
  if (answer.ok) { location.replace(next); return; }
  busy(false);
  const { text, field } = refusalMessage(answer);
  showError(text, field === 'password' ? [email, password] : []);
  // The busy button lost the focus; it goes back to the password to type again, or to the button to try again.
  if (field === 'password') { password.focus(); password.select(); } else submit.focus();
});

function show() {
  page.dataset.state = 'ready';
  email.focus();
  setTimeout(() => director.hello(performance.now()), HELLO_AFTER_MS);
}

createSession({ fetch, signedOut: () => {} }).renew().then(() => location.replace(next), show);
