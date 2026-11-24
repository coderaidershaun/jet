import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardOf } from './model.js';
import { shareOf, sharedWords, tapAnswer, tapBody } from './share.js';

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
  for (const [input, line] of table) assert.equal(cardOf(call('people_update', { command: input }, result)).meta, line + ' · 0.3 s', input.action);
});
