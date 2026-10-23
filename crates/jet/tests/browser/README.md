# Browser acceptance checks

Install the small independent fixture's WebSocket implementation once:

```sh
npm ci --prefix crates/jet/tests/fixtures --ignore-scripts
cargo build --workspace
REX_PROD_API=false cargo test -p jet --test integration proxy::
```

The fixture uses Node and `ws`; it makes no provider or business calls. The Rust
integration tests launch the real Jet executable and independent fixture processes.
The upload test waits for a forwarded response chunk before finishing its request,
so buffering either entire body fails the test. A silent TLS peer checks the full
connection deadline separately from stream duration.

Run actual Chrome with a local Playwright installation and the built Quanty trusted
fixture/WASM bundle. Temporary certificates and data stay outside the repository;
only this browser context ignores certificate errors. The TLS front forwards Jet
traffic; actual Jet performs every app proxy operation.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_BINARY='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
QUANTY_BINARY=/absolute/path/to/quanty/target/debug/quanty \
ARTIFACT_DIR=/tmp/jet-proxy-browser \
node crates/jet/tests/browser/proxy.mjs
```

`SKIP_QUANTY=1` explicitly runs only the generic HTTPS/WSS and frame scenarios.
Full acceptance requires the Quanty scenario. Screenshots and network JSON are
written to the artifact directory. The script never touches an existing app process.

Build the Quanty fixture binary and actual browser bundle in its checkout:

```sh
(cd crates/web-ui && trunk build --release)
cargo build -p server
```

The harness uses its own fresh Quanty home and port; leave existing services such
as the normal `127.0.0.1:7878` instance running. Only the trusted fixture’s free
operations are used.

For genuine network separation, cross-build Jet for Linux and run Jet plus both
fixtures in a test Docker container. With the matching GNU cross compiler installed:

```sh
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-unknown-linux-gnu-gcc \
CC_x86_64_unknown_linux_gnu=x86_64-unknown-linux-gnu-gcc \
CARGO_TARGET_DIR=/tmp/jet-proxy-linux-target \
cargo build -p jet --target x86_64-unknown-linux-gnu
```

Use an amd64 Linux container compatible with that binary. Publish **only** Jet's port. Bind the fixtures
to container loopback. For example, in an Ubuntu container with Node installed and
this repository mounted at `/workspace` and the Linux target directory at `/build`:

```sh
FIXTURE_PORT=18181 FIXTURE_NAME=First node /workspace/crates/jet/tests/fixtures/proxy.mjs
FIXTURE_PORT=18182 FIXTURE_NAME=Second node /workspace/crates/jet/tests/fixtures/proxy.mjs
/build/x86_64-unknown-linux-gnu/debug/jet --listen 0.0.0.0:8787 \
  --public-origin http://127.0.0.1:18787 --data-dir /tmp/jet-data \
  --ui-dir /workspace/crates/jet/ui --disable-feelings
```

Run those three processes concurrently; wait for both fixture startup messages
before registering them. Publish container port 8787 as host 127.0.0.1:18787. Then
run the host browser outside the container:

```sh
NAMESPACE=1 JET_URL=http://127.0.0.1:18787 \
FIXTURE_URL=http://127.0.0.1:18181/notes/ \
SECOND_FIXTURE_URL=http://127.0.0.1:18182/notes/ \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_BINARY='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
ARTIFACT_DIR=/tmp/jet-proxy-browser \
node crates/jet/tests/browser/proxy.mjs
```

The namespace scenario checks HTTP, WebSocket echo and retained state. Stop and
remove only the container created for this check.

## Workspace shell

The workspace harness starts its own Jet, two generic app fixtures and a temporary
free CLI provider. It checks slash registration, retained iframe/chat state, explicit Stop,
selected context capture before feeling classification, drawer/rail navigation, targeted endpoint reload,
keyboard focus and responsive content. It never uses an installed paid provider.

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_BINARY='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
ARTIFACT_DIR=/tmp/jet-workspace-browser JOINT_FACADE=1 \
node crates/jet/tests/browser/workspace.mjs
```

Build the workspace and install fixture dependencies as above first. Screenshots,
viewport geometry and captured send/stop requests are written to the artifact
directory. `JET_BINARY` optionally selects a previously built local Jet executable.

`JOINT_FACADE=1` also requires automatic cross-client registry notifications,
provider-observed selected app context and session continuity across app switches.
Run this mode for the integrated application acceptance gate.

## Commands and tool discovery

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_BINARY='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
ARTIFACT_DIR=/tmp/jet-commands-browser \
node crates/jet/tests/browser/commands.mjs
```

This harness checks deterministic slash actions, ordinary-language registry changes
through a free provider fixture, browser-local app opening across two tabs, and
bounded progressive discovery. Browsing never runs a business tool.

## Joined application acceptance

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_BINARY='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
QUANTY_BINARY=/absolute/path/to/quanty/target/debug/quanty \
ARTIFACT_DIR=/tmp/jet-acceptance-browser \
node crates/jet/tests/browser/acceptance.mjs
```

The joined scenario registers Quanty by port with a label and a generic app by
full URL. It uses the actual Quanty WASM UI and free fixture search to exercise
source images and citations while another app is visible. It also covers stale
metadata, restart, disable/remove, hidden replies, browser reload and persistence
across Jet restart. Run it alongside the proxy, commands and joint workspace
harnesses; it does not replace HTTPS/WSS or namespace coverage.

Harnesses own only the processes they start. Their shared process helper treats a
graceful-shutdown timeout as failure, even when it subsequently force-cleans an
owned child. Artifacts describe the run; these commands alone are not a claim that
checks passed. Browser evidence is specific to the selected Chrome build.
