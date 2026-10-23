import http from "node:http";
import { readFile } from "node:fs/promises";
import { createDiscoveryFixture } from "./discovery.mjs";

const discovery = createDiscoveryFixture();

const tools = [
  { name: "collections", description: "Browse fixture collections without side effects.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, _meta: { "jet/discovery": { version: 1, entryArguments: {} } } },
  { name: "notes", description: "Browse notes in a fixture collection.", inputSchema: { type: "object", properties: { collection: { type: "string", enum: ["examples"] } }, required: ["collection"], additionalProperties: false }, _meta: { "jet/discovery": { version: 1 } } },
  { name: "read_note", description: "Read a fixture note.", inputSchema: { type: "object", properties: { name: { type: "string", enum: ["welcome"] } }, required: ["name"], additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function toolResult(name, args) {
  if (name === "collections" && Object.keys(args).length === 0) {
    return { version: 1, nodes: [{ label: "Examples", kind: "discover", tool: "notes", arguments: { collection: "examples" } }] };
  }
  if (name === "notes" && args.collection === "examples" && Object.keys(args).length === 1) {
    return { version: 1, nodes: [{ label: "Welcome note", kind: "tool", tool: "read_note", arguments: { name: "welcome" } }] };
  }
  if (name === "read_note" && args.name === "welcome" && Object.keys(args).length === 1) {
    return { text: "Hello from the fixture" };
  }
  throw new Error("Unknown fixture tool or invalid arguments");
}

const mcp = http.createServer(async (request, response) => {
  if (discovery?.offline) return json(response, 503, { error: "fixture offline" });
  if (request.url !== "/mcp") return json(response, 404, { error: "not found" });
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    return response.end();
  }
  let message;
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 65536) return json(response, 413, { error: "request too large" });
    }
    message = JSON.parse(body);
    if (!Object.hasOwn(message, "id")) {
      if (message.method === "notifications/cancelled") discovery?.cancelled(message.params);
      response.writeHead(202);
      return response.end();
    }
    let result;
    switch (message.method) {
      case "initialize": result = { protocolVersion: "2025-11-25", serverInfo: { name: "fixture-notebook", version: "1.0.0" }, capabilities: { tools: {} }, instructions: "Use collections to browse examples, or inspect read_note before calling it." }; break;
      case "ping": result = {}; break;
      case "tools/list": result = { tools: discovery?.list(tools) ?? tools }; break;
      case "tools/call": {
        const name = message.params.name, args = message.params.arguments ?? {};
        const structuredContent = discovery ? await discovery.call(name, args, message.id, () => toolResult(name, args)) : toolResult(name, args);
        result = { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: discovery?.isError(name) ?? false };
        break;
      }
      default: return json(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
    json(response, 200, { jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    json(response, 200, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32602, message: error.message } });
  }
});

await new Promise(resolve => mcp.listen(Number(process.env.MCP_PORT ?? 0), "127.0.0.1", resolve));
const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
const ui = http.createServer(async (request, response) => {
  if (await discovery?.handle(request, response)) return;
  const path = new URL(request.url, "http://fixture").pathname;
  if (path === "/jet-app.json") return json(response, 200, { version: 1, name: "Fixture notebook", ui: "./", mcp: mcpUrl, embedding: "relative-paths" });
  if (path === "/api/message") return json(response, 200, { text: "Independent app API works" });
  if (path === "/download") {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=fixture.bin" });
    return response.end(Buffer.from([0, 1, 127, 128, 255]));
  }
  if (path === "/" || path === "/app.js") {
    try {
      const asset = path === "/" ? "index.html" : "app.js";
      response.writeHead(200, { "Content-Type": path === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" });
      response.end(await readFile(new URL(asset, import.meta.url)));
    } catch { response.end(); }
    return;
  }
  json(response, 404, { error: "not found" });
});
await new Promise(resolve => ui.listen(Number(process.env.UI_PORT ?? 0), "127.0.0.1", resolve));
console.log(JSON.stringify({ ui: `http://127.0.0.1:${ui.address().port}/`, mcp: mcpUrl }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { ui.close(); mcp.close(); });
