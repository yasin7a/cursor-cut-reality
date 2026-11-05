/**
 * The blade's path.
 *
 * Every pointer sample (coalesced events included) goes into a fixed ring
 * buffer as-is — no smoothing lag, so the cut runs exactly where the hand went
 * and the blade's tip sits on the cursor. Each frame the live samples are
 * re-sampled into the short polyline the shader reads.
 *
 * Two properties keep the cut steady:
 *  - re-sampled points sit at fixed distances along the stroke (multiples of a
 *    spacing from a doubling ladder), so they never slide along the curve as
 *    the stroke grows or heals, and the rim does not shimmer; when the spacing
 *    steps up, every other point stays exactly where it was;
 *  - nothing is allocated per frame, so there are no GC pauses mid-swipe.
 */
export const MAX_POINTS = 64;
/** How long a cut stays open before it has fully healed. */
export const LIFE_MS = 1100;

const CAPACITY = 2048; // raw samples
const MIN_STEP = 2.5; // px between raw samples
const SPEED_TAU = 32; // ms — time constant of the blade-speed average
const ENERGY_SPAN = 70; // px — blade energy is smoothed over this much path, so hand-speed noise can't ripple the width
const TIP_TAU = 60; // ms — smoothing of the live blade energy (tip glow, sound)
const TAPER_IN = 130; // px from the start of a stroke to full width
const TAPER_OUT = 200; // px behind the blade to full width — a long, needle-fine tip
const SPACINGS = [8, 16, 32, 64]; // doubling, so a step up keeps half the anchors

/**
 * Lens falloff radius (css px) — mirrors `LENS_RADIUS` in the fragment shader.
 * Constant on purpose: a radius that followed the local cut width would end
 * the lens at a different distance for each segment, leaving step edges where
 * the nearest segment changes.
 */
export const LENS_RADIUS = 80;
/** The shader's lens falls to exactly zero at this multiple of the radius. */
export const LENS_CUTOFF = 2.2;
/** The lit hairline edge reaches a few px past the cut. */
const RIM_REACH = 8;

export type Box = { x0: number; y0: number; x1: number; y1: number };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const t2 = t * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t2 * t);
};
const smootherstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// Underdamped spring (4.2 Hz, damping 0.62): the lips spring apart behind the
// blade in ~90 ms with a small (~8%) overshoot and settle, the way a real cut
// opens — instead of popping to full width in a frame or two, which made the
// lens around it jolt.
const SPRING_W = 2 * Math.PI * 4.2;
const SPRING_Z = 0.62;
const SPRING_WD = SPRING_W * Math.sqrt(1 - SPRING_Z * SPRING_Z);
const SPRING_K = SPRING_Z / Math.sqrt(1 - SPRING_Z * SPRING_Z);
const spring = (ms: number) => {
  if (ms <= 0) return 0;
  const t = ms / 1000;
  return 1 - Math.exp(-SPRING_Z * SPRING_W * t) * (Math.cos(SPRING_WD * t) + SPRING_K * Math.sin(SPRING_WD * t));
};
/** Opening over a point's life (ms): springs open behind the blade, then eases shut. */
const opening = (ageMs: number) => spring(ageMs) * (1 - smootherstep(0.32, 1, ageMs / LIFE_MS));
/** Blade speed (px/ms) → how hard it cuts. A slow drift leaves the surface whole. */
const cutEnergy = (speed: number) => smoothstep(0.4, 2, speed);

export class SlashTrail {
  /** vec4 per point: x, y (css px), half-width, age 0..1 (+2 marks a stroke's last point). */
  readonly points = new Float32Array(MAX_POINTS * 4);
  /** vec4 per segment i→i+1: centre, radius including the cut's width, half-length — for the shader's early-out. */
  readonly bounds = new Float32Array(MAX_POINTS * 4);
  /** Unit normal per point — used to throw motes off the lips. */
  readonly normals = new Float32Array(MAX_POINTS * 2);
  count = 0;
  maxHalfWidth = 0;
  /** 0..1 — how hard the blade is moving right now. */
  energy = 0;
  /** 0..1 — any pointer movement at all, even too slow to cut. */
  motion = 0;
  /** px/ms — how fast the blade really moves (held through gaps between events, decays when it stops). */
  bladeSpeed = 0;
  /** px/ms — horizontal velocity of the blade, smoothed; its sign is the swipe direction. */
  velocityX = 0;
  readonly box: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };
  hasBox = false;

  private readonly rx = new Float32Array(CAPACITY);
  private readonly ry = new Float32Array(CAPACITY);
  private readonly rt = new Float64Array(CAPACITY);
  private readonly re = new Float32Array(CAPACITY);
  private readonly rd = new Float32Array(CAPACITY);
  private readonly rs = new Int32Array(CAPACITY);
  private tail = 0;
  private size = 0;

  private stroke = 0;
  private tracking = false;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private travelled = 0;
  private speed = 0;
  /** Blade energy smoothed along the path (what the width follows). */
  private pathEnergy = 0;
  private lastUpdate = 0;
  private spacing = SPACINGS[0];

  constructor(private maxWidth: () => number) {}

  get active() {
    return this.size > 0;
  }

  /** One pointer sample, in css px relative to the hero, timestamped in the performance.now() timebase. */
  sample(x: number, y: number, time: number) {
    if (!this.tracking) {
      // A fresh stroke starts where the pointer is — never swept in from the last one.
      this.tracking = true;
      this.stroke++;
      this.travelled = 0;
      this.speed = 0;
      this.velocityX = 0;
      this.pathEnergy = 0;
      this.record(x, y, time, 0);
      return;
    }
    const step = Math.hypot(x - this.lastX, y - this.lastY);
    if (step < MIN_STEP) return;
    const dt = Math.max(1, time - this.lastT);
    const blend = 1 - Math.exp(-dt / SPEED_TAU);
    this.speed += (step / dt - this.speed) * blend;
    this.velocityX += ((x - this.lastX) / dt - this.velocityX) * blend;
    this.travelled += step;
    this.pathEnergy += (cutEnergy(this.speed) - this.pathEnergy) * (1 - Math.exp(-step / ENERGY_SPAN));
    this.record(x, y, time, this.pathEnergy);
  }

  /** The blade leaves the surface: the current stroke ends, the next one starts clean. */
  lift() {
    this.tracking = false;
  }

  reset() {
    this.tracking = false;
    this.size = 0;
    this.count = 0;
    this.energy = 0;
    this.motion = 0;
    this.bladeSpeed = 0;
    this.velocityX = 0;
    this.speed = 0;
    this.pathEnergy = 0;
    this.lastUpdate = 0;
    this.maxHalfWidth = 0;
    this.hasBox = false;
  }

  /** Advances the trail to `now`. Returns whether any cut is still alive. */
  update(now: number): boolean {
    while (this.size > 0 && now - this.rt[this.tail] > LIFE_MS) {
      this.tail = (this.tail + 1) % CAPACITY;
      this.size--;
    }
    // Live blade energy: holds through the gaps between pointer events (a 60 Hz
    // mouse leaves 16 ms between samples), decays once the hand really stops,
    // and is eased over time so the tip glow and the sound never flicker.
    const still = Math.max(0, now - this.lastT);
    const held = still > 45 ? Math.exp(-(still - 45) / 80) : 1;
    this.bladeSpeed = this.tracking ? this.speed * held : 0;
    const target = cutEnergy(this.bladeSpeed);
    const moving = this.tracking ? smoothstep(0.06, 0.7, this.speed * held) : 0;
    const dt = this.lastUpdate ? Math.min(50, Math.max(0, now - this.lastUpdate)) : 16.7;
    this.lastUpdate = now;
    const ease = 1 - Math.exp(-dt / TIP_TAU);
    this.energy += (target - this.energy) * ease;
    this.motion += (moving - this.motion) * ease;
    this.build(now);
    return this.size > 0;
  }

  private record(x: number, y: number, time: number, energy: number) {
    if (this.size === CAPACITY) {
      this.tail = (this.tail + 1) % CAPACITY;
      this.size--;
    }
    const i = (this.tail + this.size) % CAPACITY;
    this.rx[i] = x;
    this.ry[i] = y;
    this.rt[i] = time;
    this.re[i] = energy;
    this.rd[i] = this.travelled;
    this.rs[i] = this.stroke;
    this.size++;
    this.lastX = x;
    this.lastY = y;
    this.lastT = time;
  }

  /** Logical index (0 = oldest live sample) → ring slot. */
  private at(k: number) {
    return (this.tail + k) % CAPACITY;
  }

  private build(now: number) {
    // Pass 1: live length and stroke count, to choose a spacing that fits the budget.
    let total = 0;
    let strokes = 0;
    for (let k = 0; k < this.size; ) {
      const id = this.rs[this.at(k)];
      let j = k;
      while (j + 1 < this.size && this.rs[this.at(j + 1)] === id) j++;
      if (j > k) {
        total += this.rd[this.at(j)] - this.rd[this.at(k)];
        strokes++;
      }
      k = j + 1;
    }
    this.chooseSpacing(total, strokes);

    this.count = 0;
    this.maxHalfWidth = 0;
    this.box.x0 = Infinity;
    this.box.y0 = Infinity;
    this.box.x1 = -Infinity;
    this.box.y1 = -Infinity;

    // Pass 2: newest stroke first, so a full budget drops an old cut, never the blade.
    for (let k1 = this.size - 1; k1 >= 0 && this.count < MAX_POINTS - 1; ) {
      const id = this.rs[this.at(k1)];
      let k0 = k1;
      while (k0 > 0 && this.rs[this.at(k0 - 1)] === id) k0--;
      if (k1 > k0) this.emit(k0, k1, now);
      k1 = k0 - 1;
    }
    this.hasBox = this.box.x1 > this.box.x0;
  }

  private chooseSpacing(total: number, strokes: number) {
    const need = (s: number) => total / s + strokes * 2 + 2;
    let fit = SPACINGS[SPACINGS.length - 1];
    for (let i = 0; i < SPACINGS.length; i++) {
      if (need(SPACINGS[i]) <= MAX_POINTS) {
        fit = SPACINGS[i];
        break;
      }
    }
    // Grow at once when the trail no longer fits; shrink only with clear headroom,
    // so the spacing doesn't flip back and forth on the boundary.
    if (fit > this.spacing || need(fit) <= MAX_POINTS * 0.7) this.spacing = fit;
  }

  private emit(k0: number, k1: number, now: number) {
    const { rx, ry, rt, re, rd, points: P } = this;
    const S = this.spacing;
    const first = this.count;
    const budget = MAX_POINTS - first;
    const dB = rd[this.at(k1)];
    // Over budget: keep the newest stretch of the stroke.
    const dA = Math.max(rd[this.at(k0)], dB - (budget - 2) * S);
    const cap = 0.5 * this.maxWidth();

    let n = first;
    let j = k0;
    let target = dA;
    let anchor = Math.floor(dA / S) + 1;
    while (n < MAX_POINTS) {
      while (j < k1 - 1 && rd[this.at(j + 1)] < target) j++;
      const a = this.at(j);
      const b = this.at(j + 1);
      const span = rd[b] - rd[a];
      const u = span > 0 ? clamp01((target - rd[a]) / span) : 0;
      const p0 = this.at(Math.max(k0, j - 1));
      const p3 = this.at(Math.min(k1, j + 2));

      const x = catmull(rx[p0], rx[a], rx[b], rx[p3], u);
      const y = catmull(ry[p0], ry[a], ry[b], ry[p3], u);
      const ageMs = Math.max(0, now - (rt[a] + (rt[b] - rt[a]) * u));
      const age = clamp01(ageMs / LIFE_MS);
      const energy = re[a] + (re[b] - re[a]) * u;
      // Both ends come to a point, so the cut is a blade-shaped leaf. The tapers
      // are measured from fixed places — the stroke's start and the blade — so
      // they never slide as the tail heals; short flicks stay small on their own.
      const ends = smoothstep(0, TAPER_IN, target) * smoothstep(0, TAPER_OUT, dB - target);
      const hw = cap * energy * opening(ageMs) * ends;

      P[n * 4] = x;
      P[n * 4 + 1] = y;
      P[n * 4 + 2] = hw;
      P[n * 4 + 3] = age;

      let reach = 0;
      if (hw > 0.5) reach = hw + Math.max(LENS_CUTOFF * LENS_RADIUS, RIM_REACH) + 4;
      if (reach > 0) {
        if (x - reach < this.box.x0) this.box.x0 = x - reach;
        if (y - reach < this.box.y0) this.box.y0 = y - reach;
        if (x + reach > this.box.x1) this.box.x1 = x + reach;
        if (y + reach > this.box.y1) this.box.y1 = y + reach;
      }
      if (hw > this.maxHalfWidth) this.maxHalfWidth = hw;
      n++;

      if (target >= dB) break;
      const next = anchor * S;
      if (next < dB - S * 0.35) {
        target = next;
        anchor++;
      } else {
        target = dB; // the blade's tip, exactly on the cursor
      }
    }
    if (n === first) return;

    // A tight turn can't open wider than its own radius: beyond that the inner
    // lips would cross and the rim would buckle into cusps. Turn radius is
    // measured over ±2 points (arc length / change of direction), which keeps
    // the cap as smooth as the curve itself.
    for (let i = first + 1; i < n - 1; i++) {
      const a = Math.max(first, i - 2);
      const b = Math.min(n - 1, i + 2);
      const ax = P[a * 4] - P[i * 4];
      const ay = P[a * 4 + 1] - P[i * 4 + 1];
      const bx = P[b * 4] - P[i * 4];
      const by = P[b * 4 + 1] - P[i * 4 + 1];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-3 || lb < 1e-3) continue;
      const turn = Math.acos(Math.max(-1, Math.min(1, -(ax * bx + ay * by) / (la * lb))));
      if (turn < 1e-3) continue;
      const limit = (0.85 * (la + lb)) / turn;
      if (P[i * 4 + 2] > limit) P[i * 4 + 2] = limit;
    }
    P[(n - 1) * 4 + 3] += 2;

    for (let i = first; i < n; i++) {
      const a = Math.max(first, i - 1);
      const b = Math.min(n - 1, i + 1);
      const dx = P[b * 4] - P[a * 4];
      const dy = P[b * 4 + 1] - P[a * 4 + 1];
      const l = Math.hypot(dx, dy) || 1;
      this.normals[i * 2] = -dy / l;
      this.normals[i * 2 + 1] = dx / l;
    }
    for (let i = first; i < n - 1; i++) {
      const ax = P[i * 4];
      const ay = P[i * 4 + 1];
      const bx = P[(i + 1) * 4];
      const by = P[(i + 1) * 4 + 1];
      this.bounds[i * 4] = (ax + bx) * 0.5;
      this.bounds[i * 4 + 1] = (ay + by) * 0.5;
      const half = Math.hypot(bx - ax, by - ay) * 0.5;
      this.bounds[i * 4 + 2] = half + Math.max(P[i * 4 + 2], P[(i + 1) * 4 + 2]);
      this.bounds[i * 4 + 3] = half;
    }
    this.count = n;
  }
}
