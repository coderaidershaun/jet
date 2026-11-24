// The foot of the drawer says whose Jet this is and holds the way to sign out.

import { icon } from '../../dom.js';

const CONFIRM_MS = 4000;

/**
 * @param {{ user: { email: string, displayName: string }, announce: (message: string) => void }} options
 */
export function showAccount({ user, announce }) {
  const $ = (id) => document.getElementById(id);
  const name = user.displayName.trim() || user.email;
  $('account-mark').textContent = name.charAt(0).toUpperCase();
  $('account-name').textContent = name;
  $('account-email').textContent = user.email;
  $('account').title = `Signed in as ${name} (${user.email})`;
  $('account').hidden = false;
  const button = $('signout');
  button.append(icon('signOut'));
  // A stray tap must not end the session, so the first tap asks and only a second tap within a few seconds signs out.
  let asking = 0;
  const stopAsking = () => {
    clearTimeout(asking);
    asking = 0;
    button.classList.remove('is-confirming');
    button.replaceChildren(icon('signOut'));
    button.setAttribute('aria-label', 'Sign out');
  };
  button.addEventListener('blur', () => { if (asking) stopAsking(); });
  button.addEventListener('click', async () => {
    if (!asking) {
      asking = setTimeout(stopAsking, CONFIRM_MS);
      button.classList.add('is-confirming');
      button.textContent = 'Sign out?';
      button.setAttribute('aria-label', 'Sign out now');
      return;
    }
    stopAsking();
    button.disabled = true;
    try {
      const response = await fetch('/api/auth/signout', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      location.assign('/signin/');
    } catch (error) {
      console.warn('signing out failed:', error);
      announce('Jet could not sign you out. Check the connection and try again.');
      button.disabled = false;
    }
  });
}
