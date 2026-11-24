import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardOf } from './model.js';
import { directoryView, shareButton, shareOf, sharedWords, tapAnswer, tapBody } from './share.js';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/share-card.json', import.meta.url), 'utf8'));
const call = (tool, input, result) => ({ id: 'c1', server: 'jet', tool, input, ok: true, result, durationMs: 300 });

test('a proposed share card offers its ticks and sends exactly the ticked ones', () => {
  const card = cardOf(call('objectives_update', { action: 'propose_share' }, { proposal: fixture.proposed }));
  assert.equal(card.body.kind, 'share');
  const view = card.body.view;
  assert.equal(view.state, 'proposed');
  assert.deepEqual(view.entries.map((entry) => [entry.key, entry.ticked]), [['t1', true], ['p2', false]]);
  assert.deepEqual(tapBody(view, new Set(['t1'])), { people: [], teams: [1] });
  assert.deepEqual(tapBody(view, new Set(['t1', 'p2'])), { people: [2], teams: [1] });
});

test('an applied card says who it is shared with and a refused one is drawn without a tap', () => {
  const applied = shareOf(fixture.applied);
  assert.equal(sharedWords(applied), 'Shared with bob@example.com');
  assert.equal(sharedWords(shareOf({ ...fixture.proposed, people: [] })), 'Shared with the Commercial team (Cat)');
  assert.equal(shareOf(fixture.refused).state, 'refused');
  assert.equal(shareOf({ state: 'nonsense', id: 1 }), null);
});

test('the pane card lists the whole directory, and its button says what the tap will do', () => {
  const view = directoryView({ id: 1, title: 'Ship the kite' }, fixture.directory);
  assert.deepEqual(view.entries.map((entry) => [entry.key, entry.shared]), [['t1', false], ['p2', true], ['p3', false]]);
  const button = (keys) => shareButton(view, new Set(keys));
  assert.deepEqual(button(['p2']), { words: 'Share', enabled: false }, 'nothing would change');
  assert.deepEqual(button(['p2', 'p3']), { words: 'Share', enabled: true });
  assert.deepEqual(button(['p3']), { words: 'Share', enabled: true }, 'it adds as well as removes');
  assert.deepEqual(button(['t1', 'p2']).words, 'Share');
  const shared = directoryView({ id: 1 }, { ...fixture.directory, teams: [{ ...fixture.directory.teams[0], ticked: true }] });
  assert.deepEqual(shareButton(shared, new Set(['t1'])), { words: 'Save who sees it', enabled: true }, 'it only removes');
  assert.deepEqual(button([]), { words: 'Stop sharing', enabled: true });
  const nobody = directoryView({ id: 1 }, { people: [{ id: 3, name: 'Cat', ticked: false }], teams: [] });
  assert.deepEqual(shareButton(nobody, new Set()), { words: 'Share', enabled: false }, 'nothing shared and nothing ticked');
});

test("Jet's card cannot tell who of its ticks sees it now, so it offers Share, or Stop sharing with no tick", () => {
  const card = shareOf({ ...fixture.proposed, people: [{ id: 2, name: 'Admin 123', ticked: true }] });
  assert.deepEqual(shareButton(card, new Set(['p2'])), { words: 'Share', enabled: true });
  assert.deepEqual(shareButton(card, new Set()), { words: 'Stop sharing', enabled: true });
});

test('a refused tap says why, and a used card is read again', () => {
  assert.deepEqual(tapAnswer({ kind: 'proposalNotOpen', message: 'x' }), { words: 'This card was already used or replaced.', reread: true });
  assert.equal(tapAnswer({ kind: 'network', message: 'offline' }).reread, false);
  assert.match(tapAnswer({ kind: 'network' }).words, /Nothing was shared/);
});

test('each people_update command reads as one short line', () => {
  const result = { users: [{ id: 2, name: 'Admin 123' }, { id: 3, name: 'Admin 1' }], teams: [{ id: 1, name: 'Commercial', memberIds: [2] }] };
  const table = [
    [{ action: 'team_add', name: 'Commercial' }, 'Created the team “Commercial”'],
    [{ action: 'team_rename', team: 1, name: 'Commercial' }, 'Renamed a team to “Commercial”'],
    [{ action: 'member_add', team: 1, user: 2 }, 'Added Admin 123 to Commercial'],
    [{ action: 'member_remove', team: 1, user: 3 }, 'Removed Admin 1 from Commercial'],
    [{ action: 'manager_set', user: 3, manager: 2 }, 'Admin 123 now manages Admin 1'],
    [{ action: 'manager_clear', user: 3 }, 'Admin 1 has no manager now'],
  ];
  for (const [input, line] of table) assert.equal(cardOf(call('people_update', { command: input }, result)).meta, line, input.action);
});
