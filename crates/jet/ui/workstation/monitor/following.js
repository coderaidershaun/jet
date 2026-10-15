// Whether the reader of each channel list is at the newest rows, and how many rows came in since
// the reader left them. A list is at the newest rows when it is scrolled to its top.

/** The scroll offset, in pixels, that still counts as the top; it absorbs rounding. */
const TOP_EPSILON = 1;

/** @param {readonly string[]} names one slot for each list */
export function createFollowing(names) {
  const slots = new Map(names.map((name) => [name, { following: true, seen: 0 }]));

  return {
    /** The reader scrolled the list. `appended` is the channel's running row count. */
    scrolled(name, scrollTop, appended) {
      const slot = slots.get(name);
      const atTop = scrollTop <= TOP_EPSILON;
      if (atTop || slot.following) slot.seen = appended;
      slot.following = atTop;
    },

    /** The reader jumped to the newest rows, or the rows started over. */
    follow(name, appended) {
      const slot = slots.get(name);
      slot.following = true;
      slot.seen = appended;
    },

    isFollowing: (name) => slots.get(name).following,

    /** How many rows came in since the reader left the top. */
    unseen(name, appended) {
      const slot = slots.get(name);
      return slot.following ? 0 : Math.max(0, appended - slot.seen);
    },
  };
}

/** The badge's words: empty when there is nothing new. */
export const badgeText = (count) => (count > 0 ? count + ' new' : '');
