// Starts the workstation on its own page, so it can be tried in a plain browser (on the pretend
// feed) or in the app's window (on polysim-bridge), without the chat around it.

import { connectWorkstation } from '../bridge/workstation.js';
import { loadSettings } from '../bridge/settings.js';
import { createWorkstation, mountAreas } from './page.js';

async function start() {
  const settings = await loadSettings();
  const store = createWorkstation({ root: document.getElementById('workstation'), feed: connectWorkstation() });
  await mountAreas(store);
  await store.start(settings.workstation);
}

start().catch((error) => {
  console.error(error);
  const note = document.createElement('p');
  note.className = 'ws-dump';
  note.textContent = 'The workstation could not start: ' + (error && error.message ? error.message : error);
  document.body.append(note);
});
