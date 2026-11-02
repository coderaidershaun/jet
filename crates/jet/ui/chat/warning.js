// A voice problem marks its button for as long as it lasts, but is said in the thread only once, not once for each clip
// or sentence that fails the same way. The mic and the speaker both use it.

/**
 * @param {{ show: (message: string | null) => void, say: (message: string) => void }} options
 *   `show` marks the button with the problem, or clears the mark with null; `say` adds a notice to the thread
 */
export function createWarning({ show, say }) {
  const said = new Set();
  return {
    /** The problem in the person's words, or null once Google has answered again. A message already said adds nothing until then. */
    report(message) {
      show(message);
      if (message === null) said.clear();
      else if (!said.has(message)) {
        said.add(message);
        say(message);
      }
    },

    /** The button was switched on, so a problem that was said before is news again. */
    switchedOn() {
      said.clear();
    },
  };
}
