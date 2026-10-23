# Registered app proxy checks

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

For genuine network separation, cross-build Jet for Linux and run Jet plus both
fixtures in a test Docker container. Publish **only** Jet's port. Bind the fixtures
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
before registering them. Publish container port8787 as host127.0.0.1:18787. Then
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
