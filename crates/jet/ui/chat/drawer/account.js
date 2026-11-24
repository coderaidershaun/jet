// The foot of the drawer says whose Jet this is and holds the way to sign out.

import { icon } from '../../dom.js';

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
  button.addEventListener('click', async () => {
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
