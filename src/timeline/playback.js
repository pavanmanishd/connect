// playback settings the video element does not own: the chosen speed and the
// selected loop. Position, pausing and buffering come from the video itself.
import * as Types from '../actions/types';

export function reducer(state, action) {
  switch (action.type) {
    case Types.ACTION_PLAY:
      if (action.speed === state.desiredPlaySpeed) {
        return state;
      }
      return {
        ...state,
        desiredPlaySpeed: action.speed,
      };
    case Types.ACTION_LOOP: {
      const hasLoop = action.start !== null && action.start !== undefined
        && action.end !== null && action.end !== undefined;
      return {
        ...state,
        loop: hasLoop ? { startTime: action.start, duration: action.end - action.start } : null,
      };
    }
    case Types.ACTION_RESET:
      return {
        ...state,
        desiredPlaySpeed: 1,
      };
    default:
      return state;
  }
}

// seek to a specific offset, reported for analytics
export function seek(offset) {
  return {
    type: Types.ACTION_SEEK,
    offset,
  };
}

// a pause, reported for analytics
export function pause() {
  return {
    type: Types.ACTION_PAUSE,
  };
}

// a play or a new play speed
export function play(speed = 1) {
  return {
    type: Types.ACTION_PLAY,
    speed,
  };
}

export function resetPlayback() {
  return {
    type: Types.ACTION_RESET,
  };
}

export function selectLoop(start, end) {
  return {
    type: Types.ACTION_LOOP,
    start,
    end,
  };
}
