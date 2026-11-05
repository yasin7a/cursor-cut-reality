/**
 * The rift's sound: one hit per fast stroke, and nothing else — ordinary
 * pointer movement is silent.
 *
 * It plays a single recorded sample (any short whoosh/hit; the URL is an
 * option). Silence at either end of the file is trimmed on load, so the hit
 * lands the moment the blade moves. Stereo is kept, it is panned gently toward
 * the blade, and a limiter stops overlapping hits from clipping.
 *
 * Nothing is fetched or created until the first user gesture (browsers
 * require one); the context is suspended a moment after the sound has ended,
 * while muted and while the tab is hidden, so silence is free.
 */

export type RiftSoundState = {
  energy: number; // 0..1 — how hard the blade is moving right now
  open: number; // 0..1 — how open the widest part of the cut is
  pan: number; // -1..1 — cursor x across the hero
  height: number; // 0..1 — cursor y across the hero (0 top)
  dt: number; // ms since the previous update
};

export type RiftSound = {
  /** Call from a user-gesture handler (pointerdown/keydown). Creates/resumes the AudioContext and loads the sample. Idempotent. */
  unlock(): void;
  /** Per frame while the rift is alive. The sample needs nothing per frame; kept so the engine's contract stays the same. */
  update(state: RiftSoundState): void;
  /** A fast stroke just began: play the strike. intensity 0..1; direction −1/+1 is the way the blade travels. */
  slash(intensity: number, pan: number, direction?: number): void;
  setMuted(muted: boolean): void;
  /** Stop everything, disconnect, close the AudioContext. */
  dispose(): void;
};

/** For a sample that peaks near −3 dBFS this puts a full-strength strike at about −6 dBFS. */
const LEVEL = 0.71;
/** Softer swipes are only a little quieter: a normal, present hit every time. */
const SOFTEST = 0.8;
/** Gentle panning: the recording is wide stereo, hard panning would drop one side of it. */
const PAN = 0.35;
/** A playing hit is not restarted for this long (seconds), so a flurry of swipes doesn't machine-gun it. */
const NO_RESTART = 0.35;
/** Two strikes closer than this are one stroke. */
const MIN_GAP = 0.14;
/** A new strike takes over from a sounding one with this fade (seconds). */
const HANDOFF = 0.06;
/** Suspend the context this long after the sound has ended. */
const IDLE_AFTER_MS = 1000;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Below this (≈ −54 dBFS) a sample counts as silence when trimming the ends. */
const SILENCE = 0.002;

/** The same sound without the silence before and after it. */
function trimSilence(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const loud = (i: number) => channels.some((d) => Math.abs(d[i]) > SILENCE);
  let start = 0;
  let end = buffer.length;
  while (start < end && !loud(start)) start++;
  while (end > start && !loud(end - 1)) end--;
  // Keep a few ms either side so the attack and the tail aren't clipped.
  const pad = Math.round(buffer.sampleRate * 0.004);
  start = Math.max(0, start - pad);
  end = Math.min(buffer.length, end + pad);
  if (end - start < 2 || (start === 0 && end === buffer.length)) return buffer;
  const out = ctx.createBuffer(buffer.numberOfChannels, end - start, buffer.sampleRate);
  channels.forEach((d, c) => out.copyToChannel(d.subarray(start, end), c));
  return out;
}

/** Returns null when Web Audio is unavailable. Pass `context` (e.g. an OfflineAudioContext) and `sample` for testing; then unlock/suspend logic is skipped. */
export function createRiftSound(url: string, options?: { context?: BaseAudioContext; sample?: AudioBuffer }): RiftSound | null {
  const external = options?.context ?? null;
  let Ctor: typeof AudioContext | undefined;
  if (!external) {
    if (typeof window === "undefined") return null;
    Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
  }

  let ctx: BaseAudioContext | null = external;
  let real: AudioContext | null = null;
  let out: GainNode | null = null;
  let sample: AudioBuffer | null = options?.sample ?? null;
  let loading = false;
  let muted = false;
  let disposed = false;
  let idleTimer = 0;
  let lastStrike = -1;
  let voice: { src: AudioBufferSourceNode; gain: GainNode; start: number; end: number } | null = null;

  const hidden = () => typeof document !== "undefined" && document.hidden;

  const connectOut = (c: BaseAudioContext) => {
    out = c.createGain();
    out.gain.value = 1;
    // Safety only: catches the brief overlap when a new hit takes over from the last.
    const limit = c.createDynamicsCompressor();
    limit.threshold.value = -3;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.002;
    limit.release.value = 0.1;
    out.connect(limit).connect(c.destination);
  };
  if (external) connectOut(external);

  const load = () => {
    if (sample || loading || !real) return;
    loading = true;
    const target = real;
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((bytes) => target.decodeAudioData(bytes))
      .then((decoded) => {
        if (!disposed) sample = trimSilence(target, decoded);
      })
      .catch(() => {
        // No sound is better than a broken page; the next unlock retries.
      })
      .finally(() => {
        loading = false;
      });
  };

  const suspend = () => {
    if (real && real.state === "running") void real.suspend().catch(() => {});
  };
  /** Sleeps the context once whatever is playing has finished, plus a margin. */
  const suspendLater = () => {
    if (!real) return;
    if (idleTimer) window.clearTimeout(idleTimer);
    const remaining = voice ? Math.max(0, voice.end - real.currentTime) * 1000 : 0;
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      suspend();
    }, remaining + IDLE_AFTER_MS);
  };
  const onVisibility = () => {
    if (hidden()) suspend();
  };

  const play = (k: number, pan: number, when: number) => {
    if (!ctx || !out || !sample) return;
    const c = ctx;
    // One movement at a time: a new strike takes over from the last.
    if (voice && voice.end > when) {
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, when);
      voice.gain.gain.linearRampToValueAtTime(0, when + HANDOFF);
      try {
        voice.src.stop(when + HANDOFF + 0.01);
      } catch {
        // already stopped
      }
    }
    const src = c.createBufferSource();
    src.buffer = sample;
    const gain = c.createGain();
    gain.gain.value = LEVEL * (SOFTEST + (1 - SOFTEST) * k);
    const panner = c.createStereoPanner?.() ?? null;
    if (panner) panner.pan.value = clamp(pan, -1, 1) * PAN;
    src.connect(gain);
    if (panner) gain.connect(panner).connect(out);
    else gain.connect(out);
    src.start(when);
    const current = { src, gain, start: when, end: when + sample.duration };
    voice = current;
    src.onended = () => {
      if (voice === current) voice = null;
      src.disconnect();
      gain.disconnect();
      panner?.disconnect();
    };
  };

  return {
    unlock() {
      if (disposed || external || !Ctor) return;
      if (!real) {
        try {
          real = new Ctor({ latencyHint: "interactive" });
        } catch {
          return;
        }
        ctx = real;
        connectOut(real);
        document.addEventListener("visibilitychange", onVisibility);
      }
      load();
      // Starting it inside the gesture is what unlocks audio for the page;
      // it parks itself again shortly if nothing plays.
      if (!muted && !hidden() && real.state !== "running") void real.resume().catch(() => {});
      suspendLater();
    },

    update() {
      // Nothing per frame: the strike is a single sample.
    },

    slash(intensity, pan) {
      if (disposed || muted || !ctx || hidden()) return;
      if (!sample) {
        load();
        return;
      }
      if (real && real.state !== "running") void real.resume().catch(() => {});
      const when = ctx.currentTime + 0.005;
      if (when - lastStrike < MIN_GAP) return;
      // Just hit: let it ring for a moment instead of starting it over.
      if (voice && voice.end > when && when - voice.start < NO_RESTART) return;
      lastStrike = when;
      play(clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1), Number.isFinite(pan) ? pan : 0, when);
      suspendLater();
    },

    setMuted(value) {
      muted = value;
      if (muted) suspend();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (idleTimer) window.clearTimeout(idleTimer);
      if (real) document.removeEventListener("visibilitychange", onVisibility);
      try {
        voice?.src.stop();
      } catch {
        // already stopped
      }
      out?.disconnect();
      out = null;
      voice = null;
      if (real && real.state !== "closed") void real.close().catch(() => {});
      real = null;
      ctx = null;
    },
  };
}
