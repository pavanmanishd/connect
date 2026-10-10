// Drives the drive's <video> element. The element is the playback clock: the
// timeline, map and time display read offset(), and seeks go through seek().
// When there is no video to play (none uploaded, or none in the selection) a
// plain clock keeps the map and timeline playing.

const SEEK_TOLERANCE = 0.05; // seconds

export const NO_VIDEO = 'No video has been uploaded for this drive yet.';
export const NO_VIDEO_HERE = 'There is no video for this part of the drive yet.';
const LOAD_FAILED = 'Unable to load video';

/**
 * What to do about an hls.js error
 *
 * @returns {{ action: 'ignore' | 'skip' | 'refresh' | 'recover' | 'fail', message?: string }}
 */
export function classifyHlsError(data, online = true) {
  const code = data.response?.code;
  // the signed playlist and segment urls expire
  if (code === 401 || code === 403) return { action: 'refresh', message: LOAD_FAILED };
  // a segment in the playlist without a video file
  if (data.details === 'fragLoadError' && data.frag && (code === 404 || code === 410)) return { action: 'skip' };
  if (!data.fatal) return { action: 'ignore' };
  if (data.type === 'mediaError') return { action: 'recover', message: 'Unable to play video' };
  if (code === 404 || data.details === 'manifestParsingError' || data.details === 'levelEmptyError') {
    return { action: 'fail', message: NO_VIDEO };
  }
  if (data.type === 'networkError') {
    return { action: 'fail', message: online ? `${LOAD_FAILED}. Check network connection.` : 'You are offline.' };
  }
  return { action: 'fail', message: LOAD_FAILED };
}

export default class Player {
  /**
   * @param {object} deps
   * @param {boolean} deps.nativeHls play the playlist with the video element instead of hls.js
   * @param {() => Promise<Function>} deps.loadHls resolves to the hls.js class
   * @param {object} deps.hlsConfig
   * @param {(route: object, credentials: object | null) => string} deps.streamUrl
   * @param {(route: object) => Promise<object>} deps.refreshRoute the route with a fresh share signature
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.video = null;
    this.route = null;
    this.loop = null;
    this.speed = 1;
    this.session = 0; // bumped when the source changes, late callbacks check it
    this.hls = null;
    this.credentials = null; // a fresh share signature once the route's has expired
    this.target = null; // route offset playback is moving to
    this.applied = null; // target of the seek the video is running
    this.missing = []; // [start, end] video times of segments whose file is gone
    this.playing = true; // whether the user wants playback
    this.ended = false;
    this.problem = null; // { message, inSelection } when there is no video to play
    this.refreshing = null;
    this.refreshed = false;
    this.recovered = false;
    this.recoveredAt = 0;
    this.interacted = false;
    this.lastTime = null;
    this.lastFrame = null;

    this.state = {
      paused: true, buffering: false, ended: false, error: null, retryable: true, muted: true, hasAudio: false,
    };
    this.listeners = new Set();
    this.subscribe = this.subscribe.bind(this);
    this.getState = this.getState.bind(this);
    this.onAudioTrack = () => this.emit({ hasAudio: true });
    this.events = {
      loadedmetadata: () => this.onLoadedMetadata(),
      play: () => this.onPlay(),
      pause: () => this.onPause(),
      // detaching the media (hls.js recovery) pauses it without a pause event
      emptied: () => !this.problem && this.emit({ paused: this.video.paused }),
      waiting: () => {
        this.setBuffering(true);
        this.skipMissing();
      },
      seeking: () => this.setBuffering(true),
      seeked: () => this.onSeeked(),
      playing: () => this.setBuffering(false),
      canplay: () => this.setBuffering(false),
      timeupdate: () => this.onTimeUpdate(),
      volumechange: () => this.emit({ muted: this.video.muted }),
      ended: () => !this.ended && this.finish(),
      error: () => this.onError(),
    };
  }

  // store interface for useSyncExternalStore
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState() {
    return this.state;
  }

  emit(patch) {
    if (Object.keys(patch).every((key) => this.state[key] === patch[key])) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  setBuffering(buffering) {
    if (!this.problem) this.emit({ buffering });
  }

  attach(video) {
    this.video = video;
    video.muted = true;
    Object.entries(this.events).forEach(([type, handler]) => video.addEventListener(type, handler));
    video.audioTracks?.addEventListener?.('addtrack', this.onAudioTrack);
  }

  detach() {
    this.unload();
    Object.entries(this.events).forEach(([type, handler]) => this.video.removeEventListener(type, handler));
    this.video.audioTracks?.removeEventListener?.('addtrack', this.onAudioTrack);
    this.video = null;
  }

  setRoute(route) {
    const prev = this.route;
    this.route = route;
    if (route?.fullname !== prev?.fullname) {
      this.credentials = null;
      this.refreshed = false;
      this.interacted = false;
      this.playing = true;
      this.load(this.startOffset());
    } else if (route && route.videoStartOffset !== prev.videoStartOffset && !this.interacted
      && this.target === null && this.video.readyState >= 1) {
      // the first frame offset arrives with the route events, keep showing the same route time
      this.moveTo((prev.videoStartOffset || 0) + (this.video.currentTime * 1000));
    }
  }

  // returns whether playback moved into the new selection
  setLoop(loop) {
    const prev = this.loop;
    this.loop = loop;
    const offset = this.route && loop && loop !== prev ? this.offset() : null;
    if (offset === null || (offset >= loop.startTime && offset <= loop.startTime + loop.duration)) return false;
    // a new selection plays from its start
    this.interacted = true;
    this.moveTo(loop.startTime);
    this.play();
    return true;
  }

  setSpeed(speed) {
    this.speed = speed;
    this.video.defaultPlaybackRate = speed;
    this.video.playbackRate = speed;
  }

  // playback position in route milliseconds
  offset() {
    if (this.target !== null) return this.target;
    if (this.video.readyState < 1) return null;
    return Math.max(0, this.routeOffset(this.video.currentTime));
  }

  routeOffset(seconds) {
    return (this.route?.videoStartOffset || 0) + (seconds * 1000);
  }

  videoTime(offset) {
    return Math.max(0, offset - (this.route?.videoStartOffset || 0)) / 1000;
  }

  startOffset() {
    return this.loop?.startTime ?? 0;
  }

  // a seek by the user, kept inside the selection; returns where it went
  seek(offset) {
    let target = Math.max(0, offset);
    if (this.loop) {
      target = Math.min(Math.max(target, this.loop.startTime), this.loop.startTime + this.loop.duration);
    }
    this.interacted = true;
    this.moveTo(target);
    return target;
  }

  moveTo(offset) {
    this.target = offset;
    this.setEnded(false);
    if (this.problem?.inSelection && this.hasVideo(offset, offset)) {
      // back where there is video
      this.problem = null;
      this.emit({ error: null, retryable: true, paused: this.video.paused });
      this.hls?.startLoad(this.videoTime(offset));
      if (this.playing) this.startPlayback();
    }
    this.applySeek();
  }

  // seeks wait for metadata; a new seek replaces a running one, which may never finish inside a missing segment
  applySeek() {
    const { video } = this;
    if (this.target === null || this.problem || video.readyState < 1) return;
    const time = this.videoTime(this.target);
    if (Math.abs(video.currentTime - time) < SEEK_TOLERANCE) {
      this.target = null;
    } else {
      this.applied = this.target;
      video.currentTime = time;
    }
  }

  play() {
    if (this.ended) this.moveTo(this.startOffset());
    this.playing = true;
    if (this.problem) this.emit({ paused: false });
    else this.startPlayback();
  }

  pause() {
    this.playing = false;
    if (this.problem) this.emit({ paused: true });
    else this.video.pause();
  }

  // returns whether playback started
  toggle() {
    const paused = this.problem ? !this.playing : this.video.paused;
    if (paused) this.play();
    else this.pause();
    return paused;
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
  }

  retry() {
    this.refreshed = false;
    this.load(this.offset() ?? this.startOffset());
  }

  // called on every animation frame
  tick(now) {
    const elapsed = this.lastFrame === null ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    if (this.problem) {
      // without video the map and timeline play on their own
      if (this.playing) this.target = (this.offset() ?? this.startOffset()) + (elapsed * this.speed);
    } else {
      this.skipMissing();
      // iOS can miss the seeked event
      if (this.applied !== null && !this.video.seeking) this.onSeeked();
      // a seek past the end stops at or just short of it, without an ended event
      const { video } = this;
      const stopped = video.paused || this.state.buffering;
      const atEnd = video.ended || (stopped && video.currentTime >= video.duration - 0.25);
      if (atEnd && !video.seeking && !this.ended) this.finish();
    }
    this.checkLoop();
  }

  load(target) {
    const { video, route } = this;
    this.unload();
    const { session } = this;
    Object.assign(this, { target, applied: null, missing: [], problem: null, recovered: false, ended: false });
    this.emit({ error: null, retryable: true, ended: false, paused: true, buffering: this.playing, hasAudio: false });
    if (!route) return;

    const url = this.streamUrl(route, this.credentials);
    if (this.nativeHls) {
      video.src = url;
      // iOS may not load anything before play()
      if (this.playing) this.startPlayback();
      return;
    }

    this.loadHls().then((Hls) => {
      if (session !== this.session) return;
      this.hls = new Hls({ ...this.hlsConfig, maxBufferLength: 40, startPosition: this.videoTime(target) });
      this.hls.on(Hls.Events.BUFFER_CODECS, (_, data) => this.emit({ hasAudio: Boolean(data.audio) }));
      this.hls.on(Hls.Events.ERROR, (_, data) => this.onHlsError(data));
      this.hls.loadSource(url);
      this.hls.attachMedia(video);
      if (this.playing) this.startPlayback();
    }, () => session === this.session && this.fail(LOAD_FAILED));
  }

  unload() {
    const { video } = this;
    this.session += 1;
    this.hls?.destroy();
    this.hls = null;
    if (video?.getAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }

  startPlayback() {
    this.playing = true;
    this.video.play().catch((err) => {
      if (err.name !== 'NotAllowedError') return;
      // autoplay is blocked (e.g. iOS low power mode), wait for a tap on play
      this.playing = false;
      this.emit({ buffering: false });
    });
  }

  setEnded(ended) {
    this.ended = ended;
    this.emit({ ended });
  }

  onLoadedMetadata() {
    this.setSpeed(this.speed);
    this.applySeek();
    if (this.video.audioTracks?.length) this.emit({ hasAudio: true });
  }

  onPlay() {
    this.playing = true;
    this.setEnded(false);
    this.emit({ paused: false });
  }

  onPause() {
    if (this.problem) return;
    // a pause from outside the page (OS media controls, native fullscreen) is the user's too
    if (!this.ended && !this.video.ended) this.playing = false;
    this.emit({ paused: true, buffering: false });
  }

  onSeeked() {
    if (this.target === this.applied) this.target = null;
    this.applied = null;
    this.setBuffering(false);
    // a newer seek may have come in while this one ran
    this.applySeek();
  }

  onTimeUpdate() {
    const { video } = this;
    // a video whose time moves is not buffering
    if (!video.seeking && video.currentTime !== this.lastTime) this.setBuffering(false);
    this.lastTime = video.currentTime;
    // playing on well past a recovered media error, recover again if it comes back
    if (this.recovered && video.currentTime > this.recoveredAt + 10) this.recovered = false;
    // animation frames stop in background tabs, timeupdate does not
    this.skipMissing();
    this.checkLoop();
  }

  async onError() {
    const { video, session } = this;
    // hls.js reports its own errors
    if (this.hls || this.problem || !video.error || !video.getAttribute('src')) return;
    // native HLS does not say what went wrong, the playlist does
    const res = await fetch(video.src).catch(() => null);
    const text = res?.ok ? await res.text() : '';
    if (session !== this.session) return;
    if (!res) {
      this.fail(navigator.onLine === false ? 'You are offline.' : `${LOAD_FAILED}. Check network connection.`);
    } else if (res.status === 404 || (res.ok && !text.includes('#EXTINF'))) {
      this.fail(NO_VIDEO);
    } else {
      this.refresh(LOAD_FAILED);
    }
  }

  onHlsError(data) {
    const { action, message } = classifyHlsError(data, navigator.onLine !== false);
    if (action === 'skip') {
      // play on past it once playback gets there
      this.missing.push([data.frag.start, data.frag.start + data.frag.duration]);
    } else if (action === 'refresh') {
      this.refresh(message);
    } else if (action === 'recover' && !this.recovered) {
      // recovering detaches and reattaches the video, which loses its position and pauses it
      this.recovered = true;
      this.recoveredAt = this.video.currentTime;
      this.target = this.offset();
      // detaching ends any running seek, it must not look finished
      this.applied = null;
      this.hls.recoverMediaError();
      if (this.playing) this.startPlayback();
    } else if (action !== 'ignore') {
      this.fail(message);
    }
  }

  // the signed playlist and segment urls expire, get fresh ones once and resume
  async refresh(message) {
    const { route, session } = this;
    if (this.refreshing === session) return;
    if (this.refreshed) {
      this.fail(message);
      return;
    }
    this.refreshing = session;
    this.refreshed = true;
    const fresh = await this.refreshRoute(route).catch(() => null);
    if (session !== this.session) return;
    if (!fresh?.share_sig) {
      this.fail(message);
      return;
    }
    this.credentials = fresh;
    this.load(this.offset() ?? this.startOffset());
  }

  fail(message, inSelection = false) {
    this.problem = { message, inSelection };
    this.hls?.stopLoad();
    this.video.pause();
    // retrying cannot add video to the selection
    this.emit({ error: message, retryable: !inSelection, buffering: false, paused: !this.playing });
  }

  // jump over a segment whose file is gone once playback reaches it, or stalls just short of it
  skipMissing() {
    const position = this.target !== null ? this.videoTime(this.target) : this.video.currentTime;
    const gap = this.missing.find(([start, end]) => position < end
      && (position >= start - 0.1 || (this.state.buffering && position >= start - 1)));
    if (!gap) return;
    if (gap[1] >= this.video.duration - 0.1) {
      this.finish();
    } else {
      this.moveTo(this.routeOffset(gap[1]));
      this.hls?.startLoad(gap[1]);
    }
  }

  // false past the end of the video or inside a segment whose file is gone
  hasVideo(from, to) {
    const start = this.videoTime(from);
    const end = this.videoTime(to);
    return start < this.video.duration - 0.25
      && !this.missing.some(([gapStart, gapEnd]) => start >= gapStart - 0.1 && end <= gapEnd);
  }

  checkLoop() {
    const { loop } = this;
    const offset = this.offset();
    const running = this.problem ? this.playing : !this.video.paused;
    if (!loop || !running || offset === null) return;
    if (offset >= loop.startTime + loop.duration) this.finish();
    else if (offset < loop.startTime - 1000 && !this.problem) this.moveTo(loop.startTime);
  }

  // reached the end of the selection: a clip loops, a whole drive stops
  finish() {
    const { loop, route, video } = this;
    const clip = loop && route && (loop.startTime > 0 || loop.startTime + loop.duration < route.duration);
    if (!clip) {
      this.setEnded(true);
      this.playing = false;
      video.pause();
      this.emit({ paused: true, buffering: false });
    } else if (this.problem) {
      this.moveTo(loop.startTime);
    } else if (!this.hasVideo(loop.startTime, loop.startTime + loop.duration)) {
      this.target = loop.startTime;
      this.fail(NO_VIDEO_HERE, true);
    } else {
      this.moveTo(loop.startTime);
      if (this.playing && video.paused) this.startPlayback();
    }
  }
}
