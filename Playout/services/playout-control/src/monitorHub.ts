/**
 * Channel monitoring: engine frames to the operator's screen.
 *
 * The Preview and Program panels used to draw a slate — a card built from scene metadata,
 * because no frame ever reached the operator UI. The engine has always been able to stream
 * (`preview.streamStart` renders JPEGs on its own cadence); nothing consumed them outside
 * the Editor. This is the missing consumer.
 *
 * **Fill and key, not alpha.** Broadcast does not carry transparency as an alpha channel —
 * SDI has none — so a graphics engine emits fill (the colour) and key (a greyscale matte) as
 * two signals and the downstream keyer recombines them. Operators check a graphic by looking
 * at the key as a greyscale picture. That makes a key a *render mode*, which JPEG carries
 * perfectly well, so there is no alpha-capable codec anywhere in this path: reaching for one
 * would have produced a design-tool checkerboard no operator uses, at the cost of a PNG
 * deflate per frame and a transcode.
 *
 * Other decisions worth stating, because each is somewhere this could go wrong:
 *
 * - **Refcounted per channel and view.** A stream costs GPU work. It starts when the first
 *   viewer subscribes and stops when the last one leaves, so an unattended operator station
 *   is not rendering previews nobody is looking at. In practice a station runs two streams,
 *   because a monitor shows fill *or* key. Watching all four at once spends the engine's
 *   whole default budget of 4 — the engine refuses the fifth explicitly, naming the limit.
 *
 * - **Frames are decoded once.** The protocol carries base64; every subscriber gets the
 *   same `Buffer`. Decoding per subscriber would scale the cost with the number of watchers
 *   for identical bytes.
 *
 * - **Latest frame only, never a queue.** A monitor showing a stale frame is worse than one
 *   showing the newest late. A slow HTTP client misses frames rather than accumulating them.
 *
 * - **Program is never at risk.** The engine bounds its own stream cadence and skips a tick
 *   it cannot serve. Nothing here can make Program miss a deadline, which is why monitoring
 *   is allowed to share the renderer at all.
 *
 * - **A missing engine is a normal state.** Playout runs with no engine connected; the
 *   monitor reports "no signal" and keeps trying rather than failing a request.
 */

import type { EngineChannel, PreviewView } from "@grapix/render-protocol";
import { MAX_PROJECT_DIMENSION } from "@grapix/shared-types";
import type { PlayoutEngineController } from "./engineController.js";

/** Channels the operator UI can watch. `auxiliary` exists in the protocol but has no panel. */
export const MONITOR_CHANNELS = ["preview", "program"] as const;
export type MonitorChannel = (typeof MONITOR_CHANNELS)[number];

/** Fill is the colour an audience sees; key is the matte a downstream keyer cuts. */
export const MONITOR_VIEWS = ["fill", "key"] as const;

/**
 * Confidence monitors are deliberately small. A windowed output instead observes Program
 * at native project resolution; the engine's preview pixel budget remains the hard guard.
 */
export const MONITOR_STREAM_TIERS = ["confidence", "output"] as const;
export type MonitorStreamTier = (typeof MONITOR_STREAM_TIERS)[number];

export function isMonitorStreamTier(value: string): value is MonitorStreamTier {
  return (MONITOR_STREAM_TIERS as readonly string[]).includes(value);
}

export function isMonitorChannel(value: string): value is MonitorChannel {
  return (MONITOR_CHANNELS as readonly string[]).includes(value);
}

export function isMonitorView(value: string): value is PreviewView {
  return (MONITOR_VIEWS as readonly string[]).includes(value);
}

/** One decoded frame, ready to write to any number of clients. */
export interface MonitorFrame {
  bytes: Buffer;
  width: number;
  height: number;
  /** Scene frame number the engine rendered, for a diagnostic overlay. */
  frame: number;
  sceneId: string | null;
  renderMs: number;
  receivedAtMs: number;
}

export interface MonitorChannelStatus {
  channel: MonitorChannel;
  view: PreviewView;
  tier: MonitorStreamTier;
  /** Someone is watching and frames are arriving. */
  live: boolean;
  viewers: number;
  targetFps: number | null;
  framesReceived: number;
  lastFrameAtMs: number | null;
  width: number | null;
  height: number | null;
  sceneId: string | null;
  lastError: string | null;
}

export interface MonitorHubOptions {
  /** Engine profile to watch. */
  profileId: string;
  /**
   * Frame cadence. Use the engine's 30 fps monitor ceiling: short in-animations can finish
   * in under half a second, and a 15 fps confidence stream made them look like a jump from
   * a thumbnail to the held final frame.
   */
  targetFps?: number;
  /** Confidence-monitor bounds. Windowed outputs use the project-resolution ceiling. */
  maxWidth?: number;
  maxHeight?: number;
  /** Confidence-monitor JPEG quality. Windowed outputs use a higher fixed quality. */
  quality?: number;
  /**
   * How long without a frame before a channel reports `live: false` while still
   * subscribed. Generous relative to the interval so one skipped tick is not a fault.
   */
  staleAfterMs?: number;
  /**
   * How long to wait before trying a refused start again.
   *
   * A monitor's HTTP connection stays open across this, so a viewer who attached while
   * nothing was cued starts seeing frames when a scene is taken — without reconnecting
   * and without the operator reloading.
   */
  retryMs?: number;
  now?: () => number;
}

type FrameListener = (frame: MonitorFrame) => void;

interface ChannelState {
  channel: MonitorChannel;
  view: PreviewView;
  tier: MonitorStreamTier;
  streamId: string;
  listeners: Set<FrameListener>;
  /** Guards against two subscribers racing to start the same stream. */
  starting: Promise<void> | null;
  started: boolean;
  /** Pending retry of a refused start. Cleared when the stream runs or the last viewer leaves. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  targetFps: number | null;
  framesReceived: number;
  lastFrameAtMs: number | null;
  width: number | null;
  height: number | null;
  sceneId: string | null;
  lastError: string | null;
}

interface MonitorStreamProfile {
  targetFps: number;
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

/**
 * A scaled-stage request never upscales, so these bounds mean "native project resolution".
 * The engine still refuses a canvas above its negotiated maxPreviewPixels limit instead of
 * silently returning a smaller frame.
 */
const OUTPUT_STREAM_PROFILE: Readonly<MonitorStreamProfile> = Object.freeze({
  targetFps: 30,
  maxWidth: MAX_PROJECT_DIMENSION,
  maxHeight: MAX_PROJECT_DIMENSION,
  quality: 92
});

/** Identity of one watchable surface. */
const keyOf = (channel: MonitorChannel, view: PreviewView, tier: MonitorStreamTier) =>
  `${channel}/${view}/${tier}`;

export class MonitorHub {
  private readonly engine: PlayoutEngineController;
  private readonly options: Required<Omit<MonitorHubOptions, "now">>;
  private readonly now: () => number;
  private readonly channels = new Map<string, ChannelState>();
  private detachEvents: (() => void) | null = null;

  constructor(engine: PlayoutEngineController, options: MonitorHubOptions) {
    this.engine = engine;
    this.options = {
      profileId: options.profileId,
      targetFps: options.targetFps ?? 30,
      maxWidth: options.maxWidth ?? 640,
      maxHeight: options.maxHeight ?? 360,
      quality: options.quality ?? 70,
      staleAfterMs: options.staleAfterMs ?? 2_000,
      retryMs: options.retryMs ?? 2_000
    };
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Attach to the engine event stream.
   *
   * Safe to call before any engine is connected: the controller's subscription outlives
   * individual connections, so frames arrive whenever an engine appears.
   */
  start(): void {
    if (this.detachEvents) return;
    this.detachEvents = this.engine.onEngineEvent((event) => {
      if (event.type === "engine-event" && event.eventType === "event.previewFrame") {
        this.acceptFrame(event.message.payload as Record<string, unknown>);
        return;
      }
      // A scene arriving on a channel is the moment a refused stream becomes startable.
      //
      // `preview.streamStart` refuses while a channel is empty, so a monitor opened before
      // anything was cued sits on the retry interval. Waiting for that meant an "in"
      // animation — 20 frames is 0.4s — was over before the first frame arrived, and the
      // operator saw only the finished graphic. The engine announces the take, so act on it
      // rather than poll.
      if (event.type === "engine-event" && event.eventType === "event.channelChanged") {
        this.handleChannelChanged(event.message.payload as Record<string, unknown>);
        return;
      }
      // The engine drops every stream belonging to a client when the socket closes, so
      // what this hub believes is running is no longer true. Re-arm for the surfaces that
      // still have viewers instead of showing a frozen last frame forever.
      if (event.type === "closed" || (event.type === "state" && event.state === "offline")) {
        this.handleEngineLoss(event.type === "closed" ? event.reason : "engine offline");
      }
    });
  }

  /** Stop every stream and detach. */
  async close(): Promise<void> {
    this.detachEvents?.();
    this.detachEvents = null;
    for (const state of this.channels.values()) this.clearRetry(state);
    const running = [...this.channels.values()].filter((state) => state.started);
    this.channels.clear();
    await Promise.all(
      running.map((state) => this.engine.stopPreviewStream(this.options.profileId, state.streamId))
    );
  }

  /**
   * Watch a channel.
   *
   * Returns a detach function. The first subscriber starts the engine stream; the last to
   * leave stops it. Callers get frames only while attached, and never a replay: a monitor
   * that opens mid-scene should show the next real frame, not a stale one.
   */
  subscribe(
    channel: MonitorChannel,
    view: PreviewView,
    listener: FrameListener,
    tier: MonitorStreamTier = "confidence"
  ): () => void {
    const state = this.channelState(channel, view, tier);
    state.listeners.add(listener);
    // Fire-and-forget: an HTTP response must not wait on the GPU, and a failure to start
    // is reported through status rather than by failing the viewer's request.
    void this.ensureStream(channel, view, tier);

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      state.listeners.delete(listener);
      if (state.listeners.size === 0) void this.releaseStream(channel, view, tier);
    };
  }

  status(): MonitorChannelStatus[] {
    const now = this.now();
    const rows: MonitorChannelStatus[] = [];
    for (const channel of MONITOR_CHANNELS) {
      for (const view of MONITOR_VIEWS) {
        for (const tier of MONITOR_STREAM_TIERS) {
          const state = this.channels.get(keyOf(channel, view, tier));
          // Confidence surfaces always appear so the operator can distinguish idle from
          // missing. Output surfaces appear once a window has actually requested one.
          if (!state && tier === "output") continue;
          if (!state) {
            rows.push({
              channel,
              view,
              tier,
              live: false,
              viewers: 0,
              targetFps: null,
              framesReceived: 0,
              lastFrameAtMs: null,
              width: null,
              height: null,
              sceneId: null,
              lastError: null
            });
            continue;
          }
          const fresh =
            state.lastFrameAtMs !== null && now - state.lastFrameAtMs <= this.options.staleAfterMs;
          rows.push({
            channel,
            view,
            tier,
            live: state.listeners.size > 0 && fresh,
            viewers: state.listeners.size,
            targetFps: state.targetFps,
            framesReceived: state.framesReceived,
            lastFrameAtMs: state.lastFrameAtMs,
            width: state.width,
            height: state.height,
            sceneId: state.sceneId,
            lastError: state.lastError
          });
        }
      }
    }
    return rows;
  }

  private channelState(
    channel: MonitorChannel,
    view: PreviewView,
    tier: MonitorStreamTier
  ): ChannelState {
    const id = keyOf(channel, view, tier);
    const existing = this.channels.get(id);
    if (existing) return existing;
    const state: ChannelState = {
      channel,
      view,
      tier,
      // Keep confidence ids stable for diagnostics; output observers are a separate stream
      // so opening a native-resolution window cannot enlarge the small operator panels.
      streamId:
        tier === "confidence"
          ? `playout_monitor_${channel}_${view}`
          : `playout_output_${channel}_${view}`,
      listeners: new Set(),
      starting: null,
      started: false,
      retryTimer: null,
      targetFps: null,
      framesReceived: 0,
      lastFrameAtMs: null,
      width: null,
      height: null,
      sceneId: null,
      lastError: null
    };
    this.channels.set(id, state);
    return state;
  }

  private async ensureStream(
    channel: MonitorChannel,
    view: PreviewView,
    tier: MonitorStreamTier
  ): Promise<void> {
    const state = this.channelState(channel, view, tier);
    if (state.started) return;
    if (state.starting) return state.starting;
    const profile = tier === "output" ? OUTPUT_STREAM_PROFILE : this.options;

    const attempt = (async () => {
      try {
        const ack = await this.engine.startPreviewStream(this.options.profileId, {
          streamId: state.streamId,
          channel: channel as EngineChannel,
          view,
          maxWidth: profile.maxWidth,
          maxHeight: profile.maxHeight,
          targetFps: profile.targetFps,
          quality: profile.quality
        });
        // A viewer may have left while the request was in flight. Do not leave a stream
        // running for nobody.
        if (state.listeners.size === 0) {
          await this.engine.stopPreviewStream(this.options.profileId, state.streamId);
          return;
        }
        state.started = true;
        state.targetFps = ack.targetFps ?? profile.targetFps;
        state.lastError = null;
        this.clearRetry(state);
      } catch (error) {
        // Normal when no engine is connected, nothing is on the channel, or a requested
        // native-resolution output exceeds the engine's explicit preview pixel budget.
        state.started = false;
        state.lastError = error instanceof Error ? error.message : String(error);
        // Try again while someone is still watching. The viewer's HTTP connection stays
        // open across this, so a monitor opened before anything was cued begins painting
        // the moment a scene is taken — no reconnect, no reload. Retrying here rather
        // than in the browser also keeps one refusal per interval instead of one per
        // client.
        this.scheduleRetry(channel, view, tier);
      } finally {
        state.starting = null;
      }
    })();

    state.starting = attempt;
    return attempt;
  }

  /**
   * Retry a refused start while viewers remain.
   *
   * Only ever one timer per surface: a burst of viewers must not turn into a burst of
   * retries, and the timer is unrefed so it cannot hold the process open at shutdown.
   */
  private scheduleRetry(
    channel: MonitorChannel,
    view: PreviewView,
    tier: MonitorStreamTier
  ): void {
    const state = this.channelState(channel, view, tier);
    if (state.retryTimer || state.listeners.size === 0) return;
    const timer = setTimeout(() => {
      state.retryTimer = null;
      if (state.listeners.size > 0 && !state.started) {
        void this.ensureStream(channel, view, tier);
      }
    }, this.options.retryMs);
    timer.unref?.();
    state.retryTimer = timer;
  }

  private clearRetry(state: ChannelState): void {
    if (!state.retryTimer) return;
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  private async releaseStream(
    channel: MonitorChannel,
    view: PreviewView,
    tier: MonitorStreamTier
  ): Promise<void> {
    const state = this.channels.get(keyOf(channel, view, tier));
    if (!state) return;
    // Nobody is watching, so a pending retry would start a stream for no one.
    this.clearRetry(state);
    // Wait out an in-flight start, or the stop would race it and leave a stream running
    // with no viewers.
    if (state.starting) await state.starting.catch(() => undefined);
    if (state.listeners.size > 0 || !state.started) return;
    state.started = false;
    state.lastFrameAtMs = null;
    await this.engine.stopPreviewStream(this.options.profileId, state.streamId);
  }

  /**
   * A channel's content changed, so start any stream that was refused for want of a scene.
   *
   * Both views of that channel are re-armed, and the pending retry is cancelled so the
   * stream starts now rather than at the end of the interval. This is what lets an operator
   * watch an "in" animation from its first frame instead of seeing it already finished.
   */
  private handleChannelChanged(payload: Record<string, unknown>): void {
    const channel = typeof payload.channel === "string" ? payload.channel : null;
    if (!channel || !isMonitorChannel(channel)) return;
    if (payload.sceneId === null) return;
    for (const state of this.channels.values()) {
      if (
        state.channel !== channel ||
        state.listeners.size === 0 ||
        state.started
      ) {
        continue;
      }
      this.clearRetry(state);
      // Logged because the symptom of getting this wrong is subtle and operator-visible:
      // a monitor that starts a second late misses a 0.4s "in" animation entirely and looks
      // like the animation never played.
      console.log(
        `[monitors] ${channel}/${state.view}/${state.tier}: scene arrived on channel, starting stream for ${state.listeners.size} viewer(s)`
      );
      void this.ensureStream(channel, state.view, state.tier);
    }
  }

  private handleEngineLoss(reason: string): void {
    for (const state of this.channels.values()) {
      state.started = false;
      state.lastFrameAtMs = null;
      state.lastError = reason;
      if (state.listeners.size > 0) {
        void this.ensureStream(state.channel, state.view, state.tier);
      }
    }
  }

  private acceptFrame(payload: Record<string, unknown>): void {
    const streamId = typeof payload.streamId === "string" ? payload.streamId : null;
    if (!streamId) return;
    let state: ChannelState | undefined;
    for (const candidate of this.channels.values()) {
      if (candidate.streamId === streamId) {
        state = candidate;
        break;
      }
    }
    if (!state) return;

    const data = typeof payload.data === "string" ? payload.data : null;
    if (!data) return;

    // Decoded once for every subscriber. `base64` is what the protocol carries for jpeg.
    const bytes = Buffer.from(data, "base64");
    const frame: MonitorFrame = {
      bytes,
      width: typeof payload.width === "number" ? payload.width : 0,
      height: typeof payload.height === "number" ? payload.height : 0,
      frame: typeof payload.frame === "number" ? payload.frame : 0,
      sceneId: typeof payload.sceneId === "string" ? payload.sceneId : null,
      renderMs: typeof payload.renderMs === "number" ? payload.renderMs : 0,
      receivedAtMs: this.now()
    };

    state.framesReceived += 1;
    state.lastFrameAtMs = frame.receivedAtMs;
    state.width = frame.width;
    state.height = frame.height;
    state.sceneId = frame.sceneId;
    // Frames arriving proves the stream is up, whatever an earlier start attempt said.
    state.started = true;
    state.lastError = null;

    for (const listener of state.listeners) listener(frame);
  }
}
