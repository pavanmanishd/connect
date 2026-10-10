import React from 'react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { fireEvent, render, screen } from '@testing-library/react';

import * as Types from '../../actions/types';
import { currentOffset, seekTo } from '../../timeline';
import DriveVideo from '.';

const ROUTE = { fullname: 'a2a0ccea32023010|2023-07-27--13-01-19', duration: 300000, start_time_utc_millis: 0 };

function renderVideo({ loop = { startTime: 60000, duration: 30000 }, children } = {}) {
  const actions = [];
  const store = createStore((state, action) => {
    actions.push(action);
    return state;
  }, { currentRoute: ROUTE, loop, desiredPlaySpeed: 1 });
  const view = render(<Provider store={store}><DriveVideo>{children}</DriveVideo></Provider>);
  const typed = (type) => actions.filter((action) => action.type === type);
  return { ...view, typed };
}

// a pointer press that says what pointed, which jsdom's events do not
function press(element, pointerType) {
  const down = new MouseEvent('pointerdown', { bubbles: true });
  Object.defineProperty(down, 'pointerType', { value: pointerType });
  fireEvent(element, down);
  fireEvent.click(element);
}

describe('drive video', () => {
  it('is the playback clock while mounted', () => {
    const { typed } = renderVideo();
    expect(currentOffset()).toEqual(60000);
    seekTo(500000);
    expect(currentOffset()).toEqual(90000);
    expect(typed(Types.ACTION_SEEK)).toEqual([{ type: Types.ACTION_SEEK, offset: 90000 }]);
  });

  it('plays the drive video and lets go of it when closed', () => {
    const { container, unmount } = renderVideo();
    const video = container.querySelector('video');
    expect(video.getAttribute('src')).toContain(ROUTE.fullname);
    expect(video.muted).toBe(true);
    unmount();
    expect(video.getAttribute('src')).toBeNull();
    expect(currentOffset()).toEqual(0);
  });

  it('reports play and speed changes', () => {
    const { typed } = renderVideo();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(typed(Types.ACTION_PLAY)).toEqual([{ type: Types.ACTION_PLAY, speed: 1 }]);
    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '2' } });
    expect(typed(Types.ACTION_PLAY).at(-1)).toEqual({ type: Types.ACTION_PLAY, speed: 2 });
  });

  it('changes speed without starting playback', () => {
    renderVideo();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play');
    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '2' } });
    expect(play).not.toHaveBeenCalled();
    play.mockRestore();
  });

  it('plays on a click and shows the controls on a tap', () => {
    const { container, typed } = renderVideo();
    press(screen.getByTestId('video-surface'), 'mouse');
    expect(typed(Types.ACTION_PLAY)).toHaveLength(1);

    // playing hides the controls until a tap
    fireEvent(container.querySelector('video'), new Event('play'));
    const bar = () => screen.getByRole('button', { name: 'Pause' }).parentElement;
    expect(bar()).toHaveClass('opacity-0');
    press(screen.getByTestId('video-surface'), 'touch');
    expect(typed(Types.ACTION_PLAY)).toHaveLength(1);
    expect(bar()).toHaveClass('opacity-100');
  });

  it('goes fullscreen with the whole player', () => {
    const { container } = renderVideo();
    const stage = container.querySelector('video').parentElement;
    stage.requestFullscreen = vi.fn(() => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(stage.requestFullscreen).toHaveBeenCalled();

    document.fullscreenElement = stage;
    document.exitFullscreen = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(document.exitFullscreen).toHaveBeenCalled();
    delete document.fullscreenElement;
    delete document.exitFullscreen;
  });

  it('goes fullscreen with the video itself on iPhone once it has loaded', () => {
    const { container } = renderVideo();
    const video = container.querySelector('video');
    video.webkitEnterFullscreen = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(video.webkitEnterFullscreen).not.toHaveBeenCalled();

    Object.defineProperty(video, 'readyState', { value: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(video.webkitEnterFullscreen).toHaveBeenCalled();
  });

  it('keeps playing under the map with the controls below it', () => {
    const { container } = renderVideo({ children: <div data-testid="map" /> });
    expect(screen.getByTestId('map')).toBeInTheDocument();
    expect(container.querySelector('video')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });
});
