import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageState, drawerLayout, drawerOpens } from './page-state.js';

function pageState(saved = 'chat') {
  const events = { saved: [], shown: [] };
  const pages = createPageState({
    saved,
    save: (page) => events.saved.push(page),
    onShow: (page) => events.shown.push(page),
  });
  return { pages, events };
}

test('the page switches between the chat and the workstation, and a page already shown or not known changes nothing', () => {
  const { pages, events } = pageState();
  assert.equal(pages.current, 'chat');

  assert.equal(pages.show('workstation'), true);
  assert.equal(pages.current, 'workstation');
  assert.deepEqual(events.shown, ['workstation']);

  assert.equal(pages.show('workstation'), false, 'the page already shown');
  assert.equal(pages.show('settings'), false, 'a page that is not known');
  assert.equal(pages.show(undefined), false);
  assert.equal(pages.current, 'workstation');
  assert.deepEqual(events.shown, ['workstation'], 'nothing was announced again');

  assert.equal(pages.show('chat'), true);
  assert.deepEqual(events.shown, ['workstation', 'chat']);
});

test('Esc closes the open sheet first, then takes the workstation back to the chat, and otherwise leaves it to the composer', () => {
  const { pages } = pageState();
  assert.equal(pages.escape({ sheetOpen: false }), 'composer', 'on the chat the composer decides');
  assert.equal(pages.escape({ sheetOpen: true }), 'closeSheet');

  pages.show('workstation');
  assert.equal(pages.escape({ sheetOpen: true }), 'closeSheet', 'the sheet goes before the page');
  assert.equal(pages.escape({ sheetOpen: false }), 'showChat');

  pages.show('chat');
  assert.equal(pages.escape({ sheetOpen: false }), 'composer');
});

test('the page shown last is saved and opens again, and a saved page that is not known opens the chat', () => {
  const first = pageState();
  first.pages.show('workstation');
  first.pages.show('workstation');
  assert.deepEqual(first.events.saved, ['workstation'], 'a page already shown is not saved again');

  assert.equal(pageState(first.events.saved.at(-1)).pages.current, 'workstation', 'the next start opens where this one left off');

  first.pages.show('chat');
  assert.equal(pageState(first.events.saved.at(-1)).pages.current, 'chat');

  for (const saved of [undefined, null, '', 'lab', 7, 'toString']) {
    assert.equal(pageState(saved).pages.current, 'chat', `${String(saved)} opens the chat`);
  }
});

test('beside the workstation a wide drawer becomes the rail, and back on the chat it is docked as the user left it; a narrow drawer is the overlay on both pages', () => {
  // What the drawer looks like right after a page opens, before the user touches it.
  const settled = (state) => drawerLayout({ ...state, open: drawerOpens(state) });

  for (const [dockedPreference, docked] of [[true, 'open'], [false, 'closed']]) {
    assert.equal(settled({ page: 'workstation', dockedPreference, narrow: false }), 'rail', `a docked ${docked} drawer narrows to the rail`);
    assert.equal(settled({ page: 'chat', dockedPreference, narrow: false }), docked, `and is docked ${docked} again on the chat`);
  }

  for (const page of ['chat', 'workstation']) {
    assert.equal(settled({ page, dockedPreference: true, narrow: true }), 'closed', `the narrow overlay starts closed on the ${page} page`);
    assert.equal(drawerLayout({ page, open: true, narrow: true }), 'open', `and opens over the ${page} page when asked`);
  }
});
