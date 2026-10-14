// Decides whether the thread keeps scrolling to new text. It follows while the
// reader is near the bottom, stops when they scroll up to read, and a send
// always brings them back.

const NEAR_BOTTOM_PX = 80;

export function createFollow() {
  let following = true;
  return {
    get following() {
      return following;
    },

    /** The "Jump to latest" pill shows while the reader is away from the bottom. */
    get jumpVisible() {
      return !following;
    },

    /** @param {{ scrollTop: number, clientHeight: number, scrollHeight: number }} metrics */
    onScroll({ scrollTop, clientHeight, scrollHeight }) {
      following = scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX;
    },

    onSend() {
      following = true;
    },
  };
}
