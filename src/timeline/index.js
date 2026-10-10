// The video element is the playback clock. DriveVideo registers itself as the
// player; the timeline, map and time display read currentOffset() on every
// frame and move playback with seekTo().

let player = null;

// returns a function that unregisters the player
export function registerPlayer(next) {
  player = next;
  return () => {
    if (player === next) {
      player = null;
    }
  };
}

/**
 * Get current playback offset
 *
 * @returns {number} milliseconds from the start of the route
 */
export function currentOffset() {
  return player?.offset() ?? 0;
}

/**
 * @param {number} offset milliseconds from the start of the route
 */
export function seekTo(offset) {
  player?.seek(offset);
}
