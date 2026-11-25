// Decides whether the thread keeps scrolling to new text. It follows while the
// reader is near the bottom, stops when they scroll up to read, and a send
// always brings them back.

const NEAR_BOTTOM_PX = 80;

export function createFollow() {
  let following = true;
  let far = false;
  return {
    get following() {
      return following;
    },

    /** The jump control waits until the reader is half a screen above the latest entry, so a small scroll does not flash it. */
    get jumpVisible() {
      return far;
    },

    /** @param {{ scrollTop: number, clientHeight: number, scrollHeight: number }} metrics */
    onScroll({ scrollTop, clientHeight, scrollHeight }) {
      const away = scrollHeight - scrollTop - clientHeight;
      following = away <= NEAR_BOTTOM_PX;
      far = away > Math.max(NEAR_BOTTOM_PX, clientHeight / 2);
    },

    onSend() {
      following = true;
      far = false;
    },
  };
}
