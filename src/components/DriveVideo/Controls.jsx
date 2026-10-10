import React, { useEffect, useRef } from 'react';
import dayjs from 'dayjs';
import { CircularProgress } from '@material-ui/core';

import Colors from '../../colors';
import {
  ErrorOutline, Forward10, Fullscreen, Pause, PlayArrow, RefreshIcon, Replay10, VolumeOff, VolumeUp,
} from '../../icons';
import { currentOffset } from '../../timeline';
import { getSegmentNumber } from '../../utils';

const NO_AUDIO = 'Enable audio recording through the "Record and Upload Microphone Audio" toggle on your device';

export function playbackTime(route, offset = currentOffset()) {
  const time = dayjs(offset + route?.start_time_utc_millis);
  if (!route || !time.isValid()) {
    return '...';
  }
  return `${time.format('HH:mm:ss')} – ${getSegmentNumber(route, offset)}`;
}

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/60';

const ControlButton = ({ label, title = label, onClick, className = '', children }) => (
  <button
    type="button"
    aria-label={label}
    title={title}
    onClick={onClick}
    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[1.5em] text-white transition-colors hover:bg-white/15 ${FOCUS_RING} ${className}`}
  >
    {children}
  </button>
);

const RetryButton = ({ onRetry }) => (
  <button
    type="button"
    onClick={onRetry}
    className={`flex items-center gap-2 rounded-3xl bg-white/15 px-5 py-1.5 text-[0.875em] font-medium text-white hover:bg-white/25 ${FOCUS_RING}`}
  >
    <RefreshIcon fontSize="inherit" className="text-[1.25em]" />
    Retry
  </button>
);

const Controls = ({
  route, docked, visible, paused, ended, buffering, error, retryable, muted, hasAudio, speed, speeds,
  onTogglePlay, onSeekBy, onSpeed, onToggleMute, onFullscreen, onRetry,
}) => {
  const timeRef = useRef(null);

  // the time follows the video every frame without re-rendering
  useEffect(() => {
    let frame;
    const update = () => {
      const text = playbackTime(route);
      if (timeRef.current && timeRef.current.textContent !== text) {
        timeRef.current.textContent = text;
      }
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [route]);

  const barClass = docked
    ? 'mt-3 flex items-center gap-1 rounded-full border border-white/10 px-2 py-1'
    : `absolute inset-x-0 bottom-0 flex items-center gap-1 bg-linear-to-t from-black/80 to-transparent px-2 pb-1.5 pt-10 transition-opacity duration-200 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`;

  const bar = (
    <div className={barClass}>
      <ControlButton label={ended ? 'Replay' : paused ? 'Play' : 'Pause'} onClick={onTogglePlay}>
        {paused ? <PlayArrow fontSize="inherit" /> : <Pause fontSize="inherit" />}
      </ControlButton>
      {/* phones seek with the timeline, the time needs the room */}
      <div className="hidden gap-1 xs:flex">
        <ControlButton label="Jump back 10 seconds" onClick={() => onSeekBy(-10000)}>
          <Replay10 fontSize="inherit" />
        </ControlButton>
        <ControlButton label="Jump forward 10 seconds" onClick={() => onSeekBy(10000)}>
          <Forward10 fontSize="inherit" />
        </ControlButton>
      </div>
      <span ref={timeRef} className="ml-1 grow truncate text-[0.875em] font-medium tabular-nums text-white" />
      <label className="relative flex h-10 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-full px-2 text-[0.875em] font-medium text-white hover:bg-white/15 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-white/60">
        {`${speed}×`}
        <select
          aria-label="Playback speed"
          value={speed}
          onChange={(ev) => onSpeed(Number(ev.target.value))}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {speeds.map((s) => <option key={s} value={s}>{`${s}×`}</option>)}
        </select>
      </label>
      <ControlButton
        label={muted ? 'Unmute' : 'Mute'}
        title={hasAudio ? undefined : NO_AUDIO}
        onClick={onToggleMute}
        className={hasAudio ? '' : 'opacity-50'}
      >
        {muted ? <VolumeOff fontSize="inherit" /> : <VolumeUp fontSize="inherit" />}
      </ControlButton>
      {!docked && (
        <ControlButton label="Fullscreen" onClick={onFullscreen}>
          <Fullscreen fontSize="inherit" />
        </ControlButton>
      )}
    </div>
  );

  if (docked) {
    return (
      <>
        {bar}
        {error && (
          <div className="mt-2 flex items-center justify-center gap-3 text-center text-[0.875em] text-white">
            <span>{error}</span>
            {retryable && <RetryButton onRetry={onRetry} />}
          </div>
        )}
      </>
    );
  }

  let center = null;
  if (error) {
    center = (
      <div className="pointer-events-auto mx-6 mb-10 flex max-w-sm flex-col items-center gap-2 rounded-2xl bg-glass-dark px-5 py-3 text-center text-[0.875em] text-white xs:mb-0 xs:gap-3 xs:px-6 xs:py-5">
        <ErrorOutline fontSize="inherit" className="hidden text-[1.75em] xs:block" />
        <p>{error}</p>
        {retryable && <RetryButton onRetry={onRetry} />}
      </div>
    );
  } else if (buffering) {
    center = (
      <div className="animate-[fadein_200ms_250ms_both]">
        <CircularProgress style={{ color: Colors.white }} thickness={4} size="3.125em" />
      </div>
    );
  } else if (paused) {
    center = (
      // the bar's play button is the one for keyboards and screen readers
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onTogglePlay}
        className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full bg-glass text-white transition-transform hover:scale-105"
      >
        {ended
          ? <RefreshIcon fontSize="inherit" className="text-[2.125em]" />
          : <PlayArrow fontSize="inherit" className="text-[2.5em]" />}
      </button>
    );
  }

  return (
    <>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">{center}</div>
      {bar}
    </>
  );
};

export default Controls;
