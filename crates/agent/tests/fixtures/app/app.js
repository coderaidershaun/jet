const status = document.querySelector("#status");
try {
  const response = await fetch(new URL("api/message", document.baseURI));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  status.textContent = (await response.json()).text;
} catch (error) {
  status.textContent = `App API unavailable: ${error.message}`;
}
