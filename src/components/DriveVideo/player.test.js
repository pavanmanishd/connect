import Player, { NO_VIDEO, NO_VIDEO_HERE, classifyHlsError } from './player';

// a <video> whose time, seeks and events the tests control
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.time = 0;
    this.duration = NaN;
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.muted = false;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.error = null;
    this.attributes = {};
    this.blockPlay = false;
  }

  get currentTime() { return this.time; }

  // a new seek replaces a running one, like in browsers
  set currentTime(time) {
    this.time = time;
    this.seeking = true;
    this.fire('seeking');
  }

  get src() { return this.attributes.src; }

  set src(url) { this.attributes.src = url; }

  getAttribute(name) { return this.attributes[name] ?? null; }

  removeAttribute(name) { delete this.attributes[name]; }

  load() {}

  play() {
    if (this.blockPlay) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    if (this.paused) {
      this.paused = false;
      this.fire('play');
    }
    return Promise.resolve();
  }

  pause() {
    if (!this.paused) {
      this.paused = true;
      this.fire('pause');
    }
  }

  fire(type) {
    this.dispatchEvent(new Event(type));
  }

  loadMetadata(duration) {
    this.duration = duration;
    this.readyState = 4;
    this.fire('loadedmetadata');
  }

  finishSeek({ event = true } = {}) {
    this.time = Math.min(this.time, this.duration);
    this.ended = this.time >= this.duration;
    this.seeking = false;
    if (event) this.fire('seeked');
  }

  playTo(time) {
    this.time = time;
    this.fire('timeupdate');
  }

  end() {
    this.time = this.duration;
    this.ended = true;
    this.pause();
    this.fire('ended');
  }
}

class FakeHls {
  static Events = { BUFFER_CODECS: 'hlsBufferCodecs', ERROR: 'hlsError' };

  static instances = [];

  constructor(config) {
    this.config = config;
    this.handlers = {};
    this.destroy = vi.fn();
    this.startLoad = vi.fn();
    this.stopLoad = vi.fn();
    this.recoverMediaError = vi.fn();
    FakeHls.instances.push(this);
  }

  on(event, handler) { this.handlers[event] = handler; }

  error(data) { this.handlers[FakeHls.Events.ERROR](FakeHls.Events.ERROR, data); }

  loadSource(url) { this.url = url; }

  attachMedia(video) { video.src = 'blob:media'; }
}

const ROUTE = { fullname: 'a2a0ccea32023010|2023-07-27--13-01-19', duration: 300000, share_exp: 'e', share_sig: 'sig' };
const WHOLE = { startTime: 0, duration: 300000 };
const MEDIA_ERROR = { type: 'mediaError', details: 'bufferAppendError', fatal: true };
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const missing = (start, code = 404) => ({
  type: 'networkError', details: 'fragLoadError', fatal: false, frag: { start, duration: 60 }, response: { code },
});

async function setup({ loop = WHOLE, route = ROUTE, nativeHls = false, video = new FakeVideo(), refreshRoute } = {}) {
  FakeHls.instances = [];
  const player = new Player({
    nativeHls,
    loadHls: () => Promise.resolve(FakeHls),
    hlsConfig: { workerPath: '/hls.worker.js' },
    streamUrl: (r, credentials) => `https://api.test/${r.fullname}.m3u8?sig=${(credentials || r).share_sig}`,
    refreshRoute: refreshRoute || vi.fn(() => Promise.resolve({ ...route, share_sig: 'fresh' })),
  });
  player.attach(video);
  player.setLoop(loop);
  player.setRoute(route);
  await flush();
  return { player, video, hls: () => FakeHls.instances[FakeHls.instances.length - 1] };
}

// metadata loaded and the start seek done
async function ready(options) {
  const env = await setup(options);
  env.video.loadMetadata(options?.duration ?? 300);
  if (env.video.seeking) env.video.finishSeek();
  return env;
}

describe('drive video player', () => {
  it('loads the selection with hls.js from its start and plays', async () => {
    const { player, video, hls } = await setup({ loop: { startTime: 60000, duration: 30000 } });
    expect(hls().url).toEqual(`https://api.test/${ROUTE.fullname}.m3u8?sig=sig`);
    expect(hls().config).toMatchObject({ startPosition: 60, workerPath: '/hls.worker.js' });
    expect(player.offset()).toEqual(60000);
    expect(video.paused).toBe(false);
    expect(player.getState()).toMatchObject({ paused: false, buffering: true, muted: true });

    video.loadMetadata(300);
    expect(video.currentTime).toEqual(60);
    video.finishSeek();
    video.playTo(65);
    expect(player.offset()).toEqual(65000);
    expect(player.getState().buffering).toBe(false);
  });

  it('shows a seek right away and lets the latest one win', async () => {
    const { player, video } = await ready();
    player.seek(100000);
    expect(player.offset()).toEqual(100000);
    player.seek(150000);
    expect(player.offset()).toEqual(150000);
    expect(video.currentTime).toEqual(150);
    video.finishSeek();
    video.playTo(151);
    expect(player.offset()).toEqual(151000);
  });

  it('follows the video when a seeked event goes missing', async () => {
    const { player, video } = await ready();
    player.seek(100000);
    video.finishSeek({ event: false });
    player.tick(0);
    video.playTo(101);
    expect(player.offset()).toEqual(101000);
  });

  it('keeps seeks inside the selection', async () => {
    const { player } = await ready({ loop: { startTime: 60000, duration: 30000 } });
    expect(player.seek(10000)).toEqual(60000);
    expect(player.seek(500000)).toEqual(90000);
  });

  it('keeps the route time when the first frame offset arrives late', async () => {
    const { player, video } = await ready();
    video.playTo(10);
    player.setRoute({ ...ROUTE, videoStartOffset: 2000 });
    expect(player.offset()).toEqual(10000);
    expect(video.currentTime).toEqual(8);

    video.finishSeek();
    player.seek(50000);
    video.finishSeek();
    player.setRoute({ ...ROUTE, videoStartOffset: 3000 });
    expect(video.seeking).toBe(false);
  });

  it('plays a new selection from its start', async () => {
    const { player, video } = await ready();
    video.playTo(10);
    expect(player.setLoop({ startTime: 0, duration: 20000 })).toBe(false);
    video.pause();
    expect(player.setLoop({ startTime: 60000, duration: 30000 })).toBe(true);
    expect(video.currentTime).toEqual(60);
    expect(video.paused).toBe(false);
  });

  it('loops a clip', async () => {
    const { player, video } = await ready({ loop: { startTime: 60000, duration: 30000 } });
    video.playTo(90.01);
    expect(video.currentTime).toEqual(60);
    expect(player.getState().paused).toBe(false);
  });

  it('stops a whole drive at the end and replays it', async () => {
    const { player, video } = await ready();
    video.end();
    expect(player.getState()).toMatchObject({ paused: true, ended: true });
    expect(player.toggle()).toBe(true);
    expect(video.currentTime).toEqual(0);
    expect(player.getState()).toMatchObject({ paused: false, ended: false });
  });

  it('ends when a seek goes past the end of the video', async () => {
    const { player, video } = await ready({ duration: 240 });
    video.pause();
    player.seek(280000);
    video.finishSeek();
    player.tick(0);
    expect(player.getState()).toMatchObject({ paused: true, ended: true });
  });

  it('plays the last moments of a drive before ending it', async () => {
    const { player, video } = await ready({ duration: 240 });
    video.playTo(239.9);
    player.tick(0);
    expect(player.getState().ended).toBe(false);
  });

  it('does not end while a seek near the end is still running', async () => {
    const { player, video } = await ready({ duration: 240 });
    video.pause();
    player.seek(239900);
    player.tick(0);
    expect(player.getState().ended).toBe(false);
  });

  it('ends without a spinner when a paused seek lands in a missing last segment', async () => {
    const { player, video, hls } = await ready({ duration: 240 });
    video.pause();
    player.seek(200000);
    hls().error(missing(180));
    video.fire('waiting');
    player.tick(0);
    expect(player.getState()).toMatchObject({ ended: true, paused: true, buffering: false });
  });

  it('ends when a paused seek stops just short of the end', async () => {
    const { player, video } = await ready({ duration: 240 });
    video.pause();
    player.seek(280000);
    video.finishSeek();
    // browsers can settle on the last frame, just before the end
    video.time = 239.99;
    video.ended = false;
    player.tick(0);
    expect(player.getState().ended).toBe(true);
  });

  it('says when a selection has no video and recovers once there is', async () => {
    const route = { ...ROUTE, duration: 500000 };
    const { player, video } = await setup({ route, loop: { startTime: 300000, duration: 100000 } });
    video.loadMetadata(240);
    video.finishSeek();
    player.tick(0);
    expect(player.getState()).toMatchObject({ error: NO_VIDEO_HERE, retryable: false });
    expect(player.offset()).toEqual(300000);

    // the map and timeline keep playing
    player.tick(1000);
    expect(player.offset()).toEqual(301000);

    player.setLoop({ startTime: 0, duration: 500000 });
    player.seek(30000);
    expect(player.getState().error).toBeNull();
    expect(video.currentTime).toEqual(30);
    expect(video.paused).toBe(false);
  });

  it('recovers when a wider clip loops back to where there is video', async () => {
    const route = { ...ROUTE, duration: 500000 };
    const { player, video } = await setup({ route, loop: { startTime: 300000, duration: 100000 } });
    video.loadMetadata(240);
    video.finishSeek();
    player.tick(0);
    player.setLoop({ startTime: 100000, duration: 350000 });
    player.tick(160000);
    expect(player.getState().error).toBeNull();
    expect(video.currentTime).toEqual(100);
  });

  it('jumps a missing segment once playback gets there', async () => {
    const { player, video, hls } = await ready();
    video.playTo(80);
    hls().error(missing(120));
    player.tick(0);
    expect(video.currentTime).toEqual(80);

    video.playTo(119.95);
    expect(video.currentTime).toEqual(180);
    expect(hls().startLoad).toHaveBeenCalledWith(180);
  });

  it('jumps a missing segment when playback stalls just short of it', async () => {
    const { video, hls } = await ready();
    hls().error(missing(120));
    video.playTo(119.4);
    video.fire('waiting');
    expect(video.currentTime).toEqual(180);
  });

  it('gets out of a seek stuck inside a missing segment', async () => {
    const { player, video, hls } = await ready();
    player.seek(130000);
    // nothing can load there, so this seek never finishes
    hls().error(missing(120));
    player.tick(0);
    expect(video.currentTime).toEqual(180);
    expect(hls().startLoad).toHaveBeenCalledWith(180);

    player.seek(130000);
    player.seek(30000);
    expect(video.currentTime).toEqual(30);
  });

  it('starts after a missing segment it was asked to start in', async () => {
    const { player, hls } = await setup();
    player.seek(130000);
    hls().error(missing(120));
    player.tick(0);
    expect(player.offset()).toEqual(180000);
  });

  it('ends the drive at a missing last segment', async () => {
    const { player, video, hls } = await ready({ duration: 240 });
    hls().error(missing(180));
    video.playTo(179.95);
    expect(player.getState()).toMatchObject({ ended: true, error: null });
  });

  it('says a clip inside a missing segment has no video', async () => {
    const { player, video, hls } = await setup({ loop: { startTime: 130000, duration: 40000 } });
    hls().error(missing(120));
    video.loadMetadata(300);
    player.tick(0);
    video.finishSeek();
    video.playTo(180.1);
    expect(player.getState().error).toEqual(NO_VIDEO_HERE);
    expect(player.offset()).toEqual(130000);
  });

  it('refreshes expired urls once and resumes where it was', async () => {
    const refreshRoute = vi.fn(() => Promise.resolve({ ...ROUTE, share_sig: 'fresh' }));
    const { player, video, hls } = await ready({ refreshRoute });
    video.playTo(50);
    hls().error(missing(60, 403));
    hls().error(missing(60, 403));
    // a second error while the refresh runs does not fail playback
    expect(player.getState().error).toBeNull();
    await vi.waitFor(() => expect(hls().url).toContain('sig=fresh'));
    expect(refreshRoute).toHaveBeenCalledTimes(1);
    expect(hls().config.startPosition).toEqual(50);

    hls().error({ type: 'networkError', details: 'levelLoadError', fatal: true, response: { code: 403 } });
    expect(player.getState()).toMatchObject({ error: 'Unable to load video', retryable: true });
  });

  it('resumes where it was after recovering a media error', async () => {
    const { player, video, hls } = await ready();
    video.playTo(50);
    // recovering detaches the video, which pauses it silently
    hls().recoverMediaError.mockImplementation(() => {
      video.paused = true;
      video.readyState = 0;
      video.fire('emptied');
    });
    hls().error(MEDIA_ERROR);
    expect(player.offset()).toEqual(50000);
    expect(video.paused).toBe(false);
    expect(player.getState().error).toBeNull();

    // a second error right away is not recovered again
    hls().error(MEDIA_ERROR);
    expect(player.getState().error).toEqual('Unable to play video');
  });

  it('keeps a seek position through a media error', async () => {
    const { player, video, hls } = await ready();
    player.seek(200000);
    // recovering detaches the video, which ends the running seek
    hls().recoverMediaError.mockImplementation(() => {
      video.seeking = false;
      video.readyState = 0;
      video.fire('emptied');
    });
    hls().error(MEDIA_ERROR);
    player.tick(0);
    expect(player.offset()).toEqual(200000);
    video.loadMetadata(300);
    expect(video.currentTime).toEqual(200);
  });

  it('shows a video paused by detaching it as paused', async () => {
    const { player, video } = await ready();
    expect(player.getState().paused).toBe(false);
    video.paused = true;
    video.fire('emptied');
    expect(player.getState().paused).toBe(true);
  });

  it('recovers media errors again once playback has moved on', async () => {
    const { video, hls } = await ready();
    video.playTo(50);
    hls().error(MEDIA_ERROR);
    video.playTo(61);
    hls().error(MEDIA_ERROR);
    expect(hls().recoverMediaError).toHaveBeenCalledTimes(2);
  });

  it('plays a silently paused video instead of pausing it again', async () => {
    const { player, video } = await ready();
    video.paused = true;
    expect(player.toggle()).toBe(true);
    expect(video.paused).toBe(false);
  });

  it('says when no video has been uploaded and plays the map and timeline without it', async () => {
    const { player, video, hls } = await setup();
    hls().error({ type: 'networkError', details: 'manifestParsingError', fatal: true });
    expect(player.getState()).toMatchObject({ error: NO_VIDEO, retryable: true, paused: false, buffering: false });
    expect(hls().stopLoad).toHaveBeenCalled();
    expect(video.paused).toBe(true);

    player.tick(0);
    player.tick(500);
    expect(player.offset()).toEqual(500);
    expect(player.toggle()).toBe(false);
    player.tick(1000);
    expect(player.offset()).toEqual(500);
    expect(player.getState().paused).toBe(true);
  });

  it('shows the play button when autoplay is blocked', async () => {
    const video = new FakeVideo();
    video.blockPlay = true;
    const { player } = await setup({ video });
    await flush();
    expect(player.getState()).toMatchObject({ paused: true, buffering: false });

    // nothing plays until the user asks for it
    video.blockPlay = false;
    player.retry();
    await flush();
    expect(video.paused).toBe(true);
  });

  it('takes buffering from the video', async () => {
    const { player, video } = await ready();
    video.fire('waiting');
    expect(player.getState().buffering).toBe(true);
    video.playTo(1);
    expect(player.getState().buffering).toBe(false);
    video.fire('waiting');
    video.pause();
    expect(player.getState()).toMatchObject({ buffering: false, paused: true });
  });

  it('remembers a pause from outside the page but not its own', async () => {
    const { player, video, hls } = await ready();
    hls().error({ type: 'networkError', details: 'fragLoadError', fatal: true });
    player.retry();
    await flush();
    expect(video.paused).toBe(false);

    video.pause();
    player.retry();
    await flush();
    expect(video.paused).toBe(true);
  });

  it('ignores a source that was replaced while loading', async () => {
    let resolveHls;
    const player = new Player({
      nativeHls: false,
      loadHls: () => new Promise((resolve) => { resolveHls = resolve; }),
      streamUrl: (r) => r.fullname,
      refreshRoute: vi.fn(),
    });
    FakeHls.instances = [];
    player.attach(new FakeVideo());
    player.setRoute(ROUTE);
    const first = resolveHls;
    player.setRoute({ ...ROUTE, fullname: 'a2a0ccea32023010|2023-07-27--14-00-00' });
    first(FakeHls);
    resolveHls(FakeHls);
    await flush();
    expect(FakeHls.instances.map((hls) => hls.url)).toEqual(['a2a0ccea32023010|2023-07-27--14-00-00']);
  });

  it('applies the speed', async () => {
    const { player, video } = await ready();
    player.setSpeed(2);
    expect(video).toMatchObject({ playbackRate: 2, defaultPlaybackRate: 2 });
  });

  describe('native HLS', () => {
    afterEach(() => vi.unstubAllGlobals());

    async function failWith(response, refreshRoute) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response)));
      const env = await setup({ nativeHls: true, refreshRoute });
      env.video.error = { code: 4 };
      env.video.fire('error');
      return env;
    }

    it('plays the playlist with the video element', async () => {
      const { video } = await setup({ nativeHls: true });
      expect(video.src).toEqual(`https://api.test/${ROUTE.fullname}.m3u8?sig=sig`);
      expect(video.paused).toBe(false);
      expect(FakeHls.instances).toHaveLength(0);
    });

    it('says no video has been uploaded when the playlist is missing', async () => {
      const { player } = await failWith(new Response('', { status: 404 }));
      await vi.waitFor(() => expect(player.getState().error).toEqual(NO_VIDEO));
    });

    it('says no video has been uploaded when the playlist is empty', async () => {
      const { player } = await failWith(new Response('#EXTM3U\n#EXT-X-ENDLIST\n', { status: 200 }));
      await vi.waitFor(() => expect(player.getState().error).toEqual(NO_VIDEO));
    });

    it('refreshes an expired playlist url', async () => {
      const refreshRoute = vi.fn(() => Promise.resolve({ ...ROUTE, share_sig: 'fresh' }));
      const { video } = await failWith(new Response('', { status: 403 }), refreshRoute);
      await vi.waitFor(() => expect(video.src).toContain('sig=fresh'));
    });
  });
});

describe('hls.js errors', () => {
  it('decides what to do about them', () => {
    expect(classifyHlsError(missing(0)).action).toEqual('skip');
    expect(classifyHlsError({ ...missing(0), fatal: true }).action).toEqual('skip');
    expect(classifyHlsError(missing(0, 403)).action).toEqual('refresh');
    expect(classifyHlsError({ type: 'mediaError', details: 'bufferStalledError', fatal: false }).action).toEqual('ignore');
    expect(classifyHlsError(MEDIA_ERROR).action).toEqual('recover');
    expect(classifyHlsError({ type: 'networkError', details: 'manifestLoadError', fatal: true, response: { code: 404 } }).message)
      .toEqual(NO_VIDEO);
    expect(classifyHlsError({ type: 'networkError', details: 'fragLoadError', fatal: true }, false).message)
      .toEqual('You are offline.');
    expect(classifyHlsError({ type: 'otherError', details: 'internalException', fatal: true }).action).toEqual('fail');
  });
});
