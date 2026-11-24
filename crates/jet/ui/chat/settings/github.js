// The signed-in user's GitHub token, for private repositories. It goes only to
// its own endpoint, never into the shared settings, and the server never sends it back.

import { requestJson } from '../../bridge/browser-agent.js';
import { h } from '../../dom.js';
import { button, note, section } from './controls.js';

const TOKEN_PATH = '/api/github/token';

/** @param {{ fetch?: typeof globalThis.fetch }} ctx   the sheet's context; only a test passes `fetch` */
export function buildGithub({ fetch: fetcher = globalThis.fetch } = {}) {
  let saved = false;
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const status = h('span', { class: 'status', role: 'status' });
  const problem = h('p', { class: 'problem', role: 'alert' });
  const save = button('Save');
  const remove = button('Remove');

  const paint = () => {
    status.textContent = saved ? 'Saved' : 'Not saved';
    input.placeholder = saved ? 'Paste a new token to replace it' : 'Paste a token';
    save.disabled = input.value.trim() === '';
    remove.hidden = !saved;
  };
  const ask = async (method, body) => {
    try {
      saved = (await requestJson(TOKEN_PATH, body, method, fetcher)).saved === true;
      problem.textContent = '';
      return true;
    } catch (error) {
      problem.textContent = 'GitHub token: ' + (error?.message ?? String(error));
      return false;
    } finally {
      paint();
    }
  };

  input.addEventListener('input', paint);
  save.addEventListener('click', async () => {
    if (await ask('PUT', { token: input.value })) input.value = '';
    paint();
  });
  remove.addEventListener('click', () => ask('DELETE'));
  paint();
  ask('GET');

  const field = h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'GitHub token' }), input);
  return section('github', 'GitHub', note('Needed only for private repositories. Jet keeps it for your account and never shows it again.'),
    field, h('div', { class: 'row-actions' }, save, remove, status), problem);
}
