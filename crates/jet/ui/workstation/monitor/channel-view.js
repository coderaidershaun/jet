// The channel tabs, the four row lists and the "N new" badge. Rows never change once built, so a
// frame adds only the rows that arrived, on top, and removes the oldest.

import { h } from '../../dom.js';
import { CHANNELS } from './channels.js';
import { badgeText, createFollowing } from './following.js';

const LABELS = { system: 'System', orders: 'Orders', trades: 'Pub trades', fills: 'Trade fills' };
const EMPTY_NOTES = { system: 'no system events', orders: 'no orders', trades: 'no public trades', fills: 'no fills' };

const setAttribute = (element, name, value) => {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
};

/** Each channel sends its own set of fields, so a row gets a part only for the fields it has. */
function buildRow(row) {
  const tag = row.tag;
  return h('div', { class: 'mon-row', title: row.detail },
    row.time !== undefined && h('span', { class: 'mon-time' }, row.time),
    tag?.liq && h('span', { class: 'mon-liq' }, tag.liq),
    tag?.side && h('span', { class: 'mon-side', 'data-tone': tag.tone }, tag.side),
    row.text !== undefined && h('span', { class: 'mon-text', 'data-tone': row.textTone }, row.text),
    row.price !== undefined && h('span', { class: 'mon-price' }, row.price),
    row.qty !== undefined && h('span', { class: 'mon-qty' }, row.qty));
}

/**
 * @param {ReturnType<typeof import('./channels.js').createChannelRings>} rings
 * @returns {{ tabs: HTMLElement, channels: HTMLElement, changed(): void, paint(): void }}
 *   `changed` says the rings have something new; `paint` writes only what is out of date
 */
export function createChannelView(rings) {
  const following = createFollowing(CHANNELS);
  let active = CHANNELS[0];
  let dirty = true;
  let jumpToTop = false;

  function jumpToNewest() {
    following.follow(active, rings.ring(active).appended);
    jumpToTop = true;
    dirty = true;
  }

  const badgeLabel = h('span');
  const badge = h('button', { class: 'mon-badge', type: 'button', title: 'jump to newest', hidden: true, onClick: jumpToNewest },
    h('span', { class: 'mon-badge-mark', 'aria-hidden': 'true' }), badgeLabel);

  /** Per channel: its tab, its list, and the epoch and newest row last put in the list. */
  const parts = new Map();
  for (const name of CHANNELS) {
    const tab = h('button', {
      class: 'mon-tab', type: 'button', role: 'tab', id: 'mon-tab-' + name, 'aria-controls': 'mon-list-' + name,
      onClick: () => { active = name; dirty = true; },
    }, LABELS[name]);
    const rows = h('div', { class: 'mon-rows' });
    const empty = h('p', { class: 'mon-empty' }, EMPTY_NOTES[name]);
    const list = h('div', {
      class: 'mon-list', id: 'mon-list-' + name, role: 'tabpanel', 'aria-labelledby': 'mon-tab-' + name, 'data-channel': name,
    }, rows, empty);
    list.addEventListener('scroll', () => {
      following.scrolled(name, list.scrollTop, rings.ring(name).appended);
      dirty = true;
    }, { passive: true });
    parts.set(name, { name, tab, list, rows, empty, painted: { epoch: -1, newest: null } });
  }

  const tabs = h('div', { class: 'mon-tabs', role: 'tablist', 'aria-label': 'Channels' }, ...[...parts.values()].map((part) => part.tab));
  const channels = h('div', { class: 'mon-channels' }, ...[...parts.values()].map((part) => part.list), badge);

  function replaceRows({ rows }, ring) {
    rows.replaceChildren(...ring.rows.map(buildRow));
  }

  /**
   * Puts the first `fresh` rows of the ring on top. The app's web view does not anchor scrolling
   * reliably, so for a reader who has scrolled away the list moves by the new rows' height instead.
   */
  function prependRows({ name, list, rows }, ring, fresh) {
    const anchor = rows.firstElementChild;
    const anchorTop = anchor ? anchor.offsetTop : 0;
    rows.prepend(...ring.rows.slice(0, fresh).map(buildRow));
    for (let excess = rows.childElementCount - ring.rows.length; excess > 0; excess -= 1) rows.lastElementChild.remove();
    if (following.isFollowing(name)) list.scrollTop = 0;
    else if (anchor) list.scrollTop += anchor.offsetTop - anchorTop;
  }

  function paintRows(part) {
    const { name, painted, list, empty } = part;
    const ring = rings.ring(name);
    if (ring.epoch !== painted.epoch) {
      replaceRows(part, ring);
      following.follow(name, ring.appended);
      list.scrollTop = 0;
    } else {
      const fresh = painted.newest === null ? ring.rows.length : ring.rows.indexOf(painted.newest);
      // More rows came in between two frames than a ring holds, so none of the old ones are left to build on.
      if (fresh === -1) replaceRows(part, ring);
      else if (fresh > 0) prependRows(part, ring, fresh);
    }
    painted.epoch = ring.epoch;
    painted.newest = ring.rows[0] ?? null;
    const hideNote = ring.rows.length > 0;
    if (empty.hidden !== hideNote) empty.hidden = hideNote;
  }

  function paintBadge() {
    const text = badgeText(following.unseen(active, rings.ring(active).appended));
    const hideBadge = text === '';
    if (badge.hidden !== hideBadge) badge.hidden = hideBadge;
    if (!hideBadge && badgeLabel.textContent !== text) badgeLabel.textContent = text;
  }

  return {
    tabs,
    channels,

    changed() {
      dirty = true;
    },

    paint() {
      if (!dirty) return;
      dirty = false;
      for (const part of parts.values()) {
        const shown = String(part.name === active);
        setAttribute(part.tab, 'aria-selected', shown);
        setAttribute(part.list, 'data-active', shown);
        paintRows(part);
      }
      if (jumpToTop) {
        parts.get(active).list.scrollTop = 0;
        jumpToTop = false;
      }
      paintBadge();
    },
  };
}
