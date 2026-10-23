const schema = { type: 'object', properties: {}, additionalProperties: false };

export function createDiscoveryFixture() {
  if (process.env.DISCOVERY_TEST !== '1') return null;
  const calls = [];
  const cancellations = [];
  const blocked = new Map();
  let mode = 'normal';
  let offline = false;
  let blockTool = null;
  const extra = [
    { name: 'paths', description: 'Free bounded path fixture.', inputSchema: { type: 'object', properties: { depth: { type: 'integer', minimum: 0 } }, required: ['depth'], additionalProperties: false }, _meta: { 'jet/discovery': { version: 1, entryArguments: { depth: 0 } } } },
    { name: 'search', description: 'Unmarked business operation. A read-only hint does not promise free discovery.', inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: 'future', description: 'Unsupported discovery marker.', inputSchema: schema, _meta: { 'jet/discovery': { version: 2, entryArguments: {} } } },
  ];
  const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  return {
    get offline() { return offline; },
    isError: name => name === 'collections' && mode === 'tool_error',
    list: tools => [...tools, ...extra],
    cancelled(params) { cancellations.push(params.requestId); },
    async call(name, args, id, normal) {
      calls.push({ name, arguments: args, id });
      if (blockTool === name) await new Promise(resolve => blocked.set(id, resolve));
      if (name === 'paths') return { version: 1, nodes: [{ label: 'Next ' + (args.depth + 1), kind: 'discover', tool: 'paths', arguments: { depth: args.depth + 1 } }] };
      if (name === 'search' || name === 'future') return { text: 'Business operation executed' };
      if (name !== 'collections' || mode === 'normal') return normal();
      if (mode === 'cycle') return { version: 1, nodes: [{ label: 'Again', kind: 'discover', tool: 'collections', arguments: {} }] };
      if (mode === 'invalid') return { version: 1, nodes: [{ label: 'Invalid arguments', kind: 'discover', tool: 'notes', arguments: { collection: 'missing' } }] };
      if (mode === 'unsupported') return { version: 1, nodes: [
        { label: 'Unknown tool', kind: 'discover', tool: 'absent', arguments: {} },
        { label: 'Unmarked business', kind: 'discover', tool: 'search', arguments: {} },
        { label: 'Future version', kind: 'discover', tool: 'future', arguments: {} },
        { label: 'Unknown kind', kind: 'future', tool: 'notes', arguments: {} },
      ] };
      if (mode === 'overflow') return { version: 1, nodes: Array.from({ length: 205 }, (_, n) => ({ label: 'Note ' + n, kind: 'tool', tool: 'read_note', arguments: { name: 'welcome' } })) };
      if (mode === 'raw') return { version: 99, payload: '🙂'.repeat(80000) };
      if (mode === 'error') throw new Error('Deliberate free discovery failure');
      return normal();
    },
    async handle(request, response) {
      const path = new URL(request.url, 'http://fixture').pathname;
      if (path === '/test/state') { json(response, 200, { calls, cancellations, blocked: [...blocked.keys()], mode, offline }); return true; }
      if (path !== '/test/control') return false;
      if (request.method !== 'POST') { json(response, 405, {}); return true; }
      let body = '';
      for await (const chunk of request) body += chunk;
      const command = JSON.parse(body);
      if ('mode' in command) mode = command.mode;
      if ('offline' in command) offline = command.offline;
      if ('blockTool' in command) blockTool = command.blockTool;
      if (command.release) { for (const release of blocked.values()) release(); blocked.clear(); }
      json(response, 200, {});
      return true;
    },
  };
}
