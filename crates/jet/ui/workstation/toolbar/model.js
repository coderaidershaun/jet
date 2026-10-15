// What the toolbar shows, worked out from the catalog and the view, so a test can check it
// without a page.

/** What stands where a value is not known yet. */
export const MISSING = '--';
const NOT_ARMED = { text: 'OFF', tone: 'text' };

/** Off comes in the plain text tone and is drawn grey with light text; an armed mode fills with its own colour under dark text. */
function badgeLook({ text, tone }) {
  return tone === 'text' ? { text, fill: 'border', ink: 'text' } : { text, fill: tone, ink: 'canvas' };
}

/**
 * @param {{ catalog?: import('../../bridge/workstation.js').CatalogLine, view?: import('../../bridge/workstation.js').ViewSection }} latest
 *   the newest `catalog` line and `view` section; either may not have arrived yet
 */
export function toolbarModel({ catalog, view }) {
  const instruments = (catalog?.instruments ?? []).map(({ id, display }) => ({ id, display }));
  const instrumentId = view?.instrument ?? null;
  return {
    instruments,
    instrumentId,
    instrumentText: instruments.find(({ id }) => id === instrumentId)?.display ?? MISSING,
    chartMode: view?.chartMode === 'candles' ? 'candles' : 'line',
    strategyId: catalog?.strategyId ?? '',
    badge: badgeLook(catalog?.badge ?? NOT_ARMED),
  };
}
