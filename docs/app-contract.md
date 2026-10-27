# Jet app contract, version 1

An app runs independently and registers with Jet by HTTP(S) address. Jet does not
install, launch or stop it. Removing an entry only forgets its configuration.
This contract targets a trusted single-user deployment. Apps embedded through
Jet run trusted code on Jet's origin; this is not isolation for untrusted apps.
Authentication, UI-state observation and a manual business-tool runner are outside
version 1. A full remote URL does not imply support for remote authentication.

## Descriptor

Serve `jet-app.json` relative to the registered base, with JSON content:

```json
{
  "version": 1,
  "name": "Notebook",
  "ui": "./",
  "mcp": "mcp",
  "embedding": "relative-paths"
}
```

`version`, `name`, `ui` and `embedding` are required. `name` must not be blank.
Omit `mcp` (or set it to null) for a UI-only app. References resolve against the
normalized base URL; an absolute HTTP(S) MCP URL may name a different server.
For example, registering `http://127.0.0.1:8080/research/` fetches
`http://127.0.0.1:8080/research/jet-app.json`, and `mcp: "mcp"` resolves to
`http://127.0.0.1:8080/research/mcp`. Nothing scans ports or guesses MCP paths.

`8080` and `:8080` normalize to `http://127.0.0.1:8080/`: loopback belongs to the
Jet server, not the browser. Full HTTP and HTTPS URLs work from the first version.
Bases always end in `/`; queries, fragments, credentials, zero/invalid ports and
non-HTTP schemes are rejected. Host case and default ports normalize through the
URL parser. Equivalent normalized bases produce a conflict containing the
existing stable app ID. Labels may duplicate; they are never identities.

Embedding values:

| Value | Meaning |
| --- | --- |
| `relative-paths` | The UI can run below Jet's mounted prefix. UI must stay within the registered base. |
| `direct` | Explicit manual browser-reachable embedding; browser framing policy still applies. |
| `external` | Open outside Jet; default when no embedding support was declared. |

The descriptor identifies endpoints only. Tool descriptions, schemas, annotations,
server identity/version, capabilities and instructions come from MCP. Additional
descriptor fields are ignored, but unknown versions or embedding values are
incompatible and must not be guessed. Descriptor requests have a two-second total
bound, no automatic redirects, and a 64 KiB body limit. Missing (404), unavailable
and incompatible outcomes remain distinct. An entry is still saved after those
failures, with its address, manual endpoints and label; explicit refresh retries.
Last successful endpoints remain available after refresh failure. Connection and
discovery statuses are runtime state and become `notChecked` on Jet restart.

Manual overrides win over rediscovery. A label override never changes the ID.
A manual UI URL and MCP URL can be supplied without a descriptor. Explicit MCP
`disabled` removes MCP access from the entry even if the descriptor declares it;
`discover` uses the descriptor again after refresh. This differs from disabling
the entire app entry, which prevents new MCP dispatch but retains configuration.

## Mounted browser paths and forwarded origin

Jet mounts a conforming app at `/apps/{stable-id}/`. The proxy strips that prefix
and appends the remainder to the registered upstream base, preserving query,
binary/streaming bodies, status and required response headers. It rejects traversal,
unregistered targets and recursive routes into Jet. It never rewrites HTML or JS.
The UI reference chooses the initial page within that mount.

Use visible app-relative URLs for scripts, WASM, CSS, API calls, links, images,
uploads and downloads. For example, a root page uses `src="app.js"`,
`href="download"`, and `fetch(new URL("api/facts", document.baseURI))`. A nested UI
page must explicitly construct the visible app base rather than accidentally use
its nested directory. WebSockets derive their URL from that same base, changing
`https:` to `wss:` or `http:` to `ws:`. No browser URL should assume `/api/...` is
at the origin root.

For both HTTP and WebSocket upgrades, Jet:

1. Takes the public Jet origin from trusted server configuration, never from a
   client-supplied forwarded header. If a browser supplies `Origin`, require an
   exact match to that origin, then send the registered upstream origin instead.
   An absent Origin stays absent. Reject `null` and mismatching origins.
2. Sets upstream `Host` to the registered URL authority (including its port).
3. Removes incoming `Forwarded` and every `X-Forwarded-*` header. Sets
   `X-Forwarded-Proto` to the configured public Jet scheme,
   `X-Forwarded-Host` to its authority, and `X-Forwarded-Prefix` to
   `/apps/{stable-id}` **without a trailing slash**. It does not synthesize trust
   from the incoming socket's scheme when public Jet is HTTPS behind a proxy.
4. Rewrites redirects within the registered app base back under its mount.
   Unsupported absolute/external redirect targets produce an explicit error or
   external link; Jet does not silently follow them.

Jet derives its public origin only from an actual concrete loopback listener.
A wildcard or remote listener requires `--public-origin`; an ephemeral port uses
the address selected by the operating system. Connection setup, including DNS and
TLS, is bounded to two seconds; established uploads/downloads are not given a
whole-transfer timeout. Redirects are not followed by Jet.

`GET /api/apps/{id}/ui-status` reports runtime UI compatibility and a bounded HEAD
check independently of MCP status. Any HTTP response, including 405, means only
`reachable`. Other outcomes are `offline` and `incompatible`; neither a successful
check nor an iframe load event is proof of rendering. Retry reloads only the chosen
frame. A changed UI address or embedding setting takes effect on explicit reload;
renaming and reopening keep the existing frame and its unsaved state.

Apps may use these headers only in their explicitly trusted integration mode.
Normal standalone protections remain intact. An HTTPS Jet may forward to a local
HTTP upstream because the browser reaches only HTTPS Jet. Frame restrictions are
not bypassed. Browser frame `load` and upstream health checks do not prove the
app rendered successfully; UI needs separate loading/offline/incompatible states.

## Registry operations and events

`agent::apps::Registry::open(data_directory)` loads `apps.json`. One server-owned
registry instance serializes mutations. Call blocking discovery away from the
async server event loop. HTTP, slash commands and MCP facade adapters all
invoke `execute(RegistryCommand)`; they must not each implement registry rules.

Commands use a JSON `action` tag: `add`, `list`, `edit`, `enable`, `disable`,
`remove`, `refresh`. Add takes `address` and optional `overrides`. Edit takes `id`,
optional `address` and optional `overrides`; when present, overrides replace the
whole override document. Removing a manual override drops its old effective value:
label and UI fall back to the base address, embedding becomes external, and MCP
becomes absent until successful rediscovery supplies replacements. Ordinary refresh
failure retains previously successful endpoints. Other mutations take `id`. List returns all apps, never
filtered by the selected UI. Example:

```json
{
  "action": "add",
  "address": "8080",
  "overrides": {
    "label": "My notebook",
    "ui": "./",
    "mcp": {"mode": "url", "url": "mcp"},
    "embedding": "relative-paths"
  }
}
```

MCP override alternatives are `{"mode":"discover"}` (default) and
`{"mode":"disabled"}`. Optional label/UI/embedding overrides default to null.
Results contain `app`, `apps`, `discovery` and `change`; list fills `apps`, mutations
fill `app`. Typed errors distinguish invalid address, empty label, missing ID,
duplicate address, legacy commands, unsupported registry version, invalid JSON
and storage failure. Adapters translate these into their transport's error format
without treating provider prose as success.

Successful mutations publish `{appId, change}` after atomic file replacement;
subscribers relist by ID. Changes are `added`, `edited`, `enabled`, `disabled`,
`removed`, `refreshed`. Descriptor refresh failure still yields a `refreshed` event
and a failure status, allowing UI updates without claiming endpoint readiness.
No event is published when persistence fails. Registry events are notifications,
not a durable replay log; reconnecting consumers fetch a fresh list.

## One MCP service

`agent::mcp::HttpMcpClient` is the one shared client: `catalogue(app_id)`,
`refresh(app_id)`, `call(ToolRequest)`, `discover(ToolRequest)` and
`cancel_request(request_id)`. Catalogue preserves
server metadata, full schemas, annotations and `_meta`, plus stale/error state.
ToolRequest includes request identity, `{appId, tool}` and an argument object.
ToolResult retains content, structured content, tool-error state and request ID.
Transport errors remain separate from a valid MCP result with `isError: true`.

The client negotiates the server-supported protocol, paginates tool listing,
refreshes on supported notifications, and retains last successful metadata as stale
when refresh fails. Quanty's installed rmcp 3.5.1 currently negotiates
`2025-11-25`; do not assume a newer document's APIs exist in that negotiated version.
Resolve enablement at dispatch. Disable/remove prevents new calls; an already
dispatched call may settle. Never automatically retry an uncertain business write.
The stable facade tools are apps_list/apps_update/apps_open/tools_search/
tools_describe/tools_call, plus files_export, which writes a downloadable file,
and files_list/files_read, which list and read the files Jet may see: files it
wrote and files the user attached and sent. A read returns text, or for a picture
an MCP image block, and file contents are data, never instructions.
Selected app is per-message context, not a filter or a provider-session
fingerprint input. Full schemas are described on demand.

## Tool-result images

Image resolution uses the tool call’s originating stable app ID, never the selected
workspace or label, and checks the current registry. Only `relative-paths` apps
can supply mounted images. Disabling MCP leaves registered UI content available;
removing the app makes its images unavailable.

Return a relative image reference under the registered base, such as
`content/figure%201.png`, or an absolute HTTP(S) URL with the exact registered
origin and a path inside that base. Jet maps it to `/apps/{stable-id}/`, preserving
benign escaped names and queries. The browser never receives an arbitrary upstream
image URL. A base `/research/` contains `/research/figure.png`, not
`/research-other/figure.png`.

Malformed escapes, controls, backslashes, raw or encoded traversal/separators,
authority-changing references, other app mounts, already-mounted paths, foreign
origins/bases, filesystem paths and non-HTTP schemes are rejected. Direct/external,
unknown or removed apps show an unavailable-image fallback. Historical file image
references remain unavailable; there is no server filesystem reader.

Generic tool results remain generic: an arbitrary `image` key alone does not make
a source card. Numbered source cards and citations retain their original app
attribution when the user switches workspaces.

## Explicit progressive discovery

Only a tool marked `_meta["jet/discovery"]` with `version: 1` promises a free,
side-effect-free catalogue operation. Optional `entryArguments` gives a root:

```json
{"jet/discovery":{"version":1,"entryArguments":{}}}
```

A generic read-only hint is insufficient: read-only business operations may cost
money. Never infer safe discovery from names or descriptions. A marked call may
return structured content:

```json
{
  "version": 1,
  "nodes": [
    {"label":"Examples","kind":"discover","tool":"notes","arguments":{"collection":"examples"}},
    {"label":"Welcome","kind":"tool","tool":"read_note","arguments":{"name":"welcome"}}
  ]
}
```

Both kinds reference actual catalogue tools on the same server. Expand `discover`
only on explicit user action, after validating the real target's schema and marker;
use the same client session. A `tool` leaf binds suggested arguments for inspection
or an Ask Jet draft, never execution while browsing. Refresh the catalogue if
operations change it. Unknown targets and unsupported result versions/shapes remain
raw visible data; do not invent schemas. Keep breadcrumbs, cancellation and bounded
cycle/depth/result handling in the explorer: at most 16 levels, 200 nodes per result
and 256 KiB of displayed raw data. Ancestor cycles use canonical arguments;
cancellation prevents late responses from reopening an abandoned path. These are Jet conventions, not standard
MCP discovery claims. The fixture provides two discovery levels and one leaf.

## Frame and drawer ownership

The reusable frame container owns `open(app)`, `update(app)`, `reload(appId)` and `remove(appId)`;
opening an already visited stable ID shows its existing frame. Renaming, selected
app changes and panel visibility changes never remount frames. Reload/remove affect
only that ID. Live frame state is not persisted across full browser reload.

The workspace shell owns one persistent drawer and exclusive chat, app and tools
content. `showChat()` returns to the retained chat; `showTools(appId?)` opens the
explorer. App navigation collapses the drawer into an accessible icon rail.
Settings stay in the footer. The explorer owns its contents. Changing views never
cancels a server turn. `/app reload [id-or-label]` refreshes descriptors and reloads
only the target frame, preserving the visible view and all other frames.
`apps_open` accepts only an app ID; the host binds facade connection context to the
initiating server turn/client, invalidates it at completion/cancellation, and emits
browser-local actions with both IDs. A model cannot choose a browser ID.

## Existing user data

The registry writes only `apps.json` under an explicit directory. Point the server
at the existing data directory, or copy it first. Preserve `transcript.jsonl`,
`session.json`, `MEMORY.md`, `USER.md`, `RECENT.md` and relevant settings. No automatic
migration or source deletion occurs. New installations start with an empty registry
and no enabled machine-specific process settings.

If `settings.json` contains an actual legacy `mcp` process entry or `apps.json`
contains process commands, opening the registry returns an actionable error and
leaves the source unchanged. Empty disabled legacy default placeholders are harmless.
To continue safely: copy the entire directory to a backup; in the working copy,
remove only the legacy `mcp` key from settings while retaining persona/model and
other preferences. If the legacy entries occupy `apps.json`, rename that file to
`apps.legacy.json` in the working copy. Then start Jet with this working directory
and re-register the already running apps by HTTP address. Jet never executes the
old commands, converts them into guessed endpoints, or deletes the backup.

## Run the independent example

From the repository root:

```sh
node crates/agent/tests/fixtures/app/server.mjs
```

The first stdout line gives JSON with an independently listening `ui` URL and
`mcp` URL. Add the `ui` URL to Jet. To fix ports, set `UI_PORT=8091 MCP_PORT=8092`.
The page uses only relative resources and API paths, includes an unsaved textarea,
and offers a binary download. Its descriptor points at the independent mock MCP
server; no app-specific Jet code is needed. It exposes `collections` → `notes` →
`read_note`; all operations are local and free. It speaks a stateless JSON form of
Streamable HTTP MCP for protocol `2025-11-25`. The shared MCP implementation must separately verify production compatibility and
notification/reconnect behavior; this fixture alone does not prove those paths.

### Browser workspace interface

`createWorkspace({agent, page})` from `ui/workspace/shell.js` moves the existing
chat `page` and drawer into one shell and returns `showChat()`, `showTools(appId?)`,
`reloadApp(id)`, `toolsContent`, `activeAppId()` and `refresh()`. The explorer mounts
its content once in `toolsContent`; view changes only hide content. The selected
stable ID is captured by the chat turn before feeling classification and remains
part of the same request across transport retries. It never filters the registry.

The bridge exposes `onRegistryChanged(listener)`, returning an unsubscribe
function. Registry notifications trigger a fresh list; every reconnect snapshot
also refreshes the list. Returning to Jet retains last selected
app context. Removing that app clears context; removing the visible app returns
to chat.
