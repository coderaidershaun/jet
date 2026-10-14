// The small lines of the pretend market and the tables they list: hello, link, lifecycle and
// catalog, built from plain values. The market decides the values; this file decides the shape.

import { FEATURE_NAMES } from './fake-market-rows.js';

export const TICK_GROUPINGS = [1, 2, 5, 10, 25, 50, 100].map((perBucket) => ({ perBucket, label: 'x' + perBucket }));
export const BPS_GROUPINGS = [[1, 100, '0.01 bp'], [1, 20, '0.05 bp'], [1, 10, '0.1 bp'], [1, 4, '0.25 bp'], [1, 2, '0.5 bp'], [1, 1, '1 bp'], [2, 1, '2 bp'], [5, 1, '5 bp']]
  .map(([numerator, denominator, label]) => ({ numerator, denominator, label }));
export const LEVELS = { min: 12, max: 30, default: 12 };
export const INSTRUMENTS = [
  { id: 0, display: 'BTCUSDT', base: 'BTC', quote: 'USDT', tick: '0.01', startBid: 11800000, position: 0.12, cash: 25000 },
  { id: 1, display: 'ETHUSDT', base: 'ETH', quote: 'USDT', tick: '0.01', startBid: 420000, position: 1.5, cash: 12000 },
];
export const SPIN_US = 1_000_000;

const CONNECTION_CHIPS = {
  connecting: { text: 'CONNECTING', tone: 'text2' },
  live: { text: 'LIVE', tone: 'positive' },
  stale: { text: 'STALE', tone: 'stale' },
};

export function helloLine() {
  return {
    kind: 'hello', protocol: 1, bridge: 'fake-workstation', polysim: 'fake', tickMs: 16,
    groupings: { ticks: TICK_GROUPINGS, bps: BPS_GROUPINGS },
    levels: LEVELS,
  };
}

/**
 * @param {{ peers: string[], peerIndex: number, session: number, connection: 'connecting' | 'live' | 'stale',
 *   phase: 'starting' | 'ready', running: boolean, control: { state: string, applied: boolean } | null }} state
 */
export function linkLine({ peers, peerIndex, session, connection, phase, running, control }) {
  const word = control ? control.state.toUpperCase() : '';
  const runChip = connection === 'connecting' ? { text: 'run --', tone: 'text2' } : running ? { text: 'run RUNNING', tone: 'positive' } : { text: 'run IDLE', tone: 'text2' };
  const controlChip = !control ? { text: 'control none', tone: 'text2' } : control.applied ? { text: 'applied ' + word, tone: 'positive' } : { text: 'asserting ' + word, tone: 'warning' };
  return {
    kind: 'link',
    peer: peers[peerIndex],
    peerIndex,
    peerCount: peers.length,
    session,
    chips: [
      { text: 'engine ' + peers[peerIndex] + (peers.length >= 2 ? ' [' + (peerIndex + 1) + '/' + peers.length + ']' : ''), tone: 'text' },
      CONNECTION_CHIPS[connection],
      { text: phase, tone: 'text2' },
      runChip,
      controlChip,
    ],
    peerClickable: peers.length >= 2,
    button: running ? { label: 'STOP', assert: 'idle' } : { label: 'START', assert: 'running' },
    connection,
  };
}

export function lifecycleLine({ session, phase }) {
  const starting = phase === 'starting';
  return {
    kind: 'lifecycle',
    session,
    screen: starting ? 'starting' : 'live',
    title: starting ? 'STARTING' : '',
    titleTone: 'text',
    detail: starting ? 'waiting for engine' : '',
    detailTone: 'text2',
  };
}

export function catalogLine({ session, strategyId, peer }) {
  return {
    kind: 'catalog',
    session,
    strategyId,
    title: 'Polysim - ' + strategyId + ' @ ' + peer,
    badge: { text: 'SIM', tone: 'warning' },
    spinIntervalUs: SPIN_US,
    instruments: INSTRUMENTS.map(({ id, display, base, quote, tick }) => ({ id, display, base, quote, tick })),
    featureNames: FEATURE_NAMES,
  };
}
