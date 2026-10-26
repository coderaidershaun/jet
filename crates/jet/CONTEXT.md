# Jet glossary

The domain words of the `jet` crate, each with one meaning. [The character policy](character-policy.md) holds the geometry and motion rules.

- **Kite** — Jet's blue body, bow, black eyes and pale string, drawn in a 200 × 240 reference frame.
- **Form** — the body's 52 ordered outline points: kite or spinner, or a point-by-point blend between them.
- **Point** — one sample of an outline or string. The kite's top is index 0, right corner 13, tip 26, left corner 39.
- **Tip** — the bottom point of the kite, about which it turns while standing. The bow's bottom rests on ground y 238.
- **Standing** — tip at (100, 231.8), height track `y = 0`, string lying left along the lane floor.
- **Hovering** — reference centre (100, 88), tip (100, 173), height track `y = 58.8`, string hanging in the wind.
- **Part** — geometry for a body form, eyes, folded corner or string, in `ui/jet/parts/`.
- **Draw** — `ui/jet/draw/`: pure `paint(frame, { unitPx })` creates SVG nodes; `view.js` mounts once and updates attributes. _Avoid_: render (that means Markdown to HTML).
- **State** — the thirteen authored values in `JetState`: y, roll, lift, squash, form, lids, eyeKind, anger, squint, payout, stringPose, written and drift. _Avoid_: using it for idle or working.
- **Frame** — state composed with idle layers, delayed roll, corner speed/stretch, eyes, pivot and string points, ready to draw.
- **Status** — the director's current activity: `idle`, `flying`, `reacting` or `working`. `flying` also covers settle. _Avoid_: mood, state.
- **Track** — keys for one authored state field; `eyeKind`, `stringPose` and `written` hold choices instead of interpolating them.
- **Key** — `{ t, v, e }`: milliseconds, value, and the easing used while arriving at it.
- **Easing** — a curve used to sample a track: a cubic Bézier or one of the motion scripts' exact curves.
- **Clip** — a builder's tracks, total duration, named phases and optional reveal phase. It starts from live state and is copied by the player.
- **Phase** — a named interval of a clip, recorded with its end time. `revealFrom` names the phase whose start permits text.
- **Beat** — one move within a phase, such as dip, wag, brake or clench.
- **Hello** — the wave emotion: a lifted corner, folded hand, delayed roll and wink; brief has one wag and no wink.
- **Insulted** — the flip emotion: scowl, shiver, lean, J-shaped string and one written fist/finger stroke, then unwind.
- **Fly** — anticipation, launch, cruise and brake; the host carries Jet only during cruise.
- **Settle** — the landing, round eyes at contact, squash/rebound and string laid left: 1080 ms after a reply, or a gentle 1800 ms from Jet's live height when the wind had it.
- **Drift** — the wind has Jet: after 20 s of quiet in a lane it lifts off the floor and is blown about slowly until the user types.
- **Gust** — a 2.8 s stronger puff during a drift: it lifts, leans and carries Jet right, and streams the string.
- **Hold** — a clip deliberately ending away from rest. `working` and `drift` are the holds; `workingEnd` closes the first, and a send, typing or any other clip ends the second.
- **Spinner** — the body's C-shaped working form, with hidden eyes and the string reeled into the bow.
- **Payout** — the multiplier of string segment lengths, normally 1; the J uses about 1.592.
- **Written route** — the local polyline the string's free end traces, with a length, scale and tremor.
- **Settings** — saved reduced motion, persona, model/provider, memory-related choices. App registrations live separately. Rust owns the file format in the app.
- **Reduced motion** — app setting combined with the system preference: always grounded, no flight, blink, idle oscillation or spinner rotation; the form still morphs.
- **Animation catalogue** — `ui/jet/clips/catalogue.js`, the builders and hold flags for all seven clips.
- **Director** — chooses and queues clips from chat events and feelings; reads only the time supplied by the host.
- **Emotion** — a feeling with an authored animation: `hello` or `insulted`; `neutral` has none. `EMOTIONS` maps words to clips.
- **Mood** — the supported word at the start of the provider's reply: `neutral`, `hello` or `insulted`. Unknown saved words read as neutral.
- **Feeling** — `{ mood, scores }`, classification of the user's message before model dispatch; the request may carry the supported word as prompt context.
- **JEV** — the optional external classifier; credentials are read on each call from the environment or nearest `.env`, never from Settings.
- **Reveal deadline** — `revealAt`, an absolute monotonic time consumed by `holdUntil(at)`; streamed and successfully completed text both wait until it.
- **Player** — owns live state, samples clips and adds secondary motion, idle layers, blinks and the deterministic string chain.
- **Host** — the page that places Jet, supplies time, measured scale and carry, and forwards chat events.
- **Bridge** — `ui/bridge/`, the chat page’s HTTP commands and server-sent events.

- **Turn** — one exchange: the user's message and Jet's reply, from the send to the finished, failed or stopped end.
- **Event** — one step of a streamed reply as the chat page receives it: started, a mood, text, a notice, or a tool call started or finished; exactly one of finished, failed or stopped ends the reply. _Avoid_: message (that is what the user sends).
- **Session** — the selected provider conversation Jet resumes (`session.json`). A fresh one starts when the prompt inputs change, after a long idle with a big context, or when the old one vanished. _Avoid_: thread, history.
- **Provider** — the installed program that answers the chat and runs the notes review, Claude Code or Codex, chosen by the model setting; when it is missing, replies fail with the searched locations. _Avoid_: transport (the agent crate’s provider interface).
- **Transcript** — the app's own record of the thread (`transcript.jsonl`). The chat page opens on its newest entries, which the code calls the history. _Avoid_: session.
- **Notes** — MEMORY, USER and RECENT: the three short files in Jet's prompt that a background review keeps current. The memory commands and the memory section of the settings handle all three.
- **App** — an independently running UI and optional HTTP MCP endpoint, registered by stable ID in `apps.json`.
- **Tool call** — one use of a registered app tool during a reply: started, then finished with its result and a one-line summary; kept with the reply in the transcript.
- **Card** — what the thread shows for one tool call, above the reply's text: a line with a spinner while the call runs, then a folded card of what came back, or of the failure. _Avoid_: widget, panel.
- **Source** — one item a library search or answer gives back, numbered from 1, with its document, page and kind. _Avoid_: result (that is the whole reply of a tool), hit (that is what a source holds).
- **Citation** — `[n]` in Jet's text, shown as a chip that opens source n of the nearest card above it. _Avoid_: reference, footnote.
- **MCP client** — the shared host-owned HTTP service used by chat and tool browsing. It never starts app processes.
- **Facade** — the six stable MCP tools exposed to each provider, routing by app ID and real tool name.
- **Turn binding** — temporary server-issued correlation connecting facade actions to the initiating browser. It expires on completion, failure or Stop.
- **Tool catalogue** — an app’s MCP tool definitions and server metadata, shared by the assistant and Tools browser.
- **Workspace** — the main content showing Jet chat, a selected app, or the tool browser. Last selected app identity adds context without limiting available tools.
- **Drawer** — the persistent left navigation for Jet and apps, with the context capacity and settings. It collapses to icons while viewing an app.


- **Lane** — the column at the left of each Jet row, where the live Jet stands. The lane of an older row stays empty once Jet has moved on.
- **Slot** — the row of the reply on its way; Jet lands in its lane. _Avoid_: placeholder.
- **Flight** — the live Jet's move from where it stood to the slot's lane on a send, during the fly clip's cruise. The path bows right, overshoots by 5 px and lands; the host translates and scales the node, while the player supplies lean and string drag.
- **Math** — TeX in a reply, between `\(` and `\)`, or for display between `\[` and `\]` or `$$` and `$$`. A single `$` is money, never math.
- **Typeset** — turning a math element's TeX into KaTeX's drawing on the page. _Avoid_: render (that is Markdown to HTML).
