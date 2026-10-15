// The workstation page's one way to polysim-bridge, and the one JavaScript definition of what the
// bridge says. Every other module is handed a WorkstationFeed and never asks which one it is.
// Inside Tauri it is the real feed, which runs polysim-bridge and streams its lines; in a plain
// browser it is the pretend feed, which makes up plausible lines in the same shape.
//
// Geometry travels as small integers (half-ticks, tick indexes, bucket indexes, mantissas) and
// every string the page shows arrives already formatted, with a tone word the CSS maps to a colour.

import { createFakeWorkstation } from './fake-workstation.js';
import { createTauriWorkstation } from './tauri-workstation.js';

/** @typedef {'text' | 'text2' | 'bid' | 'ask' | 'sellFill' | 'positive' | 'negative' | 'warning' | 'invalid' | 'stale' | 'selected' | 'focus' | 'canvas'} Tone */
/** @typedef {{ text: string, tone: Tone }} TextTone */

/**
 * What the user set up for the workstation, as the settings store it.
 * @typedef {object} WorkstationSettings
 * @property {string | null} bridgePath   null = not set up
 * @property {string | null} polysimDir   null = the folder that holds the program
 * @property {string} strategyId
 * @property {string[]} links   `host:port` of each trading engine, in the order the link bar steps through them
 * @property {string | null} token
 */

/**
 * The first line of every run. `groupings` are the choices for the ladder's grouping control.
 * @typedef {object} HelloLine
 * @property {'hello'} kind
 * @property {number} protocol
 * @property {string} bridge
 * @property {string} polysim
 * @property {number} tickMs
 * @property {{ ticks: { perBucket: number, label: string }[], bps: { numerator: number, denominator: number, label: string }[] }} groupings
 * @property {{ min: number, max: number, default: number }} levels
 */

/**
 * The link bar: which trading engine, in what state. Sent when it changes.
 * @typedef {object} LinkLine
 * @property {'link'} kind
 * @property {string} peer
 * @property {number} peerIndex
 * @property {number} peerCount
 * @property {number} session   the engine link's session, not the chat's
 * @property {TextTone[]} chips   engine, connection, phase, run, control, in this order
 * @property {boolean} peerClickable
 * @property {{ label: string, assert: 'running' | 'idle' }} button   the label is the next assertion
 * @property {'connecting' | 'live' | 'stale'} connection
 */

/**
 * Which screen the workstation shows. Sent when it changes; back to `starting` on a session change.
 * @typedef {object} LifecycleLine
 * @property {'lifecycle'} kind
 * @property {number} session
 * @property {'starting' | 'live' | 'draining' | 'stopped'} screen
 * @property {string} title
 * @property {Tone} titleTone
 * @property {string} detail
 * @property {Tone} detailTone
 */

/**
 * @typedef {object} Instrument
 * @property {number} id
 * @property {string} display
 * @property {string} base
 * @property {string} quote
 * @property {string | null} tick   decimal price step, such as "0.01"; null = no tick grid
 */

/**
 * What the session is about. Sent at the start, on a session change and after a resync.
 * @typedef {object} CatalogLine
 * @property {'catalog'} kind
 * @property {number} session
 * @property {string} strategyId
 * @property {string} title
 * @property {TextTone} badge   the execution badge
 * @property {number} spinIntervalUs   one chart bucket
 * @property {Instrument[]} instruments
 * @property {string[]} featureNames
 */

/**
 * The chart, the ladder and the monitor follow what the user chose.
 * @typedef {object} ViewSection
 * @property {number} instrument
 * @property {'line' | 'candles'} chartMode
 * @property {'ticks' | 'bps'} domUnit
 * @property {{ unit: 'ticks', perBucket: number, label: string } | { unit: 'bps', numerator: number, denominator: number, label: string }} domGrouping
 * @property {number} domLevels
 * @property {'exposure' | 'pnl'} riskSeries
 */

/**
 * One level of the ladder. `tick` and `price` are the level's nearest tick, `public` the market's size there.
 * @typedef {object} LadderRow
 * @property {number} tick
 * @property {string} price
 * @property {string | null} public
 * @property {{ qty: string, word: 'live' | 'sent' | 'lost', tone: Tone } | null} order
 * @property {string | null} want
 * @property {'confirmed' | 'inflight' | 'lost' | 'desired' | null} ring
 */

/**
 * A full snapshot. `asks` and `bids` are `rows` long, index 0 nearest the mid.
 * @typedef {object} LadderSection
 * @property {'live' | 'stale' | 'awaiting' | 'disconnected'} status
 * @property {TextTone | null} pill
 * @property {boolean} muted
 * @property {TextTone} mid
 * @property {number} midHalfTicks   best bid tick + best ask tick
 * @property {number} ticksPerBucket
 * @property {number} rows
 * @property {LadderRow[]} asks
 * @property {LadderRow[]} bids
 * @property {{ up: { text: string } | null, down: { text: string } | null }} chevrons   a quote off the rows
 */

/**
 * A full snapshot.
 * @typedef {object} SummarySection
 * @property {{ bid: string, mid: string, ask: string }} captions
 * @property {TextTone} bid
 * @property {TextTone} mid
 * @property {TextTone} ask
 * @property {string} hover
 */

/** @typedef {{ label: string, free: string, locked: string, value: string }} AccountBalance */
/** @typedef {{ open: number, inflight: number, lost: number, leaked: number }} AccountSide */

/**
 * A full snapshot.
 * @typedef {object} AccountSection
 * @property {TextTone[]} notes
 * @property {{ free: string, locked: string, value: string }} captions
 * @property {AccountBalance} base
 * @property {AccountBalance} quote
 * @property {{ bid: AccountSide, ask: AccountSide }} sides
 * @property {'armed' | 'halted' | null} gate
 * @property {string | null} haltReason
 * @property {TextTone} reject
 */

/** @typedef {{ name: string, value: string, changed: boolean, stale: boolean, hover: string }} FeatureRow   a full snapshot is an array of these */

/** @typedef {{ side: 'BUY' | 'SELL', tone: Tone }} SideTag */
/** @typedef {{ time: string, text: string, textTone: Tone, detail: string }} SystemRow */
/** @typedef {{ time: string, tag: SideTag, text: string, textTone: Tone, detail: string }} OrderRow */
/** @typedef {{ time: string, tag: SideTag, price: string, qty: string, detail: string }} TradeRow */
/** @typedef {{ time: string, tag: SideTag & { liq: 'mkr' | 'tkr' }, price: string, qty: string, detail: string }} FillRow */

/**
 * Each channel holds only the rows newer than the last `appended` the page saw, newest first, or
 * the newest 256 after a generation or instrument change. The page keeps a 256-row ring per channel.
 * @typedef {object} ChannelsSection
 * @property {{ appended: number, rows: SystemRow[] }} [system]
 * @property {{ appended: number, rows: OrderRow[] }} [orders]
 * @property {{ appended: number, rows: TradeRow[] }} [trades]
 * @property {{ appended: number, rows: FillRow[] }} [fills]
 */

/**
 * A full snapshot. Each cell is a text with a tone.
 * @typedef {object} LatencySection
 * @property {string} header
 * @property {string[]} columns
 * @property {{ label: string, cells: TextTone[] }[]} rows
 */

/**
 * One chart bucket: open, high, low, close in half-ticks, the close as text, the open time as text.
 * A bucket always has all its prices. `gap` means the book lost snapshots before this bucket, so
 * the line breaks there.
 * @typedef {{ i: number, o: number, h: number, l: number, c: number, cl: string, t: string, gap: boolean }} ChartBucket
 */
/** @typedef {{ i: number, ht: number, side: 'buy' | 'sell' }} ChartFill */

/**
 * A delta: `buckets` and `fills` hold only what is new plus the open bucket, or the whole window
 * when `generation` changed. Bucket `i` counts spin intervals since the Unix epoch, UTC.
 * @typedef {object} ChartSection
 * @property {number} generation
 * @property {number} capacity
 * @property {number} first   the visible window
 * @property {number} last
 * @property {number} low
 * @property {number} high
 * @property {{ v: number, label: string }[]} axis   empty until the page sends `chart_ticks`
 * @property {ChartBucket[]} buckets
 * @property {ChartFill[]} fills
 * @property {string | null} note
 * @property {boolean} fillsCaption
 */

/** @typedef {{ i: number, e: number, p: number, el: string, pl: string }} RiskBucket   exposure and pnl as mantissas times 1e8, and as text */
/** @typedef {{ low: number, high: number }} RiskBounds */
/** @typedef {{ v: number, label: string }[]} RiskAxis */

/**
 * A delta like the chart, with the chart's generation. The whole window is sent after a generation
 * change, a series change and a change of instrument.
 * @typedef {object} RiskSection
 * @property {number} generation
 * @property {'exposure' | 'pnl'} series
 * @property {TextTone | null} latest
 * @property {{ exposure: RiskBounds, pnl: RiskBounds }} bounds
 * @property {{ exposure: RiskAxis, pnl: RiskAxis }} axis
 * @property {RiskBucket[]} buckets
 * @property {string | null} note
 */

/** @typedef {{ books: number, events: number }} GapsSection   lines the bridge had to drop */

/**
 * Sections are present only when they changed. They always come in this order: view, ladder,
 * summary, account, features, channels, latency, chart, risk, gaps.
 * @typedef {object} TickLine
 * @property {'tick'} kind
 * @property {number} session
 * @property {number} seq
 * @property {ViewSection} [view]
 * @property {LadderSection} [ladder]
 * @property {SummarySection} [summary]
 * @property {AccountSection} [account]
 * @property {FeatureRow[]} [features]
 * @property {ChannelsSection} [channels]
 * @property {LatencySection} [latency]
 * @property {ChartSection} [chart]
 * @property {RiskSection} [risk]
 * @property {GapsSection} [gaps]
 */

/** @typedef {{ kind: 'bye', reason: string }} ByeLine */

/**
 * Jet's own line, not the bridge's: `starting` before each run, `restarting` when a run ended and
 * will be started again, `exited` when the bridge speaks another protocol or keeps failing at
 * once, so it is not started again, `missing` when the program is not there. A deliberate stop
 * sends none.
 * @typedef {{ kind: 'bridge', status: 'starting' | 'restarting' | 'exited' | 'missing', detail: string }} BridgeStatusLine
 */

/** @typedef {HelloLine | LinkLine | LifecycleLine | CatalogLine | TickLine | ByeLine | BridgeStatusLine} BridgeLine */

/**
 * What the page asks of the bridge, one object per line on the bridge's stdin. A bridge ignores a
 * command it does not know.
 * @typedef {{ cmd: 'select', instrument: number }
 *   | { cmd: 'chart_mode', mode: 'line' | 'candles' }
 *   | { cmd: 'dom_unit', unit: 'ticks' | 'bps' }
 *   | { cmd: 'dom_grouping', unit: 'bps', numerator: number, denominator: number }
 *   | { cmd: 'dom_grouping', unit: 'ticks', perBucket: number }
 *   | { cmd: 'dom_levels', levels: number }
 *   | { cmd: 'dom_fit', rows: number }
 *   | { cmd: 'chart_ticks', mid: number, risk: number }
 *   | { cmd: 'risk_series', series: 'exposure' | 'pnl' }
 *   | { cmd: 'assert', state: 'running' | 'idle' }
 *   | { cmd: 'next_peer' }
 *   | { cmd: 'resync' }
 *   | { cmd: 'pause' }
 *   | { cmd: 'resume' }} BridgeCommand
 */

/**
 * @typedef {object} WorkstationFeed
 * @property {(workstation: WorkstationSettings, onLine: (line: BridgeLine) => void) => Promise<void>} start
 *   starts the feed, or starts it again when it runs; lines arrive on `onLine` as parsed objects, in order.
 *   Inside the app, a bridge already running from the same settings is kept, and its opening lines are sent again.
 * @property {(command: BridgeCommand) => Promise<void>} command   rejects { kind: 'io', message } when the feed is not running
 * @property {() => Promise<void>} stop   no line arrives after it resolves
 */

/** @returns {WorkstationFeed} */
export function connectWorkstation() {
  const tauri = globalThis.window?.__TAURI__;
  return tauri ? createTauriWorkstation(tauri) : createFakeWorkstation();
}
