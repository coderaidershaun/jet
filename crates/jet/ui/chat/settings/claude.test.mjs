import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, saveSettings } from '../../bridge/settings.js';
import { buildClaude } from './claude.js';

function fakeElement(tag) {
  return {
    tag, children: [], textContent: '', value: '', className: '', dataset: {},
    setAttribute() {}, addEventListener() {}, append(...nodes) { this.children.push(...nodes); },
  };
}
const walk = (el) => [el, ...el.children.flatMap(walk)];

const USER_SETTINGS = { reducedMotion: false, persona: { name: 'Jet', jobTitle: 'First-mate', notes: '' }, model: 'sonnet', effort: 'medium', turnBudgetUsd: 10 };

test('only an admin sees and sends the program paths, and a non-admin is told where Claude Code stands without one', async () => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = { createElement: fakeElement };
  try {
    for (const isAdmin of [true, false]) {
      const answer = isAdmin ? { ...USER_SETTINGS, claudePath: '/opt/claude', codexPath: null } : USER_SETTINGS;
      const program = isAdmin ? { provider: 'Claude Code', found: true, path: '/opt/claude' } : { provider: 'Claude Code', found: true };
      const sent = [];
      globalThis.fetch = async (path, init) => {
        if (init.method === 'PUT') sent.push(JSON.parse(init.body));
        return { ok: true, json: async () => answer };
      };
      const settings = await loadSettings({ isAdmin });
      const view = buildClaude({ settings, isAdmin, agent: { status: async () => ({ program }) }, changed() {}, onClaudeChecked() {}, onForget() {} });
      await view.refresh();
      const texts = view.el.flatMap(walk).map((node) => node.textContent);
      await saveSettings(settings);

      const paths = ['Path to claude', 'Path to codex'].filter((label) => texts.includes(label));
      const sentPaths = ['claudePath', 'codexPath'].filter((key) => key in sent[0]);
      if (isAdmin) {
        assert.deepEqual([paths.length, sentPaths.length, sent[0].claudePath], [2, 2, '/opt/claude']);
        assert.ok(texts.includes('Claude Code found at /opt/claude'));
      } else {
        assert.deepEqual([paths, sentPaths], [[], []]);
        assert.ok(texts.includes('Claude Code found'));
      }
    }
  } finally {
    Object.assign(globalThis, previous);
  }
});
