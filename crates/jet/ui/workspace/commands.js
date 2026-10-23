import { requestJson } from '../bridge/browser-agent.js';

const HELP = [
  ['/app add', '<address> ["label"] — register an app, or open the form'],
  ['/app list', 'show registered apps and IDs'],
  ['/app open', '<id-or-label> — open an app'],
  ['/app edit', '[id-or-label] — edit an app in the form'],
  ['/app remove', '<id-or-label> — forget an integration'],
  ['/app enable', '<id-or-label> — enable its tools'],
  ['/app disable', '<id-or-label> — disable its tools'],
  ['/tools', '[id-or-label] — browse tools'],
];

function words(text) {
  const result = [];
  let word = '', quote = null, started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\' && ['"', "'", '\\'].includes(text[index + 1])) { word += text[++index]; started = true; }
    else if (quote) { if (char === quote) quote = null; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { result.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (quote) throw new Error('Close the quoted argument before submitting.');
  if (started) result.push(word);
  return result;
}

export function createCommands({ workspace, report, request = requestJson }) {
  let pending = Promise.resolve();
  const help = () => HELP.map(([command, description]) => command + ' ' + description).join('\n');
  async function run(text) {
    try {
      const [root, ...args] = words(text);
      const action = root === '/tools' ? 'tools' : args.shift();
      if ((root !== '/app' && root !== '/tools') || (root === '/app' && action === 'tools') || !['add', 'list', 'open', 'edit', 'remove', 'enable', 'disable', 'tools'].includes(action)) {
        report('Command help\n' + help()); return;
      }
      const limit = action === 'add' ? 2 : action === 'list' ? 0 : 1;
      if (args.length > limit) throw new Error('Too many arguments. Put labels with spaces in quotes.\n' + help());
      if (action === 'add') {
        if (!args.length) { workspace.showAppForm(); return; }
        const result = await request('/api/apps', { action, address: args[0], ...(args[1] ? { overrides: { label: args[1] } } : {}) });
        await workspace.refresh();
        report(saved(result)); return;
      }
      if (action === 'tools' && !args.length) { workspace.showTools(); return; }
      const apps = await request('/api/apps');
      if (action === 'list') { report(apps.length ? apps.map(app => `${app.label} — ${app.id}${app.enabled === false ? ' (disabled)' : ''}`).join('\n') : 'No apps registered. Use /app add.'); return; }
      const target = args[0] || (action === 'edit' ? workspace.activeAppId() : null);
      if (!target) throw new Error('Choose an app by ID or quoted label. Use /app list to see the choices.');
      const matches = apps.some(app => app.id === target) ? apps.filter(app => app.id === target) : apps.filter(app => app.label === target);
      if (matches.length !== 1) throw new Error(matches.length ? 'That label is ambiguous. Use an ID:\n' + matches.map(app => `${app.label} — ${app.id}`).join('\n') : `No registered app matches “${target}”. Use /app list.`);
      const app = matches[0];
      if (action === 'edit') { workspace.showAppForm(app); return; }
      if (action === 'tools') { workspace.showTools(app.id); return; }
      if (action === 'open') { await workspace.refresh(); workspace.openApp(app.id); report('Opened ' + app.label + '.'); return; }
      const result = await request('/api/apps', { action, id: app.id });
      await workspace.refresh();
      report(`${app.label}: ${result.change?.change ?? action}.`);
    } catch (error) { report(error.message ?? JSON.stringify(error)); }
  }
  return {
    submit(text, forward) { if (text.trimStart().startsWith('/')) { pending = pending.then(() => run(text.trim())); return pending; } report(''); return forward(text); },
    suggestions(text) {
      const prefix = text.trimStart();
      return prefix.startsWith('/') ? HELP.filter(([command]) => command.startsWith(prefix) && command !== prefix).map(([value, description]) => ({ value, description })) : [];
    },
  };
}

function saved(result) {
  const discovery = result.discovery;
  const detail = discovery && !['ready', 'available', 'found'].includes(discovery.status ?? discovery.kind) ? ` Discovery: ${discovery.message ?? discovery.reason ?? discovery.status ?? discovery.kind}.` : '';
  return `App saved: ${result.app.label} — ${result.app.id}.${detail}`;
}
