// A polysim engine listing in the shape polysim-mcp sends: every field is present and is
// null when it does not apply. The four engines are made up so that every state and mode
// the engine card draws shows once: running in sim, stopped and off, stopped and live, and
// an engine whose config cannot be read.
export const POLYSIM_ENGINES = {
  use: { id: 'toolu_fake_engines', name: 'mcp__polysim__list_strategies', input: {} },
  reply: 'Here are your engines. One runs in sim; start or stop any of them from the card.',
  result: {
    engines: [
      {
        strategy_id: 'strat-micro-recorder',
        te_id: 'te-binance-spot-btcusdt',
        bin: 'strat-micro-recorder-te-binance-spot-btcusdt',
        mode: 'sim',
        state: 'running',
        pid: 48213,
        started_at: '2026-10-14T21:30:12.123456Z',
        exit_code: null,
        console_log: '/Users/shaun/Code/DEVELOPMENT/polysim/logs/strat-micro-recorder-te-binance-spot-btcusdt-sim-console.log',
        link_bind: '127.0.0.1:9310',
        config_error: null,
      },
      {
        strategy_id: 'strat-micro-recorder',
        te_id: 'te-polymarket-btc-updown-5m',
        bin: 'strat-micro-recorder-te-polymarket-btc-updown-5m',
        mode: 'off',
        state: 'stopped',
        pid: null,
        started_at: null,
        exit_code: null,
        console_log: null,
        link_bind: '127.0.0.1:9311',
        config_error: null,
      },
      {
        strategy_id: 'strat-maker',
        te_id: 'te-binance-spot-ethusdt',
        bin: 'strat-maker-te-binance-spot-ethusdt',
        mode: 'live',
        state: 'stopped',
        pid: null,
        started_at: null,
        exit_code: null,
        console_log: null,
        link_bind: '127.0.0.1:9312',
        config_error: null,
      },
      {
        strategy_id: 'strat-maker',
        te_id: 'te-polymarket-eth-updown-5m',
        bin: 'strat-maker-te-polymarket-eth-updown-5m',
        mode: 'unreadable',
        state: 'exited',
        pid: null,
        started_at: null,
        exit_code: 101,
        console_log: null,
        link_bind: null,
        config_error: 'execution.mode: unknown variant `paper`, expected one of `off`, `sim`, `live`',
      },
    ],
  },
};
