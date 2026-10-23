# Jet: browser home for apps and their MCP tools

## Purpose and agreed scope

Jet is the user's front door to the apps they build. The goal behind the goal is to stop rebuilding integrations: register a running app once, open its own UI inside Jet, inspect its capabilities, and let the same Jet use those capabilities from any conversation. An app conforming to the small integration contract must need no app-specific Jet code. Prefer deleting obsolete code and reusing existing behavior over adding frameworks or parallel implementations.

This is an implementation handoff, not permission to expand scope. User decisions from the design interview:

- Browser/server Jet replaces the desktop app. Remove Tauri and unused desktop code; do not maintain desktop parity. WASM is not required for Jet. Keep its existing HTML/JavaScript UI and Rust agent.
- All apps initially run on the same server as Jet. A bare port means that server's loopback address. Accept full HTTP(S) URLs from day one so later remote apps need no registry redesign.
- Apps already run independently. Jet neither installs nor launches them. Quanty at `/Users/shaun/Code/DEVELOPMENT/quanty` is the first real integration. Its MCP and web server may be changed as needed.
- One Jet, shared persona, memory, transcript and capabilities. Switching apps never changes the available MCPs or starts a separate conversation. The selected app is contextual information only; Jet asks when a target is ambiguous.
- Maximize app space. Left navigation collapses completely. Right chat is narrow, approximately phone width, and can hide completely. Keep visited frames mounted in the current browser session to preserve page/input state. Provide explicit reload. Hiding chat does not stop a turn.
- App identity and MCP access are enough initially. Reading iframe DOM, selections, screenshots or unsaved forms is out of scope.
- Add through ordinary language, slash commands or a form; all use the same deterministic registry operations. An explicit, complete instruction acts immediately. Ask only for missing/ambiguous information. Save unreachable apps with a clear error and retry.
- Discover app metadata from a small document; allow label override. MCP owns tool descriptions, schemas and instructions. Show searchable tools, expandable details, and explicit progressive discovery paths where provided.
- Direct manual execution of business tools is deferred. Browsing declared, side-effect-free discovery operations is in scope.
- Authentication is explicitly deferred. Target a trusted single-user deployment. No login, OAuth, accounts or credential-management project. Do not remove Quanty's existing protections for its other deployment modes.
- Do all implementation in new branches and merge to `main` after checks. Respect existing work in both repositories. Do not deploy or push unless separately requested.

## Evidence and starting points

Jet has two crates: `crates/agent` owns providers, conversations and memory; `crates/jet` is a Tauri host with reusable web assets under `ui/`. Its browser mode currently selects a fake agent. Real command handlers and timers in `crates/jet/src/chat/` depend on Tauri. The saved `McpServers` type hardcodes Quanty and Polysim; `agent/src/mcp/` launches and supervises child MCP servers. Claude has a fixed tool allowlist, and the persona includes app-specific instructions. These all need deliberate replacement rather than an additional registry beside them.

Quanty has a real server (`crates/server`), WASM UI (`crates/web-ui`) and Streamable HTTP MCP at `/mcp` (`crates/mcp/src/transport.rs`). UI requests use root paths such as `/api/facts`, `/api/ws`, `/api/upload` and `/content`. Its server enforces host/origin checks; MCP requires a bearer token and is absent when no token is configured. Its current fixture startup installs an empty MCP router. Its current tool catalogue is flat; follow-on instructions in prose are not a machine-readable tool hierarchy. Integration tests must account for all these facts.

At planning time Jet had an unrelated `.gitignore` edit, and Quanty had many uncommitted edits, including server files. Inspect fresh status before implementation. Never reset, stash, overwrite or commit someone else's changes as part of this work.

## Architecture decisions

### One host, one registry, one MCP client service

Reuse `crates/jet` as the server executable and retain `crates/agent` for window-independent behavior. Serve the existing static UI, JSON operations and an event stream. Prefer HTTP commands plus one SSE stream for Jet's own events; reserve WebSocket forwarding for apps that need it. Keep provider CLI processes on the server, with existing provider choice, cancellation, memory review and transcript semantics.

Persist a versioned registry in Jet's explicit data directory, using atomic replacement rather than a database. An app has a stable generated ID, user label, normalized upstream base URL, UI reference, optional MCP URL, embedding capability and enabled state. Labels are not IDs. Renaming preserves connections, transcript attribution and saved layout. Store only configuration; connection status is runtime state. Disabling stops new MCP calls without deleting the entry. Removing forgets the integration, never deletes or stops the external app.

Jet owns one reusable MCP client service for metadata, discovery and calls. Both the tool browser and agent integration use it. Do not create a second MCP implementation inside the UI. Use an SDK compatible with Quanty's actual wire version; negotiate capabilities and test the installed versions. Do not upgrade an entire protocol stack merely because current documentation describes newer behavior.

Expose a small internal MCP facade to both existing CLI providers: `apps_list`, `apps_update` (typed registry actions), `apps_open`, `tools_search`, `tools_describe`, `tools_call`. The facade routes to the registry and shared MCP service. Search returns concise IDs/descriptions; describe returns the actual schema and instructions; call validates and forwards arguments. Every target is identified by stable app ID plus tool name. This gives both providers the same progressive access without injecting every schema into every prompt or requiring provider-specific tool-search features. The facade is an adapter, not a new agent framework or general code-execution runtime.

The facade address and definitions stay stable as apps are added. Registry changes are visible on the next discovery/call, including within an ongoing reply. Never key the provider session fingerprint on the visible app or the entire tool catalogue. Retain existing intentional resets for model/persona changes and provider recovery; preserve Jet's transcript and memory if a provider session must restart.

### Small app contract

Publish a versioned specification and example in the repository. Fetch `jet-app.json` relative to the supplied app base URL. This is a Jet convention, not an MCP standard. Example:

```json
{
  "version": 1,
  "name": "Quanty",
  "ui": "./",
  "mcp": "mcp",
  "embedding": "relative-paths"
}
```

Resolve relative references against the app base; permit explicit absolute HTTP(S) MCP URLs. Normalize the base with a trailing slash. A port such as `8080` or `:8080` becomes `http://127.0.0.1:8080/`. Reject malformed addresses and non-HTTP schemes. Unknown contract versions show a clear incompatibility instead of silently guessing. Manual UI/MCP URL entry is available when no document exists; UI-only apps are valid. No scanning ports or guessing arbitrary MCP paths.

The descriptor only identifies endpoints and embedding support. Server identity/version, instructions, tool inputs, output schemas and annotations come from MCP. For an unavailable descriptor, retain the entered address and label; explicit refresh can discover endpoints later. User overrides win over rediscovery.

### Embed through Jet, with an explicit path contract

Mount each conforming UI at `/apps/{stable-id}/` and forward HTTP and WebSockets to its registered upstream. The browser only needs to reach Jet, so a server-local port works from a different computer and an HTTPS Jet does not embed HTTP mixed content. The path prefix is stripped upstream; preserve queries, binary bodies, upload/download streaming, status codes and required response headers. Forward only registered destinations. Reject path traversal and recursive routes back into Jet. Set upstream Host from the registered URL. For browser requests carrying Origin, first validate it against Jet's public origin, then translate it to the upstream origin so Quanty's same-origin checks remain meaningful. Define forwarded scheme/prefix headers consistently; do not blindly relay client-supplied forwarding headers. Test this contract for both HTTP requests and WebSocket upgrades.

Apps must construct browser assets, API requests, WebSockets, content URLs and downloads relative to their visible app base. Fix Quanty to do this. Do not build a proxy that rewrites HTML/JavaScript bodies. Handle redirects explicitly: app-local redirects stay under the mount; unsupported absolute locations produce a useful error or external link. Ordinary iframe embedding uses trusted app code on Jet's origin; isolation of untrusted third-party apps is not a v1 promise. Do not work around another app's framing restrictions. For a nonconforming manually registered UI, offer direct embedding only when browser-reachable and permitted, otherwise an Open externally action with an explanation.

Quanty keeps its normal standalone mode. Add an explicit trusted integration mode on loopback for the test deployment, exposing UI, descriptor and MCP without credentials. This addresses its existing token/host/origin requirements without adding authentication to Jet. Keep unrelated authentication behavior intact and test both paths. Future authenticated remote apps require later work; full URL support alone does not imply SSO support.

### Progressive discovery and visibility

Separate three things: app endpoint discovery, an MCP tool catalogue, and app-defined discovery operations. Use normal tool listing, including pagination supported by the negotiated version, to build the catalogue. Refresh on explicit request, reconnect, and change notifications where supported; bound requests and retain last successful metadata marked stale after failure. Current protocol versions differ in discovery and notification behavior, so SDK negotiation is authoritative.

The UI shows server identity, endpoint, status, protocol/capabilities and instructions, plus searchable tool summaries. Expand a tool for its description, input schema, output schema and annotations. Grouping is optional; never invent a hierarchy from tool names or descriptions.

For tools that reveal more operations, use one small opt-in convention: tool `_meta["jet/discovery"] = {"version": 1, "entryArguments": {}}`. The marker promises a free, side-effect-free catalogue operation. Optional `entryArguments` identifies a root that can be expanded; nested targets need the marker but not root arguments. Its standard structured result contains nodes such as:

```json
{
  "version": 1,
  "nodes": [
    {"label": "Documents", "kind": "discover", "tool": "list_document_tools", "arguments": {"collection": "books"}},
    {"label": "Read page", "kind": "tool", "tool": "read_page", "arguments": {"document": "abc"}}
  ]
}
```

Both node kinds reference real tools on the same MCP server, not a second virtual-operation system. Discovery expansion validates arguments, requires the target's explicit marker and uses the same client session. Leaf arguments are suggested bindings; the actual schema always comes from the MCP catalogue. A leaf is inspected or handed to Jet as a draft request, never executed by browsing. If discovery changes available tools, refresh the catalogue on the same session; unknown targets remain visible as unsupported raw data rather than being called using invented schemas. The agent facade uses these same discovery calls through `tools_call`, with returned node targets still addressed by app ID and real tool name.

Traversal is explicit on expansion, with breadcrumbs, cancellation, cycle/depth/result limits and raw-result fallback for unsupported shapes. Do not infer that arbitrary tools are safe to execute from their names or a generic read-only hint: Quanty's `search` is read-only but costs money. Browsing never executes business or paid tools. A two-level fixture proves this path; do not redesign Quanty's already useful flat tools merely to manufacture nesting. This metadata convention is a Jet extension, not a claim about standard MCP semantics.

Agent calls continue to appear in the existing chat tool cards. Decode facade calls so cards show the real app/tool, arguments, result and failure, not just `tools_call`. Keep generic result rendering; preserve useful existing Quanty citation cards, but remove filesystem-based image access. Any images must come from contained app-served content URLs, not arbitrary server file paths.

## Eight features and their completion criteria

### 1. App contract and persistent registry

**Depends on:** nothing. **Owns:** registry types/service/storage and integration specification. Freeze public contracts before parallel work starts.

- Implement add/list/edit/enable/disable/remove/refresh with stable IDs, label override, full URLs and port shorthand. Share these operations across HTTP and internal MCP adapters.
- Define descriptor, embedding/forwarded-origin rules, typed command results, registry change events, discovery-node schema and MCP service interface. Keep interfaces small and owned by the module that implements them.
- Provide a minimal conforming app fixture with UI and an independent mock MCP endpoint; no Quanty names in routing logic.
- Preserve existing transcript/notes and relevant user settings. Support pointing the server at the existing data directory or a documented copy of it; no automatic migration framework is needed. Reject old process-command registry entries with an actionable re-registration message; never launch them or silently erase their source file. Start new installs with no machine-specific app defaults.

**Done when:** restart restores entries and labels; duplicate normalized addresses return the existing entry or an explicit conflict; relabeling retains identity; invalid/unreachable/missing-descriptor/UI-only cases have tested outcomes. The contract includes examples a second app author can follow without reading Jet internals.

### 2. Real browser server; remove the desktop host

**Depends on:** 1's contracts. **Owns:** server lifecycle, HTTP/SSE bridge, settings and provider hosting.

- Convert `crates/jet` into the server host with explicit listen/data-directory configuration and static assets. Replace Tauri calls with the browser bridge; fake mode is explicit development/test configuration, never the production browser fallback.
- Move reusable chat lifecycle logic out of Tauri dependencies without copying it. Server owns active turns and review timers. Give each send a client-generated request ID and server turn ID: retrying a lost HTTP response must return the accepted turn instead of running it twice. Reconnecting browsers receive history and an authoritative active-turn snapshot, then resume events after its cursor without resending user input. Maintain only the bounded replay/current-turn state needed for reconnect, not a new durable event database. Persist the request association with the transcript if needed to cover retry after server restart.
- Retain the existing single active reply invariant across browser tabs, with a clear busy response. Connection closure does not cancel the reply; explicit Stop does. Graceful shutdown bounds provider cleanup and persists completion/interruption consistently.
- Delete Tauri dependencies/build hooks/config/capabilities/icons, native opener/bridge and obsolete tests/scripts. Keep shared child-process utilities needed for Claude/Codex. Remove desktop-only file image access; render a clear unavailable-image fallback until app content URLs are integrated in features 3/4/8. This feature does not depend on the proxy being finished.

**Done when:** real chat streams in a normal browser; reload/reconnect during a turn recovers it without duplicate work, including disconnect after acceptance but before acknowledgment; memory/settings/Markdown/character behavior remain usable; the build needs no desktop SDK or webview; no production browser silently uses the fake agent.

### 3. Quanty conforms to the app contract

**Depends on:** 1's contracts. **Owns:** changes only in the Quanty repository.

- Serve `jet-app.json` and support standalone root and Jet-mounted relative paths in the same browser build. Include WASM/JS assets, startup facts, WebSockets, images, uploads, downloads, links and redirects.
- Add the explicit loopback trusted integration mode described above; adapt host/origin handling to the documented proxy contract. Preserve normal standalone protections.
- Keep MCP descriptions/schemas/instructions authoritative and complete. Expose useful tool metadata without paid calls. Add a fixture MCP implementation alongside the existing fixture UI so the full integration can run without stores/models/accounts.
- Make emitted content references usable by Jet's existing source/citation cards through app URLs. Do not require Jet to read Quanty's filesystem.

**Done when:** the same Quanty build works at `/` and `/apps/{id}/`; its descriptor and tools are discoverable in trusted mode; fixture UI and MCP both run; existing normal-mode checks pass. Test an actual WASM bundle, not only server response codes.

### 4. App UI proxy and frame lifecycle

**Depends on:** 1 and 2. **Owns:** proxy routes and the reusable frame container.

- Implement the narrow registered-upstream HTTP/WebSocket proxy and direct/external fallback described above using maintained transport libraries.
- Preserve one frame per visited app per browser session. Switching hides/shows frames; renaming or toggling navigation/chat never recreates them. Explicit reload and remove dispose only the affected frame. Do not persist live iframe state across full browser reloads.
- Show distinct offline, incompatible and loading states with retry/open externally. A successful upstream check is not proof the iframe rendered; use browser verification and avoid claiming readiness solely from iframe `load`.

**Done when:** a browser on a separate machine reaches a server-loopback app through Jet; binary assets, uploads, downloads and WebSockets work; test different Jet/Quanty ports and HTTPS Jet forwarding to HTTP Quanty; two independent app fixtures have no route collisions; switching retains an entered unsaved value; disconnect/restart recovery is visible. Quanty acceptance joins this feature with 3.

### 5. Shared MCP service and global agent facade

**Depends on:** 1 and 2. **Owns:** MCP client lifecycle, facade and provider wiring.

- Implement metadata/discovery/call service and stable internal MCP facade. All enabled registered MCPs are available regardless of active UI. UI failures do not disable working MCP endpoints, and MCP failures do not hide a working UI.
- Use the existing provider adapters; replace fixed app names, allowlists, process configs and app-specific persona instructions with facade tools and discovered instructions. Restrict provider tool exposure to the intended facade surface; do not enable unrelated shell/browser tools.
- Add active app identity as per-message context. The facade stays stable on registry changes. Resolve current enablement at dispatch: disabling/removing rejects new calls, lets already dispatched calls settle, and does not automatically replay uncertain writes.
- Preserve structured errors and tool results, request identity, cancellation and observable real app/tool attribution. Close/reconnect MCP connections without starting external app processes.
- Delete the obsolete `SharedServers` supervisor, MCP executable configuration and tests whose behavior has been removed. Keep provider-process management.

**Done when:** both existing provider adapters can discover and invoke an arbitrary fixture app from any visible workspace; adding an app makes it callable without a new persona or transcript; one failed app does not prevent other calls; tool collisions are disambiguated by ID; model receives full schemas only on demand. Integration tests exercise the actual facade/service and fake providers, not only serialized argument snapshots.

### 6. Space-efficient workspace shell

**Depends on:** 1 and 2; develop with the frame interface agreed in 1, integrate 4 before completion. **Owns:** navigation/layout/chat presentation.

- Add app list, Add/Edit controls, selected app workspace and compact chat dock. Both side panels collapse fully, with small visible restore controls. No permanent empty gutters.
- Default open chat width about 360 CSS pixels, bounded to fit the viewport; make it resizable on wide screens and an overlay on narrow screens. Persist width/visibility locally. Keep the app usable when both panels are hidden.
- Adapt composer, character, tables, citations, settings and tool cards to narrow chat. Do not introduce another UI framework or duplicate chat markup. Keep keyboard focus, accessible labels, Escape behavior and restore controls predictable.
- On a fresh installation, show a useful empty workspace and chat. Open Tools in the same right-hand dock as Chat, so another permanent panel does not consume app space.

**Done when:** visual checks at desktop and narrow widths show usable app space, no clipped primary controls, readable narrow chat, accessible toggles, and preserved chat/frame state while panels switch. Selected app is supplied as context but never filters the global registry.

### 7. Commands, natural-language app management and MCP browser

**Depends on:** 1, 5 and 6. **Owns:** command UX, tool explorer and registry action presentation.

- Add slash completion/help for `/app add <address> [label]`, `/app list`, `/app open <id-or-label>`, `/app edit`, `/app remove`, `/app enable`, `/app disable`, and `/tools [app]`. Parameterless edit/add opens a compact form. Quoted labels work. Unknown commands show help instead of being sent to the model.
- Commands and forms call registry operations directly with no model request. Ordinary language uses the facade's typed management tools. An explicit add is not wrapped in a second confirmation; ambiguous names and missing addresses require clarification. Registry success/failure, not model prose, determines the displayed result.
- Opening a UI is a browser-local action; registry changes are global. `apps_open` accepts an app ID, never a browser ID supplied by the model. Bind each provider-facing MCP connection to its initiating turn using server-supplied correlation metadata; invalidate it at turn completion/cancellation. Emit an action containing that turn and its originating browser-client ID, and only that browser acts. Keep one stable facade endpoint and tool definitions; transient correlation metadata must not affect the persona/session fingerprint. Test that a delayed action from an old turn cannot open an app in a later turn's browser.
- Build the read-only MCP browser specified above, including server details, schema expansion, refresh/stale state, search and bounded discovery paths. An Ask Jet action may insert a draft request into chat; do not add business-tool execution forms.
- Show configuration failures and discovery failures separately. Reuse the existing chat tool-card presentation for agent activity; do not build a second execution log.

**Done when:** form, slash and conversational registration produce equivalent registry entries; natural-language add actually persists the entry; duplicate/ambiguous labels are handled; deterministic slash actions make no model call; browsing calls no paid/business operations; a two-level discovery fixture can be traversed and its final schema inspected.

### 8. End-to-end proof, cleanup and handoff

**Depends on:** 3, 4, 5, 6 and 7. **Owns:** integrated acceptance, documentation and final removal of dead paths.

- Prove Quanty add by port, label override, iframe use, tool browsing and a Jet-initiated MCP call. Prove a generic second fixture can be added by full URL with no Jet code change. Use fixture operations with no paid calls; do not autonomously start paid ingestion or live trading.
- Exercise browser on another machine/network namespace, hidden chat during a reply, app switching during a reply, browser reconnect, app restart, stale metadata, remove/disable and Jet restart. Verify global capabilities and persistent conversation continuity.
- Remove stale desktop documentation, machine-specific defaults, legacy launch flags, dead imports/dependencies and redundant tests. Keep useful generic UI fixtures and provider fakes. Update glossary, README and run commands for the resulting implementation.
- Document the app-author contract and exact Quanty trusted-mode launch commands. Record limits: trusted deployment, HTTP MCP, conforming embedding paths, no universal iframe compatibility, no direct business-tool runner and no UI-state observation.
- Run applicable Rust format/build/test/clippy checks and JavaScript tests, plus actual browser visual/functional checks and affected Quanty checks. Add only tests for real behavioral boundaries. Ensure Jet builds on a headless server without Tauri. Report checks that could not run rather than claiming success.
- Commit only task changes in each repository, merge reviewed/tested feature work into the implementation branch, then merge into each affected repository's `main`. Preserve unrelated dirty work; use isolated worktrees where needed and coordinate if overlapping uncommitted edits prevent a safe final merge. No force resets, no automatic pushing/deployment.

**Done when:** all acceptance cases pass, desktop code is gone, the second app requires configuration only, and the orchestrator reports merged commit IDs, verification evidence and any material limits.

## Parallel execution and ownership

Feature 1 freezes contracts first. Then 2 and 3 can run in parallel. After 2, run 4, 5 and 6 in parallel against the agreed interfaces. Feature 7 follows 5 and 6; feature 8 integrates everything. A sequential orchestrator can simply follow 1–8.

Assign one owner to shared workspace manifests, root configuration and public type changes. Quanty work stays in its own branch/worktree. A new worktree starts from committed state: the existing uncommitted Quanty edits are not automatically present. If integration depends on them, resolve the baseline explicitly and preserve those edits rather than silently testing an older Quanty. UI shell and tool explorer must not edit the same modules concurrently; feature 6 defines the dock API before 7 uses it. Integration contracts belong with their implementations, not in a giant catch-all crate. The orchestrator may simplify internal choices when evidence supports it, but must preserve all agreed behaviors and the eight-feature ceiling.

## Advisor review

Reviewed by a separate advisor agent on 2026-10-23. The advisor supported the stable MCP facade and recommended finalization after concrete amendments. Incorporated: real-tool discovery node references instead of virtual operations; turn-bound browser actions; idempotent chat submission and snapshot/cursor reconnect; explicit existing-data reuse; a corrected image-delivery dependency; exact proxy origin handling and HTTPS-to-HTTP acceptance; and the dirty-worktree baseline caveat. No further user decisions remain for this scope.

## Reference material

- [MCP client best practices: progressive tool discovery](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices#progressive-tool-discovery): concise search followed by schema inspection is a client pattern; no need to flood the model with all definitions.
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): tool schemas, listing/calling and result semantics. Implement according to the SDK's negotiated version.
- [MCP server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover): current metadata discovery differs from older initialization-based implementations. Do not confuse it with discovering an app's endpoint or hierarchical application tools.

Repository observations were made on 2026-10-23. Recheck actual code and installed SDK/provider compatibility when implementation begins.
