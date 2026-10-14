// Where the rig comes from: the Rust side inside Tauri, a relative fetch in a
// plain browser so the page still runs from a static server.

/** @returns {Promise<import('../jet/rig.js').Rig>} */
export async function loadRig() {
  const bridge = /** @type {any} */ (window).__TAURI__?.core;
  if (bridge) return JSON.parse(await bridge.invoke('rig'));
  const response = await fetch('../rig/jet.json');
  if (!response.ok) throw new Error('could not load the rig from ../rig/jet.json (status ' + response.status + ')');
  return response.json();
}
