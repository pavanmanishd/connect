import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import Controls, { playbackTime } from './Controls';

const route = { fullname: 'a2a0ccea32023010|2023-07-27--13-01-19', start_time_utc_millis: new Date(2023, 6, 27, 13, 1, 19).getTime() };

function renderControls(props = {}) {
  const handlers = {
    onTogglePlay: vi.fn(), onSeekBy: vi.fn(), onSpeed: vi.fn(), onToggleMute: vi.fn(), onFullscreen: vi.fn(), onRetry: vi.fn(),
  };
  const view = render(
    <Controls
      route={route}
      docked={false}
      visible
      paused={false}
      ended={false}
      buffering={false}
      error={null}
      retryable
      muted
      hasAudio
      speed={1}
      speeds={[0.5, 1, 2]}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}

describe('drive video controls', () => {
  it('formats the playback time with its segment', () => {
    expect(playbackTime(route, 65000)).toEqual('13:02:24 – 1');
    expect(playbackTime({ ...route, start_time_utc_millis: undefined }, 0)).toEqual('...');
    expect(playbackTime(null, 0)).toEqual('...');
  });

  it('plays from the bar or the big button', () => {
    const { onTogglePlay, onSeekBy, container } = renderControls({ paused: true });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.click(container.querySelector('button[aria-hidden="true"]'));
    expect(onTogglePlay).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Jump forward 10 seconds' }));
    expect(onSeekBy).toHaveBeenCalledWith(10000);
  });

  it('offers replay at the end', () => {
    renderControls({ paused: true, ended: true });
    expect(screen.getByRole('button', { name: 'Replay' })).toBeInTheDocument();
  });

  it('shows a spinner while buffering', () => {
    renderControls({ buffering: true });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('shows errors with retry', () => {
    const { onRetry } = renderControls({ error: 'No video has been uploaded for this drive yet.', paused: true, buffering: true });
    expect(screen.getByText('No video has been uploaded for this drive yet.')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('leaves out retry where it cannot help', () => {
    renderControls({ error: 'There is no video for this part of the drive yet.', retryable: false });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('docks under the map without fullscreen', () => {
    renderControls({ docked: true, error: 'You are offline.' });
    expect(screen.getByText('You are offline.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull();
  });

  it('changes speed, mutes and goes fullscreen', () => {
    const { onSpeed, onToggleMute, onFullscreen } = renderControls({ hasAudio: false });
    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '2' } });
    expect(onSpeed).toHaveBeenCalledWith(2);
    const mute = screen.getByRole('button', { name: 'Unmute' });
    expect(mute).toHaveAttribute('title', expect.stringContaining('Record and Upload Microphone Audio'));
    fireEvent.click(mute);
    expect(onToggleMute).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(onFullscreen).toHaveBeenCalled();
  });
});
