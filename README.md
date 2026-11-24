# Jet

Jet is a browser home for independently running apps, with an assistant of each user's own. Its Rust server runs the installed Claude Code, Codex or agy CLI, keeps each user's chat, notes, settings, apps and files in one SQLite database, and serves the existing HTML/JavaScript interface.

## Layout

```text
crates/jet/                       the server program (axum) and the page it serves
  src/apps/                       app routes: registry (/api/apps), tool browser, proxy to running apps
  src/chat/                       one runtime per chat: commands, the streamed reply, reconnect snapshots, the notes review timer (it also sets a follow-up for each promise Jet made in its own lines, and rearms when it falls due too soon)
  src/evidence/                   outside evidence: a GitHub repository's activity, each user's sealed GitHub token
  src/facade/                     the seventeen MCP tools the provider sees
  src/objectives/                 objectives and agent-tasks: computed dates, local time to UTC
  src/scheduler/                  wakes Jet when an agent-task falls due and runs the check
  src/files/                      uploads, files Jet writes, the sandboxed reader child, export, all kept in the store
  src/server/                     shared host state, listen address and the remaining routes
  src/voice/                      the speak and hear routes and their limits
  src/settings.rs                 each user's settings and the admin-only provider program paths
  src/store/                      the SQLite store, its migrations, and the one-time import of an older Jet's files
  ui/bridge/                      the page's HTTP commands, event stream and default settings
  ui/chat/                        message box, thread, drawer, settings, speaker (voice/) and microphone (hear/)
  ui/jet/                         the kite character: parts, clips, director, player
  ui/workspace/                   app frames, slash commands, tool browser
  ui/vendor/                      KaTeX and the TEN VAD voice detector
crates/agent/src/                 the library behind the server
  apps/                           the registry of independently running apps
  chat/                           the data types of a conversation: events, model choices, context use
  conversation/                   send a message, the thread, notes, the persona prompt, session policy, the check brief and turn
  markdown/                       a reply as safe HTML, math, vocal cues and the words to speak
  mcp/                            one HTTP client for app tools, with a shared catalogue
  turn/                           one exchange with Claude Code, Codex or agy: processes, stream, mood line
  voice/                          Gemini speaking and hearing
  feeling.rs                      the optional JEV feeling classifier
  env_file.rs                     a setting from the environment or the nearest .env
crates/agent/tests/fakes/         stand-ins for Claude Code, Codex and agy used by tests
crates/export/                    writes a document as one PDF, Markdown or HTML file
deploy/                           the systemd unit and the Nginx site
docs/                             the app contract and the voice guide
CONTEXT.md                        the glossary: one meaning for each word
```

## Run

```sh
cargo run -p jet -- --listen 127.0.0.1:8787 --data-dir ./jet-data
```

Open `http://127.0.0.1:8787/`. Install and sign in to Claude Code, Codex or agy on the server, then select one of its models in Settings. The browser never silently selects a pretend agent. A missing provider is shown as an actionable status/error.

For access from another computer, choose a reachable listen address. `--public-origin https://jet.example` records the externally visible origin for app forwarding. `--ui-dir PATH` selects the shipped static asset directory; the default is this checkout's `crates/jet/ui`. Keep the UI files with the executable when deploying a copied build. `--disable-feelings` disables optional JEV classification for offline development/testing.

App processes run independently; Jet does not install, launch or stop them.

## Accounts and sign-in

Nobody reaches Jet without signing in with an email and a password. The accounts, teams and
manager links live in one SQLite file, `jet.sqlite3` in the data directory; passwords are kept
only as salted Argon2id hashes. When the database holds no user, Jet seeds a demo organisation
at start; `jet seed --data-dir DIR` does the same and is safe to run again. Its accounts are
`shaunsurfing@gmail.com` (Shaun, admin), `admin123@gmail.com` (Shaun's manager),
`admin1@gmail.com` and `admin2@gmail.com` (the team Commercial) and `admin3@gmail.com`, all with
the password `000111`. They are not real mailboxes and Jet sends no mail.

A sign-in is two HttpOnly cookies: a signed JSON Web Token that lives 15 minutes
(`--access-seconds` shortens it for tests) and a random refresh token that lives 30 days, is
stored only as a hash and is replaced on each renewal; offering a replaced one ends the sign-in.
They are marked `Secure` when `--public-origin` is HTTPS, so plain HTTP on 127.0.0.1 still works.
The sign-in page is `/signin/`; a visit with a sign-in that can still be renewed goes straight
back to Jet. An open page renews its access token shortly before it runs out, and once more when
a request is refused, one tab at a time, so the person never sees the renewal and the event
stream stays open. The drawer's foot shows who is signed in and the way to sign out.
The signing secret is `signing-secret` in the data directory, made on first start with owner-only
access, or `JET_SIGNING_SECRET` (at least 32 bytes). A request that changes state must carry
Jet's own `Origin`. Five failed sign-ins for one email, or twenty from one address, wait 15
minutes; behind the reverse proxy the address is the last `X-Forwarded-For` entry, believed
only from loopback or from `--trusted-proxy ADDRESS`.

Registered app pages are served in a sandbox with an opaque origin: they cannot read Jet's page
or send its cookies, and reach their own app through an address that carries a proof for that
app. Browser storage and cookies of an app do not work inside Jet. The `/mcp` endpoint takes the
provider's per-turn token instead of a sign-in.

## Each user's own Jet

Every account has its own main chat (history and provider session), its own notes, settings
(the name and persona of their Jet, model, thinking effort, reduced motion, turn budget), apps
and files, all in `jet.sqlite3`. Each chat has a runtime of its own, so two users' replies run at
once, each page gets only its own user's snapshot and events, and each chat's notes review runs
after that chat is quiet (`--review-quiet-seconds`, 90 by default) and writes only its user's
notes. Every user's Jet runs on the server's one signed-in provider. The facade's tools act for
the user of the turn: their apps, their files and their GitHub token.

The paths of the provider programs are one server-wide setting: `GET /api/settings` shows
`claudePath` and `codexPath` only to an admin, and `PUT` saves them only from an admin (anyone
else's are ignored). Only an admin may register an app at a port, a loopback address or a private
address, from the page or by telling Jet; anyone may register an app at a public address. A
refusal is `403` with `{"kind":"adminOnly","message":...}`.

## Many chats

A user has one main chat and any number of other chats. `GET /api/chats` lists them (main first,
then by latest entry) with each unread count; `POST /api/chats` opens one, `PATCH /api/chats/{id}`
renames it, `DELETE /api/chats/{id}` deletes it (the main chat refuses; the chat's objectives and
agent-tasks move to the main chat). Every chat route (`status`, `snapshot`, `events`, `send`,
`react`, `stop`, `forget`) takes `?chat={id}` and acts on the main chat without it; a chat that is
not the user's gets the answer of one that does not exist. One `/api/events` stream carries the
events of all the user's chats, each with its `chatId`. A Jet entry after a chat's read mark is
unread; `POST /api/chats/{id}/read` moves the mark. The notes review reads the new entries of all
a user's chats and RECENT names the chat each topic came from. `chats_read` is Jet's read-only tool
for looking up another chat of the same user. An objective's chat opens each provider session with
the objective's summary.

### The left pane

The pane lists the user's chats above the apps: the main chat first (it can be renamed, never
deleted), then the others by latest activity, each with its unread badge. **New chat** opens an
empty chat at once with no form; the server titles it from the first message. On each row a pencil
renames the title in place (Enter saves, Escape cancels) and a bin deletes the chat on a second tap
of the same row (it asks again after four seconds). The open chat's title is also shown above the
thread, because a phone shows the drawer as a rail. In the rail a chat is its glyph with a badge on
the corner.

The page keeps the open chat's id in its bridge (`ui/bridge/browser-agent.js`), so `status`,
`snapshot`, `send`, `react`, `stop` and `forget` all carry `?chat={id}`. Opening a chat reads its
snapshot, shows it, and moves its read mark; events of the one stream for the open chat that the
snapshot already holds are skipped. An `unread` event for another chat raises its badge; one for the
open chat (while the page is visible) calls `POST /api/chats/{id}/read` and raises none. A
`chatsChanged` event reloads the list, and the main chat shows if the open chat is gone. The shell
has a third grid column, `#side-pane` (`ui/workspace/workspace.css`), which holds the plan pane.

## This server's deployment

Jet's system service is `jet.service`; it starts at boot and restarts on failure.
The installed executable is `/home/ubuntu/.local/bin/jet`, with persistent data in
`/home/ubuntu/.local/share/jet` and UI assets from this checkout. Nginx forwards
HTTPS on port 443 to Jet on `127.0.0.1:8787`, with buffering disabled for event
streams and WebSocket forwarding enabled. UFW permits TCP ports 443 and 80;
port 80 redirects to HTTPS and supports certificate validation.

The deployment files are [the systemd unit](deploy/jet.service) and
[the Nginx site](deploy/jet.nginx.conf). The configured public origin is
`https://xchainanalytics.com`.
Public DNS points this name to `5.175.217.125`. Nginx uses a trusted Let's Encrypt
certificate under `/etc/letsencrypt/live/xchainanalytics.com/`; Certbot's enabled
renewal timer maintains it automatically. The live Nginx site is
`/etc/nginx/sites-available/jet`.
Every route of this public deployment needs a sign-in (see Accounts and sign-in).

To update the executable and restart Jet:

```sh
cargo build -p jet --release --locked
install -m 0755 target/release/jet /home/ubuntu/.local/bin/jet.new
mv /home/ubuntu/.local/bin/jet.new /home/ubuntu/.local/bin/jet
sudo systemctl restart jet
sudo systemctl status jet --no-pager
sudo journalctl -u jet -n 50 --no-pager
```

Quanty is registered at `http://127.0.0.1:7878/`. Its independently managed user
service has a `jet-integration.conf` drop-in enabling `--trusted-integration`
on loopback. Its descriptor and MCP endpoint are available independently of the
WASM UI bundle. If the UI reports that the bundle is missing, finish Quanty's UI
build, rebuild and deploy its server, then use `/app reload Quanty` to reload the app.

## Existing data

Point `--data-dir` at a directory an older Jet kept its files in, or a copy. At the first start on it, Jet copies `transcript.jsonl` into the owner's main chat, `session.json` into its provider session, `MEMORY.md`, `USER.md` and `RECENT.md` into the owner's notes, `settings.json` into the owner's settings (its program paths into the server's), `apps.json` into the owner's apps and `files/` into the owner's files. The owner is the seeded admin `shaunsurfing@gmail.com`. The old files are never moved, changed or deleted, and a row of the database records that the import ran, so a later start copies nothing again. Archived `transcript.<time>.jsonl` threads, and process-command app settings of a much older version, are not copied.

New installs contain no machine-specific app defaults.

## Browser behavior

The server owns the active reply. Closing a tab, reconnecting or hiding the interface does not cancel it; Stop does. A browser request ID is saved with the accepted transcript entry before provider dispatch. Retrying a lost acknowledgment returns that same turn. After a server crash, unfinished accepted turns are marked interrupted and never rerun automatically.

An authoritative history/current-turn snapshot and bounded event replay restore browsers after reload. Settings and memory are saved on the server. Source images use the originating app’s stable mount, even after switching workspaces. Unsupported images, including historical filesystem references, show an unavailable fallback; Jet never reads arbitrary server files; `/api/files/{id}` serves only a file Jet wrote for the signed-in user or that user uploaded, found by its UUID.

## Apps and workspace

Start the app independently, then use `/app add 7878 "Research"` or ask Jet to register it.
A port means loopback on the Jet server; a full HTTP(S) URL can reach another host.
Labels are editable and need not be unique; stable IDs identify registrations.
Ask Jet to change explicit UI/MCP endpoint overrides when an app has no descriptor.
An unreachable app is saved with a discovery error so you can retry later.

Jet chat fills the main content initially. One left drawer lists Jet, then the chats (see
[The left pane](#the-left-pane)), then each registered app with its icon and label, then
the account and settings at the foot. Context capacity stays folded
behind a chevron beside Jet's name. Selecting an app fills the content and collapses the
drawer to an icon rail. Jet returns to the preserved chat and desktop drawer;
last selected app context remains available to Jet. Narrow screens default to the
rail, with an expandable drawer and settings always available. `/tools` opens the
tool browser in the main content. Switching views preserves drafts, visited frames
and active replies. `/app reload` reloads only its target; a full browser reload
clears live iframe state. One reply can run across all tabs; other sends receive a
busy response.

| Command | Action |
| --- | --- |
| `/app add <address> [label]` | Register an app; missing address gives inline examples. |
| `/app list` | Show every registration. |
| `/app open <id-or-label>` | Show the app in this browser. |
| `/app edit [id-or-label]` | Show configuration and guidance to ask Jet for changes. |
| `/app reload [id-or-label]` | Reload the target or last selected app with current endpoints. |
| `/app remove <id-or-label>` | Forget the registration without stopping the app. |
| `/app enable <id-or-label>` / `/app disable <id-or-label>` | Allow or prevent new MCP calls. |
| `/model [model-id]` | Show choices or save the model for the next reply. |
| `/thinking [level]` | Show valid levels or save thinking for the next reply. |
| `/tools [id-or-label]` | Browse the global tool catalogue or one app. |

Context shows the last measured tokens and the selected model’s available capacity. Provider limits are used when reported; Codex can also read its installed model metadata, and agy reports none. Missing counts or limits stay unknown, and aggregate usage fallbacks are labelled estimates. Reload preserves measurements; a fresh conversation or Forget clears them.

Quoted labels work. Missing or ambiguous targets offer a choice. Slash commands
run directly without a model request; unknown commands show help.
Ordinary-language app management uses the same registry through the assistant.
Complete explicit commands execute without a second confirmation.

## Attaching files

The **+** at the left of the message box opens a picker for PDF, Markdown, HTML, Excel (`.xlsx`), CSV, text and image (PNG, JPEG, GIF, WebP) files. Dragging files onto the chat and pasting them into the field attach them too. Each file shows as a chip in the box and uploads at once; Send waits until every upload is done, and a chip that failed must be removed with its **×** first. A message may be files alone.

Jet sees an upload only after the message that carries it is sent, and then only its details (name, size, and pages, sheets, rows or pixel size) with an instruction to leave the file alone until asked. When the user asks about a file's contents, Jet reads it with `files_read`: PDFs by page, workbooks and CSV by row, other text by line, and pictures as a picture. A file you remove before sending is deleted from the server. The thread keeps the files on the message, and Forget deletes them all.

Jet is served publicly, so every path is bounded: 32 MiB for a file, 10 files for a message and 2 GiB for the store of files. The extension and the first bytes must both match one of the kinds above, and a file Jet cannot read is refused. Every read of a stored file runs in a child process of the `jet` program (`jet --read-file`) with a 2 GiB memory cap (1 TiB on macOS, which refuses any cap below the roughly 400 GiB a process maps at start) and a 30 second limit, two at a time, so a file built to exhaust memory or to hang ends only that child. Uploads stay on disk until Forget, and an upload that was never sent counts toward the 2 GiB.

## App tools

Jet shares one HTTP MCP client between the assistant and tool browser. Commands and `/api/apps` share the registry; descriptors and explicit URL overrides locate each MCP endpoint. The provider sees seventeen stable tools of Jet's: `apps_list`, `apps_update`, `apps_open`, `tools_search`, `tools_describe`, `tools_call`, `files_export`, `files_list`, `files_read`, `github_activity`, the six that record objectives and agent-tasks and change the directory (see Objectives and agent-tasks), and `chats_read` (see Many chats). Claude Code also has its own web search, and its own page reading on sites whose link the user wrote in the chat (with or without `https://`, as `docs.rs/serde`) and on the pages that the chat's open objective names as sources; Jet's `/web-hook` refuses every other site and says the user can paste the link. After a web read, a `github_activity` call or a read of a colleague's shared objectives, the rest of that reply cannot call `apps_update`, `people_update`, `objectives_update` with `propose_share`, or an app tool that is not read-only. Codex and agy have no web tools. `files_export` writes a PDF, Markdown or HTML file from Markdown the provider composes, and the thread shows it as a download card; the files live in the database, with the user's other files, until Forget. `files_list` lists the files Jet can read, and `files_read` reads one when the user asks (see Attaching files). Maths in a file is written as in chat (`\( \)`, `\[ \]`), and a single `$` is money. Search returns concise summaries; describe returns the actual schema and server instructions. Tool cards retain the real app ID, tool, arguments and result.

Tools shows searchable summaries, actual input/output schemas, annotations, server identity, capabilities and instructions. Refresh retries failed metadata; stale results remain visibly marked. Only explicitly marked free discovery operations can expand into a hierarchy. Inspect a leaf or use Ask Jet to draft a request; browsing never executes ordinary business tools. In particular, normal Quanty search can cost money.

Registry changes apply to the next discovery or dispatch without resetting the conversation. A visible app is context, not a capability filter. Disabling or removing an app rejects new calls while an already dispatched call can finish. Stop cancels upstream requests. An uncertain write is never replayed automatically. Refresh failures retain the last metadata with an explicit stale status.

The stable `/mcp` endpoint requires a random per-turn header supplied by the host. Browser actions carry the initiating turn and browser IDs; a completed or stopped turn cannot open apps later. This correlation is not deployment authentication.

Read-only browser APIs are `GET /api/apps/{id}/tools`, `POST` to the same URL for refresh, and `POST /api/apps/{id}/discovery` with `{requestId, tool, arguments}`. Discovery requires the explicit `jet/discovery` version 1 marker; generic read-only annotations grant no execution permission. The response contains `{result, catalogue}`. `POST /api/tools/cancel` accepts `{requestId}`. There is no browser business-tool runner.

Connections and catalogue refreshes have 15-second deadlines; calls have a 120-second deadline. Catalogues are capped at 64 pages, 4,096 tools and 2 MiB; results and SSE events are capped at 2 MiB. Search reports truncation after 128 apps or 200 matches. The installed MCP SDK is pinned to 3.5.1 for Quanty compatibility.

## Gemini 4 Neon through agy

Jet's third provider is Google's `agy` program (the Antigravity command line), which runs Gemini 4 Neon. Choose the model in Settings; Sonnet stays the default. Jet finds `agy` on the `PATH`, in `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`, or at the path an admin saved in Settings (`agyPath`). Like the paths of the other two programs, it is one setting for the whole server.

- **Thinking:** `agy` runs Neon at low, medium, high and extra-high. Jet refuses a higher level before the turn starts.
- **Web:** an `agy` turn has no web tools, like a Codex turn, and its prompt says so.
- **Cost:** `agy` reports no cost and has no cost limit, so the turn budget does nothing for this model. The tokens of a turn are the sum of its model calls.
- **Notes review:** runs on Gemini 4 Neon at low thinking.
- **Sessions:** `agy` keeps the system prompt a conversation began with. When Jet's prompt changes in a continued conversation (the notes, after a review), Jet puts the new prompt at the start of the next message.

### The tool limit

Jet starts every `agy` turn with `--dangerously-skip-permissions`, because nobody is there to answer a permission question. `agy` then approves every tool request, so the turn must have no tool that can harm the server. Jet makes the limit again for each turn, from the command line and from files it writes into the folder the turn runs in. Nothing saved in the user's `agy` configuration is part of it, and Jet saves nothing there.

| Part | What it does |
| --- | --- |
| Agent file `.agents/agents/jet.md` with `tools: []`, `excludeDefaultComponents: true` and `inheritCustomizations: false` | The turn runs as an agent that has none of `agy`'s own tools (shell, files, web search, subagents) and takes no rules, skills, plugins or hooks from the user or from a folder above. The body of the file is Jet's system prompt. |
| `.agents/mcp_config.json` | Names Jet's tool server with the token of the turn, and lists Jet's ten tools. Jet writes it before each turn and removes it after. |
| Hook: `.agents/hooks.json` and `.agents/allow.awk` | `agy` asks this program before every tool call. It allows Jet's tools by name and refuses every other call. That includes the three tools `agy` adds to every agent (`manage_task`, `list_resources`, `read_resource`) and any tool server the user saved. When the program fails, `agy` refuses the call. |
| `--settings` with deny rules | A second layer: `agy`'s shell, file read and file write stay refused. |
| `--disable-slash-commands`, and the message on standard input | A message cannot run an `agy` command, and cannot be taken for a flag. |
| The stream | Jet stops the reply, fails it and writes a line to the server's error output when the stream shows that a tool other than Jet's has run, or holds a line that `agy` 1.5.16 does not write. |

The notes review runs as a second agent, `jet-review`, with `agy`'s `finish` tool only, which an answer in a schema needs, and without Jet's tool server.

Each chat has a folder of its own for its turns, below the system's temporary folder (`jet-agy-…-chat-<id>`), never the data folder. The turns of two users run at the same time, and the folder holds the token of the running turn, so no two chats share one. Jet makes the folder open to the service user only. It does not run `agy` in a folder that belongs to another user, that other users can open, or that is a link, or below a folder that holds `.git` or one of the folders `agy` reads its files from (`.agents`, `.agent`, `_agents`, `_agent`).

### What the server needs

- **The `agy` program, version 1.5.16.** The limit was proven on that version, on macOS. No part of it was run on Linux. Jet asks the program for its version and runs it only at 1.5.16; at any other version every `agy` reply fails and says so. `agy` replaces itself with a newer version in the background, and that would stop this provider. To keep the proven version, install it in a folder that the service user cannot write, for example `/usr/local/bin` owned by root, and let an admin save that path as `agyPath`.
- **A sign-in for the service user.** Run `agy` once as that user. It prints an address to open on another machine, and takes the code that the page gives. The `agy` process keeps the service user's `HOME`, and Jet removes every `*_API_KEY` and every `JET_*` variable from its environment.
- **`sh` and `awk`** for the hook.
- **A `~/.gemini` folder that the service user can write.** `agy` has no session that is not kept. Each chat session and each notes review of every user leaves a conversation with the text of its turns in the service user's `~/.gemini/antigravity-cli/`, and each run leaves a log file there.

## GitHub activity

`github_activity {repo, since}` lets Jet look at a repository before it asks the user about it.
Jet's server asks GitHub's REST API (`https://api.github.com` only, no redirect to another host,
10 seconds and 2 MiB at most for each answer) and gives back the last push, the commits since
`since`, the open pull requests and the issues updated since then, each with its address, and
when they were fetched. Public repositories need nothing: GitHub allows 60 requests an hour from
one address without a token, and one call makes four. For a private repository the signed-in user
pastes a token once in Settings (a fine-grained token with read access to Contents, Pull requests,
Issues and Metadata of that repository is enough). `GET`, `PUT` and `DELETE /api/github/token`
answer only whether one is saved; the token is never sent back, and it is kept out of
the settings, the prompt, the events, the transcript and the logs. It is stored in the user's
row of `jet.sqlite3`, sealed with ChaCha20-Poly1305 under the key `github-token-key` in the data
directory, made on first start with owner-only access, or `JET_GITHUB_TOKEN_KEY` (at least 32
bytes). Changing the key makes every saved token unreadable, and Jet then asks the user to paste
it again. A call uses only the token of the user who sent the message. When GitHub asks for a wait
of 10 seconds or less, the call waits once and tries again; a longer wait, a refused token and an
unreachable GitHub come back as errors that tell Jet what to say to the user.

## Objectives and agent-tasks

Jet records what the user is working towards, and what it sets itself to do, by itself, from the
conversation; the user fills in no form. Six facade tools do it, each acting for the user of the
turn only, and every row is private to its owner until the owner shares it (see Sharing an objective):

- `objectives_list` reads the user's objectives with their steps, sources, update notes and waiting
  agent-tasks. Duration (start to due date) and days left are worked out on every read, never stored.
- `objectives_update` takes one typed `command`: `create` (title, deliverable, due date, optional
  start date, steps and sources, and the **first check**, which it cannot be made without; `chat`
  is `new` for a chat of its own or `this` to take the current one), `edit`, `step_add`, `step_tick`,
  `dates` (with the reason), `note` (status `on track`, `at risk`, `blocked` or `done`, what moved,
  blockers, and a `private` flag) and `close` (`done` or `dropped`, which also cancels the waiting
  checks). Every change raises the objective's `version`.
- `tasks_list` reads Jet's own agent-tasks and its newest runs, so Jet looks before it adds one.
- `tasks_update` takes `schedule` (with an `objectiveId` it moves that objective's open check, or adds
  it; without one it adds a follow-up in this chat) or `cancel`. There is at most one open check for
  an objective.
- `people_list` reads the directory: users with their teams and manager, and the teams.
- `people_update` is for admins only and takes one typed `command`: `team_add`, `team_rename`,
  `member_add`, `member_remove`, `manager_set` or `manager_clear`. A refusal for anyone else is
  `adminOnly`. It shows as a card, and it is refused for the rest of a reply that read web text or a
  colleague's shared objectives, because a membership decides who sees what is shared with a team.

A source is `jet`, `github` (a repository and the user's GitHub login, which the server reads from the
user's saved GitHub token when Jet leaves it out), `web` (a page address or a search topic) or `app`
(an app and one of its tools; only the admin may name one, and only for a tool the app marks
read-only).

Jet writes every time as the user's local date and time. The page sends the user's time zone, its
IANA name, as `timeZone` in the body of `POST /api/chat/send`; the server keeps it on the user, turns
the local time into UTC with it, and refuses a time that is in the past, that the clocks skip, or that
cannot be read. When the clocks go back and a time happens twice, the earlier instant is taken. A
create with a new chat adds a chat of kind objective titled after the objective, opens it with a short
summary, and leaves a line in the chat where it was agreed. A create on the main chat only links it.
A turn in a chat may read pages on the hosts of the page sources of that chat's open objectives.

### Sharing an objective

An objective is shared with nobody until its owner says so. After the objective is agreed, Jet asks
once who should see it, finds "my manager", a team or named people with `people_list`, says who it
found, and when the user agrees calls `objectives_update` with `propose_share`: the objective and the
whole set of people and teams it should be shared with. That changes nothing. It makes a share card
in the thread, which lists each proposed person and team (with its members' names) with a tick, and
the people and teams the objective is shared with now, unticked, so a smaller set shows who would be
removed. The owner's tap on **Share** applies exactly the ticked entries, through
`POST /api/shares/proposals/{id}/apply` as the signed-in user; nobody else's tap, and nothing written
in a chat, applies a card, and a share is never added in any other way. The card then shows who the
objective is shared with, also after a reload (`GET /api/shares/proposals?ids=`), and Jet is told of
the tap on the user's next message in that chat.

A colleague's Jet reads what is shared with `objectives_list` and `owner`: the objectives of that
owner shared with the user directly or through a team, with title, deliverable, dates, status,
duration, days left, steps and the update notes that are not private. A private note, the objective's
chat, its sources and its agent-tasks are never returned, and when nothing is shared the answer is an
empty list, the same as for an owner with no objectives. Update notes reach the people an objective is
shared with as soon as they are written. The pane of an objective changes who it is shared with
through `POST /api/objectives/{id}/share-proposals` and the same tap, shows it with
`GET /api/objectives/{id}/shares`, and flips a note with `PUT /api/objectives/{id}/notes/{note}`.

### The plan pane (server)

`GET /api/pane` gives the signed-in user everything the right-hand pane draws, in one answer:
`objectives` (all of the user's own, active and closed, with duration, days left, steps, notes with
the private ones, sources, who each is shared with, `private` while it is shared with nobody, and its
chat id), `tasks` (Jet's open agent-tasks with the due instant, the user's zone, the one-line why, the
objective's title, who set it and `isDefault` when the server set the time), `runs` (the newest
twenty, each with a `cost` once the run has one) and `sharedWithMe` (what colleagues shared: owner
name, title, due, days left, steps and the latest public note, never a private note, chat or
source). The one-tap controls are `PUT /api/objectives/{id}/steps/{step}` with `{"done": true|false}`,
`POST /api/tasks/{id}/snooze` (to the next 08:00 in the user's zone, strictly after now) and
`POST /api/tasks/{id}/cancel`. Each acts only on the signed-in user's own things, answers another
user's id as a missing one (404), carries the same `Origin` rule as every change, and raises the
version of what it changed. Each tap, the note flip and a share tap are kept and Jet is told of each
once, before the user's next message in the chat it concerns. `Chats::pane_changed(user)` puts
`{"kind":"paneChanged"}` on the user's one event stream; a tool's `objectives_update` or
`tasks_update` and every tap call it, and the people an objective is shared with hear of a change to it
too. A finished check will call it once the scheduler is wired to it (the scheduler's job, not yet done);
`pane_changed_publishes_pane_changed_to_that_users_stream_only` proves only that the call publishes.

### The plan pane (page)

`ui/plan/` draws the pane: `model.js` (pure words and counts, tested against `tests/fixtures/pane.json`),
`view.js` (the cards), `pane.js` (reading, taps, open state) and `plan.css`. It reads `GET /api/pane`
once on load and again on each `paneChanged` event of the one stream (also after the stream
reconnects), so Jet's replies, finished checks and taps in another window show with no reload.
Sections, in order: a glance strip, Objectives (active ones with dates, days left, steps you can
tick, the latest note with its lock and a private/shared flip, who it is shared with, the chat; done
and dropped ones fold below), Jet's plan (each open task in the user's zone with Snooze and Cancel,
and a mark when the time is the server's default), Recent checks (how each ended in plain words, what
it found, sources, tokens and cost) and Shared with you. An empty pane only invites the user to tell
Jet what they are working on; nothing in it is a form. "Change who sees it" opens the share card
inside the pane (a card needs someone to start from, so a private objective offers "Ask Jet to
share", which opens its chat). At 1024 px and wider the pane takes a column and the choice to close
it is kept in the browser (`jet.pane`); below that one button in the corner of the chat opens it over
the chat, with a count of what is new since the user last opened it (`jet.pane.seen`). A later
section, such as the messages the user sent to colleagues' Jets, is a new field of the read, a new
function in `view.js` added to `planNodes`, and needs no new event.
`tests/browser/plan.mjs` drives it against the real host.

## Checks

A check is a turn that starts by itself, with no message from the user, when an agent-task Jet set
for itself falls due. Jet reads the evidence of the objective first, then posts a short check-in in
the objective's chat, or stays silent, records what it found, and sets its own next check.

- **The scheduler** (`crates/jet/src/scheduler/`) is one thread. It sleeps until the first waiting
  task falls due (at most a minute), wakes at once when a task changes or a reply ends, and claims
  one due task at a time with a conditional update, the task that fell due first before the others.
  It runs one check at a time. A task whose chat is answering the user waits for the reply to end.
- **The turn** is fresh and leaves nothing in the chat's provider session, as the notes review does,
  with the user's own persona, notes, model and thinking effort. Its prompt is the brief
  (`crates/agent/src/conversation/wake.md`), built from the database when the check starts: the
  local time and zone, the task's reason and how late it runs, the objective with its steps and
  sources, whether the last check-in was answered, answered with a reaction, unanswered or unread,
  how many in a row went unanswered, when the user last wrote, the chat's last entries (as data,
  inside tags that say they hold no instruction) and the check rules, which begin with the style
  rule of a caring accountability buddy.
- **The binding is read-only.** A check may call `github_activity`, `objectives_list` (the user's own),
  `tasks_list`, `people_list`, `chats_read`, a source's app tool while the app still marks it
  read-only, and `tasks_update` with `checked`, by which Jet records in one line what it found and,
  with `next` (local time, at least ten minutes away) and `why`, when it looks next. The record
  waits in the binding until the commit. Every other tool is refused. Page reading is limited to the
  hosts of the objective's page sources. A provider with web tools off holds a check of an objective
  with a web source.
- **The evidence guard** is the server's: a check-in is posted only if every outside source of the
  objective (each repository, page, search topic and app tool) was read with success at least once
  in the run. If not, nothing is posted, the run is `held` with the reason, and the task tries once
  more fifteen minutes later; a second held run ends the task with the default next check. An
  objective with only Jet's own records as source, and a follow-up with no objective, need no read.
- **Silence.** An answer that holds `[SILENT]`, alone or inside other text, writes no entry; the run
  is `silent`, with what Jet found.
- **One commit** settles the entry of Jet (marked as a check-in, with the cards of what it read),
  the run (`spoke`, `silent`, `held`, `failed`, `interrupted`, `preempted` or `stale`, what was
  found, sources read, tokens, and cost where the provider gives one) and the next agent-task, only
  if the task is still running under that run and neither the task nor the objective changed since
  the facts were read. Otherwise the result is dropped as `stale`: a cancelled task stays cancelled, a
  moved one keeps its time, and when only the objective changed the check runs again a minute later,
  at most three times in a row. When Jet sets no next check the server sets one 24 hours later and
  marks it `default`. A check never writes an update note.
- **Delivery.** The check-in lands in the objective's chat (a follow-up in the chat where Jet set
  it), raises that chat's unread count on an open page and in the snapshot, and waits. There is no
  push message and no mail.
- **The user comes first.** A message in the chat where a check runs stops the check, drops what it
  staged, and the task runs again ten minutes later without counting as an attempt.
- **Restarts.** A task found running at start waits a minute and counts the attempt; after three
  cut-off attempts it fails, with one notice. Tasks that fell due while the server was down run once
  each, oldest first, and the brief says how late they are. A check of a closed objective is never
  set back to waiting.
- **Limits.** One dollar per check on Claude Code (`--max-budget-usd 1.00`); five minutes per check
  on a provider with no money limit; either limit fails the task, with one notice. When the database
  cannot be written the scheduler pauses, says why in the log once, and claims nothing until Jet
  restarts.
- After a chat turn that read web text, `objectives_update` with `propose_share`, a `create` with
  sources or an `edit` that sets sources is refused, as `apps_update` is.

Tests move time with `JET_TEST_CLOCK_FILE`: the host reads Unix seconds from that file whenever it
asks for the time (the real time while the file is missing), and its scheduler then looks every
20 ms. `JET_TEST_CHECK_LIMIT_MS` shortens the five-minute limit. The stand-in provider takes the
script of a check from `check-script.json` in the data directory.

## Quanty

Quanty normally listens on `127.0.0.1:7878`. Jet integration needs its explicit
loopback-only trusted mode; ordinary password/token modes remain available for
standalone use.

For a working integration, prepare Quanty independently of Jet:

1. **Build the browser UI before the server.** Install Rust/Cargo, the
   `wasm32-unknown-unknown` target, and Trunk following Quanty's README. From the
   Quanty checkout, run:

   ```sh
   rustup target add wasm32-unknown-unknown
   (cd crates/web-ui && trunk build --release)
   cargo build --release --locked -p server
   ```

   The server embeds `crates/web-ui/dist` at build time. Repeat both builds after
   a UI change, install the new server executable, and restart Quanty. A server
   built without the bundle can expose its descriptor and MCP tools while `/`
   returns HTTP 503 with “The UI bundle is not built.” Successful tool discovery
   does not establish that the browser UI is ready. Keep Trunk's `public_url`
   set to `"./"` so assets work below Jet's `/apps/{id}/` mount.

2. **Prepare the library and its dependencies.** Normal library operations need
   Qdrant and FalkorDB, with persistent storage and matching connection settings
   in Quanty's `.env`. The usual local ports are Qdrant gRPC `6334` (HTTP `6333`)
   and FalkorDB `6379`; these stores stay on loopback. Configure
   `EMBEDDING_GEMINI_API_KEY` for embeddings, `CONVERTER_JEV_API_KEY` for PDF math
   conversion, and Poppler for PDF processing. On a host with an IPv6 address,
   check that Google serves it: if Gemini answers `User location is not supported`
   over IPv6 and `200` over IPv4, set `EMBEDDING_GEMINI_IPV4_ONLY=true` in
   Quanty's `.env` (see Quanty's `docs/troubleshooting.md`). Install and sign in to the selected

   Codex or Claude CLI as the account running Quanty; keep `ANTHROPIC_API_KEY`
   unset for Quanty's subscription-based Claude use. These requirements depend
   on the operation; the isolated fixture below needs none of them. Use Quanty's
   health display to check stores and model tools; a responding HTTP process or
   MCP catalogue alone does not validate keys or library readiness.

3. **Run in trusted integration mode on loopback.** Leave `QUANTY_PASSWORD` and
   `QUANTY_MCP_TOKEN` unset or empty in both the service environment and the
   library's `.env`. Trusted mode rejects configured credentials and a non-loopback
   listener. Unsetting shell variables alone is insufficient when `.env` still
   supplies them. Keep the library/home path explicit, since it selects `.env`
   and library data. With the release build above:

   ```sh
   /path/to/quanty/target/release/quanty --home /path/to/your/library \
     --listen 127.0.0.1:7878 --trusted-integration
   ```

4. **Keep Quanty running independently.** Jet only registers and forwards to it.
   Its service needs the correct home/working directory, `.env`, executable and
   `PATH`, plus persistent store services. On this server, inspect
   `systemctl --user status quanty quanty-stores` and
   `journalctl --user -u quanty -n 50 --no-pager`. The user services need lingering
   enabled to survive logout and start at boot. After changing a unit or drop-in,
   run `systemctl --user daemon-reload` and restart Quanty.

5. **Verify UI and tools separately, then register.** On the Jet server:

   ```sh
   curl --fail http://127.0.0.1:7878/
   curl --fail http://127.0.0.1:7878/jet-app.json
   ```

   Expect the UI to return HTTP 200 and the descriptor to declare
   `embedding: "relative-paths"`, `ui: "./"` and `mcp: "mcp"`. In Jet, run
   `/app add 7878 "Quanty"` once; for an existing registration, use
   `/app reload Quanty`. Open `/tools Quanty` to check MCP discovery without
   executing paid searches. On this deployment, 18 tools were discovered with
   no stale/error status. Finally open Quanty in Jet and check its UI renders.

For HTTPS Jet, set `--public-origin` to the actual public HTTPS origin (here,
`https://xchainanalytics.com`). Only Jet's reverse proxy needs public ports 443
and 80; Quanty remains on loopback HTTP and needs no separate public port or
certificate. The proxy must support streaming and WebSockets. Trusted Quanty
inherits Jet's access boundary: its page and API are reached only through a sign-in.

For a free, isolated trial, use a separate port and fresh home. This does not
replace an already running Quanty:

```sh
QUANTY_TEST_HOME=$(mktemp -d /tmp/quanty-jet-acceptance.XXXXXX)
env -i PATH="$PATH" /path/to/quanty/target/release/quanty \
  --home "$QUANTY_TEST_HOME" --listen 127.0.0.1:18878 \
  --fixture black-scholes --trusted-integration
```

Add `18878` in Jet. The trusted fixture exposes free tools: `catalog` lists them
by group, `search` and `fixture_page` read a built-in sample with a figure for
source cards and citations, and a fake `ingest_pdf` starts a job that
`watch_job` follows through the stages of a real ingest. Normal search is
unchanged. This fixture needs no accounts, ingestion or paid provider calls;
asking a real chat provider to use it still uses that provider.

Mounted apps must use relative browser paths. Remote URLs do not supply login or
SSO, and framing restrictions still apply to direct embedding. Jet does not read
iframe DOM, selection or storage. See the [app contract](docs/app-contract.md)
for supported content URLs and deployment limits.

## Layout and checks

- `crates/agent`: provider processes, conversations, memory, app registry and tool contracts.
- `crates/jet`: browser server and static UI.
- [App integration contract](docs/app-contract.md): descriptors, stable registry identity and forwarding rules.
- [Host and UI notes](crates/jet/README.md).
- [Browser acceptance commands](crates/jet/tests/browser/README.md).
- [Character policy](crates/jet/character-policy.md).

```sh
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt --all -- --check
(cd crates/jet/ui && node --test)
```

These checks use local free fixtures. Browser host integration tests require Python 3 for the controlled CLI stand-in. No desktop SDK or webview is needed.

Optional feelings use `JEV_API_KEY`, with the existing nearest-`.env` lookup. That service is separate from the provider; absence or failure falls back to neutral. Only deliberately run live tests with `REX_PROD_API=true` when intending to contact that service.

Voice (Jet speaking and hearing, its keys, limits and how the page uses the microphone) is described in [docs/voice.md](docs/voice.md).
