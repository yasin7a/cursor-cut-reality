import type { Box, SlashTrail } from "./trail";

const MAX = 160;
const STRIDE = 5; // x, y, size, alpha, hue
/** Size of the GPU buffer that holds a full pool. */
export const PARTICLE_BYTES = MAX * STRIDE * 4;

/**
 * Motes of the page being pulled into the rift. A fixed pool — nothing is
 * allocated per frame — packed into one interleaved buffer for GL_POINTS.
 */
export class Particles {
  readonly data = new Float32Array(MAX * STRIDE);
  count = 0;
  readonly box: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };

  private x = new Float32Array(MAX);
  private y = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private ax = new Float32Array(MAX);
  private ay = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private hue = new Float32Array(MAX);
  private alive = new Uint8Array(MAX);
  private debt = 0;

  reset() {
    this.alive.fill(0);
    this.count = 0;
    this.debt = 0;
  }

  update(dt: number, trail: SlashTrail) {
    this.debt += 70 * Math.min(1, trail.maxHalfWidth / 24) * dt;
    while (this.debt >= 1) {
      this.debt -= 1;
      this.spawn(trail);
    }

    let n = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < MAX; i++) {
      if (!this.alive[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        continue;
      }
      this.vx[i] += this.ax[i] * dt;
      this.vy[i] += this.ay[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;

      const o = n * STRIDE;
      this.data[o] = this.x[i];
      this.data[o + 1] = this.y[i];
      this.data[o + 2] = this.size[i];
      this.data[o + 3] = Math.sin(Math.PI * (1 - this.life[i] / this.maxLife[i])) * 0.85;
      this.data[o + 4] = this.hue[i];
      x0 = Math.min(x0, this.x[i]);
      y0 = Math.min(y0, this.y[i]);
      x1 = Math.max(x1, this.x[i]);
      y1 = Math.max(y1, this.y[i]);
      n++;
    }
    this.count = n;
    if (n) Object.assign(this.box, { x0: x0 - 8, y0: y0 - 8, x1: x1 + 8, y1: y1 + 8 });
  }

  private spawn(trail: SlashTrail) {
    if (trail.count < 2) return;
    const slot = this.alive.indexOf(0);
    if (slot < 0) return;

    for (let tries = 0; tries < 6; tries++) {
      const i = Math.floor(Math.random() * trail.count);
      const hw = trail.points[i * 4 + 2];
      if (hw < 4) continue;

      const side = Math.random() < 0.5 ? -1 : 1;
      const nx = trail.normals[i * 2] * side;
      const ny = trail.normals[i * 2 + 1] * side;
      const dist = hw + 8 + Math.pow(Math.random(), 1.4) * 100;
      const speed = 25 + Math.random() * 55;

      this.x[slot] = trail.points[i * 4] + nx * dist;
      this.y[slot] = trail.points[i * 4 + 1] + ny * dist;
      this.vx[slot] = -nx * speed;
      this.vy[slot] = -ny * speed;
      this.ax[slot] = -nx * 160;
      this.ay[slot] = -ny * 160;
      this.maxLife[slot] = this.life[slot] = 0.6 + Math.random() * 0.7;
      this.size[slot] = 1.2 + Math.random() * 1.8;
      this.hue[slot] = Math.random() < 0.3 ? 1 : 0;
      this.alive[slot] = 1;
      return;
    }
  }
}
