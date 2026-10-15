import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolbarModel } from './model.js';

const catalog = (changes = {}) => ({
  kind: 'catalog', strategyId: 'mm-1', badge: { text: 'SIM', tone: 'warning' },
  instruments: [{ id: 0, display: 'BTCUSDT', base: 'BTC' }, { id: 7, display: 'ETHUSDT', base: 'ETH' }], ...changes,
});

test("the toolbar lists the catalog's instruments, follows the view, and colours the execution badge like the desktop app", () => {
  assert.deepEqual(
    toolbarModel({ catalog: undefined, view: undefined }),
    {
      instruments: [], instrumentId: null, instrumentText: '--', chartMode: 'line', strategyId: '',
      badge: { text: 'OFF', fill: 'border', ink: 'text' },
    },
    'before a catalog nothing has claimed to be armed, which reads as off',
  );

  const shown = toolbarModel({ catalog: catalog(), view: { instrument: 7, chartMode: 'candles' } });
  assert.deepEqual(shown.instruments, [{ id: 0, display: 'BTCUSDT' }, { id: 7, display: 'ETHUSDT' }], 'only the id and the name are kept');
  assert.equal(shown.instrumentId, 7);
  assert.equal(shown.instrumentText, 'ETHUSDT', 'the view picks the instrument shown');
  assert.equal(shown.chartMode, 'candles');
  assert.equal(shown.strategyId, 'mm-1');
  assert.deepEqual(shown.badge, { text: 'SIM', fill: 'warning', ink: 'canvas' }, 'sim is a warning fill with canvas ink');

  const live = toolbarModel({ catalog: catalog({ badge: { text: 'LIVE', tone: 'negative' } }), view: undefined });
  assert.deepEqual(live.badge, { text: 'LIVE', fill: 'negative', ink: 'canvas' }, 'live is a negative fill with canvas ink');
  const off = toolbarModel({ catalog: catalog({ badge: { text: 'OFF', tone: 'text' } }), view: undefined });
  assert.deepEqual(off.badge, { text: 'OFF', fill: 'border', ink: 'text' }, 'off is a border fill with primary ink');

  const withoutView = toolbarModel({ catalog: catalog(), view: undefined });
  assert.equal(withoutView.chartMode, 'line', 'line is the default chart mode');
  assert.equal(withoutView.instrumentText, '--', 'no view, no instrument');
  assert.equal(toolbarModel({ catalog: catalog(), view: { instrument: 99, chartMode: 'line' } }).instrumentText, '--', 'an id the catalog lacks shows nothing');
  const withoutCatalog = toolbarModel({ catalog: undefined, view: { instrument: 0, chartMode: 'candles' } });
  assert.equal(withoutCatalog.instrumentText, '--', 'a view before the catalog cannot name its instrument');
  assert.equal(withoutCatalog.chartMode, 'candles', 'but the chart mode still follows it');
  assert.deepEqual(toolbarModel({ catalog: catalog({ instruments: undefined }), view: undefined }).instruments, [], 'a catalog without instruments lists none');
});
