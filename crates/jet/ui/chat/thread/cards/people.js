// How a people_update call reads: the typed command as one short line, with names taken from the
// directory the call gives back. Pure, with no DOM.

import { listOf, orNull, recordOf } from './guard.js';

const nameIn = (rows, id) => orNull(listOf(rows).map(recordOf).find((row) => row.id === id)?.name) ?? 'someone';
const quoted = (text) => '“' + text + '”';

const SAYINGS = {
  team_add: (input) => 'Created the team ' + quoted(orNull(input.name) ?? ''),
  team_rename: (input, { teams }) => 'Renamed a team to ' + quoted(nameIn(teams, input.team)),
  member_add: (input, { users, teams }) => 'Added ' + nameIn(users, input.user) + ' to ' + nameIn(teams, input.team),
  member_remove: (input, { users, teams }) => 'Removed ' + nameIn(users, input.user) + ' from ' + nameIn(teams, input.team),
  manager_set: (input, { users }) => nameIn(users, input.manager) + ' now manages ' + nameIn(users, input.user),
  manager_clear: (input, { users }) => nameIn(users, input.user) + ' has no manager now',
};

/** The line of one command, or null for a command this page does not know. */
export function peopleLine(input, result) {
  const command = recordOf(recordOf(input).command);
  if (!Object.hasOwn(SAYINGS, command.action)) return null;
  return SAYINGS[command.action](command, recordOf(result));
}
