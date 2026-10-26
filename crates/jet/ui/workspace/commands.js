import { MODELS, effortsFor } from '../bridge/models.js';
import { requestJson } from '../bridge/browser-agent.js';

const HELP = [
  ['/model', '[model-id] — choose the model for the next reply'],
  ['/thinking', '[level] — choose thinking for the next reply'],
  ['/app add', '<address> ["label"] — register an app'],
  ['/app list', 'show registered apps and IDs'],
  ['/app open', '<id-or-label> — open an app'],
  ['/app edit', '[id-or-label] — show configuration and guidance for Jet'],
  ['/app reload', '[id-or-label] — reload its page with current endpoints'],
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

export function createCommands({ workspace, report, settings, save, changed = () => {}, request = requestJson }) {
  let pending = Promise.resolve();
  const help = () => HELP.map(([command, description]) => command + ' ' + description).join('\n');
  async function run(text) {
    try {
      const [root, ...args] = words(text);
      if (root === '/model' || root === '/thinking') {
        const modelCommand = root === '/model';
        const choices = modelCommand ? MODELS.map(([id]) => id) : effortsFor(settings.model);
        const key = modelCommand ? 'model' : 'effort';
        if (!args.length) { report(`Current ${modelCommand ? 'model' : 'thinking'}: ${settings[key]}\nValid choices: ${choices.join(', ')}`); return; }
        if (args.length !== 1 || !choices.includes(args[0])) throw new Error(`Choose a valid ${modelCommand ? 'model' : 'thinking level'}: ${choices.join(', ')}`);
        const candidate = { ...settings, [key]: args[0] };
        if (!effortsFor(candidate.model).includes(candidate.effort)) candidate.effort = 'high';
        await save(candidate);
        settings.model = candidate.model;
        settings.effort = candidate.effort;
        changed();
        report(`Saved. Next reply: ${settings.model} · ${settings.effort} thinking.`);
        return;
      }
      const action = root === '/tools' ? 'tools' : args.shift();
      if ((root !== '/app' && root !== '/tools') || (root === '/app' && action === 'tools') || !['add', 'list', 'open', 'edit', 'remove', 'enable', 'disable', 'reload', 'tools'].includes(action)) {
        report('Command help\n' + help()); return;
      }
      const limit = action === 'add' ? 2 : action === 'list' ? 0 : 1;
      if (args.length > limit) throw new Error('Too many arguments. Put labels with spaces in quotes.\n' + help());
      if (action === 'add') {
        if (!args.length) throw new Error('Use /app add <address> ["label"]. Example: /app add 8080 "Research notes".');
        const result = await request('/api/apps', { action, address: args[0], ...(args[1] ? { overrides: { label: args[1] } } : {}) });
        await workspace.refresh();
        report(saved(result)); return;
      }
      if (action === 'tools' && !args.length) { workspace.showTools(); return; }
      const apps = await request('/api/apps');
      if (action === 'list') { report(apps.length ? apps.map(app => `${app.label} — ${app.id}${app.enabled === false ? ' (disabled)' : ''}`).join('\n') : 'No apps registered. Use /app add.'); return; }
      const target = args[0] || (['edit', 'reload'].includes(action) ? workspace.activeAppId() : null);
      if (!target) throw new Error('Choose an app by ID or quoted label. Use /app list to see the choices.');
      const matches = apps.some(app => app.id === target) ? apps.filter(app => app.id === target) : apps.filter(app => app.label === target);
      if (matches.length !== 1) throw new Error(matches.length ? 'That label is ambiguous. Use an ID:\n' + matches.map(app => `${app.label} — ${app.id}`).join('\n') : `No registered app matches “${target}”. Use /app list.`);
      const app = matches[0];
      if (action === 'edit') { report(`${app.label} — ${app.id}\n${JSON.stringify(app, null, 2)}\nAsk Jet to change this app’s configuration.`); return; }
      if (action === 'reload') { await workspace.reloadApp(app.id); report('Reloaded ' + app.label + '.'); return; }
      if (action === 'tools') { workspace.showTools(app.id); return; }
      if (action === 'open') { await workspace.refresh(); workspace.openApp(app.id); report('Opened ' + app.label + '.'); return; }
      const result = await request('/api/apps', { action, id: app.id });
      await workspace.refresh();
      report(`${app.label}: ${result.change?.change ?? action}.`);
    } catch (error) { report(error.message ?? JSON.stringify(error)); }
  }
  return {
    submit(text, forward) {
      pending = pending.then(() => {
        if (text.trimStart().startsWith('/')) return run(text.trim());
        report('');
        forward(text);
      });
      return pending;
    },
    suggestions(text) {
      const prefix = text.trimStart();
      const argument = prefix.match(/^\/(model|thinking)\s+(.*)$/);
      if (argument) {
        const choices = argument[1] === 'model' ? MODELS.map(([id, label]) => [id, label]) : effortsFor(settings.model).map(level => [level, 'Thinking level']);
        return choices.filter(([id]) => id.startsWith(argument[2]) && id !== argument[2].trim()).map(([id, description]) => ({ value: `/${argument[1]} ${id}`, description }));
      }
      return prefix.startsWith('/') ? HELP.filter(([command]) => command.startsWith(prefix) && command !== prefix).map(([value, description]) => ({ value, description })) : [];
    },
  };
}

function saved(result) {
  const discovery = result.discovery;
  const detail = discovery && !['ready', 'available', 'found'].includes(discovery.status ?? discovery.kind) ? ` Discovery: ${discovery.message ?? discovery.reason ?? discovery.status ?? discovery.kind}.` : '';
  return `App saved: ${result.app.label} — ${result.app.id}.${detail}`;
}
