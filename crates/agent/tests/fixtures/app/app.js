// The page of the test app: it asks the app's own API for a message and shows it, or shows why it could not.
const status = document.querySelector("#status");
try {
  const response = await fetch(new URL("api/message", document.baseURI));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  status.textContent = (await response.json()).text;
} catch (error) {
  status.textContent = `App API unavailable: ${error.message}`;
}
