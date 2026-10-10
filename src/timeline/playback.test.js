import { currentOffset, registerPlayer, seekTo } from '.';
import { pause, play, reducer, resetPlayback, seek, selectLoop } from './playback';

describe('playback', () => {
  it('keeps the chosen speed', () => {
    let state = reducer({ desiredPlaySpeed: 1 }, play(2));
    expect(state.desiredPlaySpeed).toEqual(2);
    const same = reducer(state, play(2));
    expect(same).toBe(state);
    state = reducer(state, pause());
    expect(state.desiredPlaySpeed).toEqual(2);
    expect(reducer(state, seek(1000))).toBe(state);
  });

  it('resets the speed for a new selection', () => {
    expect(reducer({ desiredPlaySpeed: 4 }, resetPlayback()).desiredPlaySpeed).toEqual(1);
  });

  it('selects and clears a loop', () => {
    let state = reducer({ loop: null }, selectLoop(1000, 4000));
    expect(state.loop).toEqual({ startTime: 1000, duration: 3000 });
    state = reducer(state, selectLoop(null, null));
    expect(state.loop).toBeNull();
  });
});

describe('playback clock', () => {
  it('reads and seeks the registered player', () => {
    let position = 1234;
    const player = { offset: () => position, seek: vi.fn((offset) => { position = offset; }) };
    const unregister = registerPlayer(player);
    expect(currentOffset()).toEqual(1234);
    seekTo(5000);
    expect(player.seek).toHaveBeenCalledWith(5000);
    expect(currentOffset()).toEqual(5000);
    unregister();
  });

  it('is at the start without a player or before it has a position', () => {
    seekTo(2500);
    expect(currentOffset()).toEqual(0);
    const unregister = registerPlayer({ offset: () => null, seek: () => {} });
    expect(currentOffset()).toEqual(0);
    unregister();
  });
});
