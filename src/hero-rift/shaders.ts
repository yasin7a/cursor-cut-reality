import { LENS_CUTOFF, LENS_RADIUS, MAX_POINTS } from "./trail";

/** One oversized triangle covers the viewport — no quad seam, three vertices. */
export const QUAD_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0., 1.); }`;

const NOISE = `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = .5, s = 0.;
  for (int i = 0; i < 6; i++) { s += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= .5; }
  return s;
}`;

/**
 * Deep space, baked once into a texture at start-up. This is the most
 * expensive maths in the effect (~18 noise lookups per pixel), so it never
 * runs per frame.
 */
export const NEBULA_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
${NOISE}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 q = p / 380.;
  float n = fbm(q * 1.3 + vec2(fbm(q * 2.1 + 3.), fbm(q * 2.1 + 9.)) * 1.6);
  vec3 c = mix(vec3(.012, .008, .03), vec3(.20, .08, .38), smoothstep(.26, .62, n));
  c = mix(c, vec3(.55, .22, .55), smoothstep(.46, .72, n) * .7);
  c = mix(c, vec3(1., .74, .38), smoothstep(.56, .82, n) * .95);
  c *= 1.25;

  vec2 sp = floor(p / 2.5);
  c += step(.9965, hash(sp)) * vec3(1., .95, .88) * (.4 + .6 * hash(sp + 2.));
  vec2 g = p / 46., cell = floor(g);
  vec2 f = fract(g) - .5 - (vec2(hash(cell), hash(cell + 7.)) - .5) * .6;
  float big = step(.86, hash(cell + 3.));
  c += big * (exp(-dot(f, f) * 900.)
    + exp(-abs(f.x) * 90. - abs(f.y) * 9.) * .25
    + exp(-abs(f.y) * 90. - abs(f.x) * 9.) * .25) * vec3(1., .93, .82);
  outColor = vec4(c, 1.);
}`;

/**
 * The rift. Every pixel finds the nearest part of the cut (a union of capsules
 * whose radius is the cut's local half-width), then either:
 *  - outside: re-draws the page background — grid, atmosphere, grain —
 *    displaced away from the cut (gravitational lensing), fading to
 *    transparent where the push drops under a pixel so it blends into the
 *    real CSS layers underneath;
 *  - inside: shows the code layer floating over baked deep space. Both shift
 *    with the cursor at different rates, so the cut reads as a window with
 *    depth behind it.
 * Then the lip's hairline edge is composited on top — no halo, no shadow.
 *
 * Cost control: segments whose bounding circle cannot beat the current best
 * are skipped before any per-segment maths, the lens has a hard cutoff that
 * the scissor box in trail.ts mirrors, and the three-tap chromatic split only
 * runs near the lip.
 */
export const MAIN_FRAG = `#version 300 es
precision highp float;
precision highp int;

#define MAX_PTS ${MAX_POINTS}

uniform vec4 uPts[MAX_PTS];   // x, y (css px), half-width, age (+2 = stroke ends here)
uniform vec4 uSeg[MAX_PTS];   // segment i -> i+1: centre, radius incl. width, half-length
uniform int uCount;
uniform vec2 uRes;            // drawing buffer, device px
uniform vec2 uSize;           // hero box, css px
uniform float uScale;         // device px per css px
uniform float uTime;
uniform vec2 uParallax;       // smoothed cursor offset from the hero's centre, -1..1
uniform sampler2D uNebula;
uniform sampler2D uCode;
uniform vec2 uCodeSize;       // css px
uniform vec3 uBg, uFg, uAccent, uRim, uGlow, uViolet;
uniform float uDark;

out vec4 outColor;

const float NEBULA_SIZE = 1024.;
const float LENS_CUTOFF = ${LENS_CUTOFF.toFixed(2)};
const float LENS_RADIUS = ${LENS_RADIUS.toFixed(1)};

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Signed distance to a tapered capsule (circles of radius ra at a and rb at b,
// joined by their tangent lines) — Inigo Quilez's sdUnevenCapsule. Plain
// capsules with an interpolated radius leave scallops along a tapering lip.
float unevenCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pb = b - a;
  p -= a;
  float h = dot(pb, pb);
  vec2 q = vec2(dot(p, vec2(pb.y, -pb.x)), dot(p, pb)) / h;
  q.x = abs(q.x);
  float len = sqrt(h);
  float r = clamp(ra - rb, -.999 * len, .999 * len);
  vec2 c = vec2(sqrt(h - r * r), r);
  float k = c.x * q.y - c.y * q.x;
  if (k < 0.) return len * length(q) - ra;
  if (k > c.x) return sqrt(h * (dot(q, q) + 1. - 2. * q.y)) - rb;
  return dot(c, q) - ra;
}

struct Hit { float e; float d; float dmin; float side; float hw; float age; vec2 n; vec2 tg; vec2 q; int idx; };

Hit nearest(vec2 p) {
  Hit h;
  h.e = 1e9; h.d = 1e9; h.dmin = 1e9; h.side = 1.; h.hw = 0.; h.age = 1.;
  h.n = vec2(0., 1.); h.tg = vec2(1., 0.); h.q = p; h.idx = -1;
  for (int i = 0; i < MAX_PTS - 1; i++) {
    if (i >= uCount - 1) break;
    vec4 A = uPts[i];
    if (A.w >= 2.) continue;                 // stroke ends here; no segment to the next point
    // Skip segments that can improve neither the nearest edge nor the nearest centreline.
    vec4 S = uSeg[i];
    vec2 dc = p - S.xy;
    float dd = dot(dc, dc);
    float limE = h.e + S.z;
    float limD = h.dmin + S.w;
    if ((limE < 0. || dd > limE * limE) && dd > limD * limD) continue;
    vec4 B = uPts[i + 1];
    vec2 ba = B.xy - A.xy;
    float l2 = dot(ba, ba);
    if (l2 < 1e-4) continue;
    float k = clamp(dot(p - A.xy, ba) / l2, 0., 1.);
    vec2 q = A.xy + ba * k;
    float d = length(p - q);
    float hw = mix(A.z, B.z, k);
    float e = d - hw;
    h.dmin = min(h.dmin, d);
    if (e < h.e) {
      vec2 dir = ba * inversesqrt(l2);
      h.e = e; h.d = d; h.hw = hw; h.tg = dir; h.q = q; h.idx = i;
      h.n = vec2(-dir.y, dir.x);
      h.side = dot(p - q, h.n) >= 0. ? 1. : -1.;
      h.age = mix(A.w, B.w >= 2. ? B.w - 2. : B.w, k);
    }
  }
  // The cheap distance above picks the segment; the exact tapered-capsule
  // distance of it and its neighbours then shapes the edge, which removes the
  // scallops a tapering lip would otherwise show, at a fraction of the cost of
  // evaluating it for every segment.
  if (h.idx >= 0) {
    float best = 1e9;
    for (int j = -1; j <= 1; j++) {
      int s = h.idx + j;
      if (s < 0 || s >= uCount - 1) continue;
      vec4 A = uPts[s];
      if (A.w >= 2.) continue;
      vec4 B = uPts[s + 1];
      if (dot(B.xy - A.xy, B.xy - A.xy) < 1e-4) continue;
      best = min(best, unevenCapsule(p, A.xy, B.xy, A.z, B.z));
    }
    if (best < 1e8) h.e = best;
  }
  return h;
}

// Coverage of the CSS grid's 1px line (at the start of every 64px tile) over this pixel.
float lineCov(float x, float fw) {
  float u = mod(x, 64.);
  float a = max(0., min(u + fw * .5, 1.) - max(u - fw * .5, 0.));
  float b = max(0., min(u - 64. + fw * .5, 1.) - max(u - 64. - fw * .5, 0.));
  return clamp((a + b) / fw, 0., 1.);
}

// The hero background exactly as hero-rift.css draws it: .hero-rift__grid + .hero-rift__atmosphere.
vec3 surface(vec2 s) {
  float fw = 1. / uScale;
  float gx = lineCov(s.x, fw) * .045;
  float gy = lineCov(s.y, fw) * .045;
  float g = 1. - (1. - gx) * (1. - gy);
  vec2 el = (s - vec2(uSize.x * .5, 0.)) / vec2(uSize.x * .8, uSize.y * .55);
  float mask = 1. - clamp((length(el) - .2) / .55, 0., 1.);
  vec3 c = mix(uBg, uFg, g * mask);
  c = mix(c, uAccent, .10 * (1. - clamp(length(s - uSize * vec2(.78, .10)) / 486.4, 0., 1.)));
  c = mix(c, uAccent, .05 * (1. - clamp(length(s - uSize * vec2(.06, .94)) / 312., 0., 1.)));
  // Mean effect of the .hero-atmosphere::after film grain (3.2% fractal noise),
  // fitted to screenshots of both themes: +2.6 levels on the dark ground,
  // -0.8 on the light one. Without it the lens area shows as a faint stain.
  return c * .9859 + .011;
}

vec4 over(vec4 top, vec4 base) { return top + base * (1. - top.a); }

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  Hit h = nearest(p);
  float hw = h.hw;
  float open = smoothstep(.4, 3., hw);
  vec4 col = vec4(0.);

  if (h.e > 0.) {
    float e = h.e;
    const float R = LENS_RADIUS;
    float f = exp(-(e * e) / (R * R)) * (1. - smoothstep(1.6 * R, LENS_CUTOFF * R, e));
    // Radially away from the nearest point: equal to the normal along a
    // segment, and continuous around the tips and corners where it isn't.
    vec2 away = h.d > 1e-3 ? (p - h.q) / h.d : h.n * h.side;
    // Local width from two continuous fields (distance to the centreline minus
    // distance to the edge), so the push never jumps where the nearest segment
    // changes — e.g. past a tapered tip.
    float width = clamp(h.dmin - h.e, 0., hw + 40.);
    // Mostly straight apart, with a light shear along the blade's direction.
    vec2 push = (away * 1.3 + h.side * h.tg * .2) * width * f;
    float a = smoothstep(.2, 1.5, length(push));
    if (a > 0.) {
      vec3 c;
      if (e < 240.) {
        float ab = 1. + .12 * exp(-e / 60.);   // chromatic split near the lip
        c = vec3(surface(p - push * ab).r, surface(p - push).g, surface(p - push / ab).b);
      } else {
        c = surface(p - push);
      }
      col = vec4(c * a, a);
    }
  } else {
    float x = clamp(h.d / max(hw, 1e-3), 0., 1.);
    // A window with depth: deep space drifts and shifts most, the code less.
    vec2 deep = p * .7 + uParallax * 34. + vec2(uTime * 5., uTime * 1.5);
    vec3 c = texture(uNebula, deep / NEBULA_SIZE).rgb * .55;
    vec2 uv = (p + uParallax * 10.) / uCodeSize;
    vec4 cd = texture(uCode, uv);                // premultiplied
    vec4 bloom = textureLod(uCode, uv, 2.5);     // mip chain = free soft glow
    c += bloom.rgb * vec3(1., .75, .45) * 1.6;
    c = c * (1. - cd.a) + cd.rgb * 1.25;
    c *= .3 + .7 * smoothstep(1., .5, x);
    // The cut has thickness: its inner faces catch the rim's light, warm on
    // the lit side and violet-shadowed on the other.
    float face = smoothstep(.62, 1., x);
    c += mix(uViolet * .22, uGlow * .38, step(0., h.side)) * face * open;
    // Where the cut is thinner than a pixel (the needle tips) it fades in by
    // coverage instead of drawing a hard dark hairline.
    col = vec4(c, 1.) * smoothstep(.25, 1.6, hw);
  }

  // Only the cut's own edge is lit: a crisp hairline, no halo or shadow
  // around it. It cools as the cut heals — white-hot behind the blade, then
  // gold, then amber.
  float rim = exp(-abs(h.e) / 1.4) * open * .95;
  vec3 rimCol = mix(uRim, mix(uGlow, vec3(.85, .38, .12), .35 * uDark), smoothstep(.06, .55, h.age));
  col = over(vec4(rimCol, 1.) * rim, col);
  col.rgb += (hash(gl_FragCoord.xy) - .5) * .03 * col.a;
  outColor = col;
}`;

export const PARTICLE_VERT = `#version 300 es
in vec2 aPos;
in vec3 aMeta;   // size (css px), alpha, hue
uniform vec2 uRes;
uniform float uScale;
out float vAlpha;
out float vHue;
void main() {
  vec2 d = aPos * uScale;
  gl_Position = vec4(d.x / uRes.x * 2. - 1., 1. - d.y / uRes.y * 2., 0., 1.);
  gl_PointSize = aMeta.x * uScale;
  vAlpha = aMeta.y;
  vHue = aMeta.z;
}`;

export const PARTICLE_FRAG = `#version 300 es
precision mediump float;
in float vAlpha;
in float vHue;
uniform vec3 uGlow, uViolet;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec2 c = abs(gl_PointCoord - .5);
  float a = vAlpha * uAlpha * (1. - smoothstep(.3, .5, max(c.x, c.y)));
  outColor = vec4(mix(uGlow, uViolet, vHue) * a, a);
}`;
