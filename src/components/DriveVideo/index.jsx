import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { connect } from 'react-redux';
import hlsWorkerPath from 'hls.js/dist/hls.worker.js?url';

import { api } from '../../api/backend';
import { currentOffset, registerPlayer } from '../../timeline';
import { pause, play, seek } from '../../timeline/playback';
import { isAppleMobile } from '../../utils/browser';
import Controls from './Controls';
import Player from './player';

const CONTROLS_TIMEOUT = 2500;
// native HLS on iOS stalls at 4x and changes speed slowly below 0.5x
const SPEEDS = isAppleMobile() ? [0.5, 1, 2] : [0.1, 0.25, 0.5, 1, 2, 4, 8];

function createPlayer() {
  return new Player({
    // iPhone and iPad play HLS natively
    nativeHls: isAppleMobile() || !(window.MediaSource || window.ManagedMediaSource),
    loadHls: () => import('hls.js/light').then((module) => module.default),
    // hls.js transmuxes in this worker
    hlsConfig: { workerPath: hlsWorkerPath },
    streamUrl: (route, credentials) => {
      const { share_exp: exp, share_sig: sig } = credentials || route;
      return api.video.getQcameraStreamUrl(route.fullname, exp, sig);
    },
    refreshRoute: (route) => api.routes
      .getRoutesSegments(route.fullname.split('|')[0], undefined, undefined, undefined, route.fullname)
      .then((routes) => routes?.[0]),
  });
}

const DriveVideo = ({ dispatch, currentRoute, loop, desiredPlaySpeed, children }) => {
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const [player] = useState(createPlayer);
  const state = useSyncExternalStore(player.subscribe, player.getState);
  const [controlsActive, setControlsActive] = useState(false);
  const controlsTimeout = useRef(null);
  const pointerType = useRef('mouse');
  const docked = Boolean(children);

  const seekTo = (offset) => dispatch(seek(player.seek(offset)));

  // play, pause, mute and fullscreen run inside the click handler, iOS only allows them there
  const togglePlay = () => dispatch(player.toggle() ? play(desiredPlaySpeed) : pause());

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (stage.requestFullscreen) {
      stage.requestFullscreen().catch(() => {});
    } else if (stage.webkitRequestFullscreen) {
      stage.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen && video.readyState >= 1) {
      // iPhone only lets the video itself go fullscreen
      video.webkitEnterFullscreen();
    }
  };

  const showControls = () => {
    clearTimeout(controlsTimeout.current);
    setControlsActive(true);
    controlsTimeout.current = setTimeout(() => setControlsActive(false), CONTROLS_TIMEOUT);
  };

  // a click toggles playback, a tap shows or hides the controls
  const onSurfaceClick = () => {
    if (pointerType.current !== 'touch' && pointerType.current !== 'pen') togglePlay();
    else if (controlsActive) setControlsActive(false);
    else showControls();
  };

  const onPointerDown = (ev) => {
    pointerType.current = ev.pointerType;
    // keep touch controls up while they are being used
    if (controlsActive) showControls();
  };

  useEffect(() => {
    player.attach(videoRef.current);
    const unregister = registerPlayer({ offset: () => player.offset(), seek: seekTo });
    let frame = requestAnimationFrame(function tick(now) {
      player.tick(now);
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(controlsTimeout.current);
      unregister();
      player.detach();
    };
  }, []);

  useEffect(() => {
    player.setSpeed(desiredPlaySpeed);
  }, [desiredPlaySpeed]);

  useEffect(() => {
    if (player.setLoop(loop)) dispatch(seek(loop.startTime));
  }, [loop]);

  useEffect(() => {
    player.setRoute(currentRoute);
  }, [currentRoute]);

  const controls = (
    <Controls
      {...state}
      route={currentRoute}
      docked={docked}
      visible={state.paused || Boolean(state.error) || controlsActive}
      speed={desiredPlaySpeed}
      speeds={SPEEDS}
      onTogglePlay={togglePlay}
      onSeekBy={(ms) => seekTo(currentOffset() + ms)}
      onSpeed={(speed) => dispatch(play(speed))}
      onToggleMute={() => player.toggleMute()}
      onFullscreen={toggleFullscreen}
      onRetry={() => player.retry()}
    />
  );

  return (
    <div className="relative m-[0_auto] w-full max-w-[964px]">
      <div
        ref={stageRef}
        className={`relative w-full select-none overflow-hidden rounded-lg bg-black [&:fullscreen]:rounded-none ${docked ? 'h-75' : 'aspect-[1.593]'}`}
        onPointerDown={onPointerDown}
        onPointerMove={(ev) => ev.pointerType === 'mouse' && showControls()}
      >
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" playsInline preload="auto" />
        <div data-testid="video-surface" className="absolute inset-0" onClick={onSurfaceClick} />
        {docked ? <div className="absolute inset-0">{children}</div> : controls}
      </div>
      {docked && controls}
    </div>
  );
};

const stateToProps = (state) => ({
  currentRoute: state.currentRoute,
  loop: state.loop,
  desiredPlaySpeed: state.desiredPlaySpeed,
});

export default connect(stateToProps)(DriveVideo);
