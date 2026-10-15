// The centre panel's account, summary and feature bands, built once and patched in place. A value
// is written only when it differs from what is on screen.

import { h } from '../../dom.js';
import { createChannelView } from './channel-view.js';
import { featureRow, sideRow, statusRow } from './cells.js';

const setAttribute = (element, name, value) => {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
};
const setText = (element, text) => {
  if (element.textContent !== text) element.textContent = text;
};
const setTone = (element, tone) => setAttribute(element, 'data-tone', tone);
const setTextTone = (element, { text, tone }) => {
  setText(element, text);
  setTone(element, tone);
};
function setFlag(element, name, on) {
  if (element.hasAttribute(name) !== on) {
    if (on) element.setAttribute(name, '');
    else element.removeAttribute(name);
  }
}

const micro = (text) => h('span', { class: 'mon-micro' }, text);
const accountRow = (extraClass, ...cells) => h('div', { class: 'mon-acc-row ' + extraClass }, ...cells);

/** Keeps the items in `list` and adds or removes them only at the end, so each item is reused by its index. */
function resize(list, parent, count, build) {
  while (list.length < count) {
    const item = build();
    list.push(item);
    parent.append(item.element);
  }
  while (list.length > count) list.pop().element.remove();
}

function createBalanceRow(extraClass) {
  const label = h('span');
  const free = h('span', { class: 'mon-num' });
  const locked = h('span', { class: 'mon-num', 'data-tone': 'text2' });
  const value = h('span', { class: 'mon-num' });
  return {
    element: accountRow(extraClass, label, free, locked, value),
    paint(balance) {
      setText(label, balance.label);
      setText(free, balance.free);
      setText(locked, balance.locked);
      setText(value, balance.value);
    },
  };
}

function createSideRow(name) {
  const leaked = h('span', { class: 'mon-leaked', 'data-tone': 'invalid' });
  const counts = ['open', 'inflt', 'lost'].map((tag) => ({ tag, number: h('span') }));
  return {
    element: accountRow('', h('span', { 'data-tone': 'text2' }, name, leaked),
      ...counts.map(({ tag, number }) => h('span', { class: 'mon-count' }, micro(tag), number))),
    paint(side) {
      const { leaked: marker, counts: shown } = sideRow(side);
      setText(leaked, marker);
      shown.forEach((count, index) => setTextTone(counts[index].number, count));
    },
  };
}

/** The last row holds both of its looks and a data attribute picks one, so a halt never needs a rebuild. */
function createStatusRow() {
  const reject = h('span', { class: 'mon-reject', 'data-tone': 'text2' });
  const gate = h('span', { class: 'mon-num', 'data-tone': 'text2' }, '--');
  const banner = h('div', { class: 'mon-halt', 'data-tone': 'invalid' });
  const element = accountRow('mon-acc-status', micro('reject'), reject, gate, banner);
  return {
    element,
    paint(account) {
      const status = statusRow(account);
      setFlag(element, 'data-halted', status.halted);
      if (status.halted) {
        setText(banner, status.banner);
      } else {
        setTextTone(reject, status.reject);
        setTextTone(gate, status.gate);
      }
    },
  };
}

function createAccountBand() {
  const notes = h('span', { class: 'mon-notes' });
  const noteItems = [];
  const captions = [0, 1, 2].map(() => h('span', { class: 'mon-micro mon-num' }));
  const base = createBalanceRow('');
  const quote = createBalanceRow('mon-acc-ruled');
  const bid = createSideRow('BID');
  const ask = createSideRow('ASK');
  const status = createStatusRow();
  const element = h('section', { class: 'mon-account' },
    accountRow('mon-acc-ruled', h('span', {}, micro('ACCOUNT'), notes), ...captions),
    base.element, quote.element, bid.element, ask.element, status.element);
  return {
    element,
    paint(account) {
      resize(noteItems, notes, account.notes.length, () => ({ element: micro('') }));
      account.notes.forEach((note, index) => setTextTone(noteItems[index].element, note));
      setText(captions[0], account.captions.free);
      setText(captions[1], account.captions.locked);
      setText(captions[2], account.captions.value);
      base.paint(account.base);
      quote.paint(account.quote);
      bid.paint(account.sides.bid);
      ask.paint(account.sides.ask);
      status.paint(account);
    },
  };
}

function createSummaryBand() {
  const cells = ['bid', 'mid', 'ask'].map((key) => {
    const caption = h('span', { class: 'mon-sum-caption' });
    const value = h('span', { class: 'mon-sum-value' });
    return { key, caption, value, element: h('div', { class: 'mon-sum-cell', 'data-cell': key }, caption, value) };
  });
  return {
    element: h('section', { class: 'mon-summary' }, ...cells.map((cell) => cell.element)),
    paint(summary) {
      for (const { key, caption, value, element } of cells) {
        setText(caption, summary.captions[key]);
        setTextTone(value, summary[key]);
        if (key !== 'mid') setAttribute(element, 'title', summary.hover);
      }
    },
  };
}

function createFeatureBand() {
  const rows = h('div', { class: 'mon-feature-rows' });
  const empty = h('p', { class: 'mon-empty' }, 'no features yet');
  const built = [];
  const buildRow = () => {
    const name = h('span', { class: 'mon-fname' });
    const value = h('span', { class: 'mon-fvalue' });
    return { element: h('div', { class: 'mon-feature' }, name, value), name, value };
  };
  return {
    element: h('div', { class: 'mon-features' }, rows, empty),
    paint(features) {
      resize(built, rows, features.length, buildRow);
      features.forEach((feature, index) => {
        const look = featureRow(feature);
        const { element, name, value } = built[index];
        setText(name, look.name);
        setText(value, look.value);
        setTone(value, look.valueTone);
        setAttribute(element, 'title', look.title);
        setFlag(element, 'data-changed', look.bar);
        setFlag(element, 'data-stale', look.dim);
      });
      if (empty.hidden !== (features.length > 0)) empty.hidden = features.length > 0;
    },
  };
}

/**
 * Builds the centre panel into `root`. `changed` says a band has a new value, and `paint` writes
 * what changed, once per animation frame.
 * @param {HTMLElement} root
 * @param {ReturnType<typeof import('./channels.js').createChannelRings>} rings
 */
export function createMonitorView(root, rings) {
  const bands = { account: createAccountBand(), summary: createSummaryBand(), features: createFeatureBand() };
  const channels = createChannelView(rings);
  root.replaceChildren(h('div', { class: 'mon' },
    bands.account.element, bands.summary.element, bands.features.element, channels.tabs, channels.channels));
  const dirty = new Set(Object.keys(bands));

  return {
    /** @param {'account' | 'summary' | 'features' | 'channels'} band */
    changed(band) {
      if (band === 'channels') channels.changed();
      else dirty.add(band);
    },

    /** @param {{ latest(name: string): any }} store */
    paint(store) {
      for (const name of dirty) {
        const value = store.latest(name);
        if (value !== undefined) bands[name].paint(value);
      }
      dirty.clear();
      channels.paint();
    },
  };
}
