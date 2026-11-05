import { buildCodeTile, CODE_TILE } from "./codeTexture";
import { readPalette, type Palette } from "./palette";
import { PARTICLE_BYTES, Particles } from "./particles";
import { MAIN_FRAG, NEBULA_FRAG, PARTICLE_FRAG, PARTICLE_VERT, QUAD_VERT } from "./shaders";
import { createRiftSound, type RiftSound } from "./sound";
import { SlashTrail, type Box } from "./trail";

export type EngineOptions = {
  /** Source text shown inside the cut. */
  code: string;
  /** Monospace family for that text. */
  fontFamily: string;
  /** URL of the slash sample, or null for a silent rift. */
  soundUrl: string | null;
  /** Whether the sound starts on (it still needs one click/key press first — a browser rule). */
  soundEnabled: boolean;
  /** Draw the cut over the page content (this canvas sits above it). */
  over: boolean;
  /** With `over`: a canvas BEHIND the content that receives the lens (the grid bending), so it shows under the text. */
  lensCanvas: HTMLCanvasElement | null;
};

export type RiftController = {
  setSoundEnabled(on: boolean): void;
  destroy(): void;
};

const NEBULA_SIZE = 1024;
/** Device-pixel cap. The effect is glow and blur; past 1.5x nobody can tell, the GPU can. */
const MAX_DPR = 1.5;
/** Adaptive quality never drops the resolution below this fraction. */
const MIN_QUALITY = 0.6;

type GL = WebGL2RenderingContext;
type Uniforms = Record<string, WebGLUniformLocation | null>;

type Resources = {
  main: WebGLProgram;
  particles: WebGLProgram;
  quad: WebGLVertexArrayObject;
  dots: WebGLVertexArrayObject;
  quadBuffer: WebGLBuffer;
  dotBuffer: WebGLBuffer;
  nebula: WebGLTexture;
  code: WebGLTexture;
  u: Uniforms;
  pu: Uniforms;
};

const MAIN_UNIFORMS = [
  "uPts", "uSeg", "uCount", "uRes", "uSize", "uScale", "uTime", "uParallax", "uNebula", "uCode",
  "uCodeSize", "uBg", "uFg", "uAccent", "uRim", "uGlow", "uViolet", "uDark", "uPass",
];
const PARTICLE_UNIFORMS = ["uRes", "uScale", "uGlow", "uViolet", "uAlpha"];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const warn = (error: unknown) => console.warn(error);

/**
 * Compiles and links every program without blocking the main thread where the
 * driver allows it (KHR_parallel_shader_compile): we poll for completion
 * between frames instead of stalling on the first status query.
 */
async function buildPrograms(gl: GL, sources: [string, string][], alive: () => boolean) {
  const parallel = gl.getExtension("KHR_parallel_shader_compile");
  const built = sources.map(([vertex, fragment]) => {
    const program = gl.createProgram();
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!program || !vs || !fs) throw new Error("hero-rift: program allocation failed");
    gl.shaderSource(vs, vertex);
    gl.shaderSource(fs, fragment);
    gl.compileShader(vs);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPos");
    gl.bindAttribLocation(program, 1, "aMeta");
    gl.linkProgram(program);
    return { program, shaders: [vs, fs] };
  });

  if (parallel) {
    while (!built.every(({ program }) => gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR))) {
      await wait(16);
      if (!alive()) return null;
    }
  }

  return built.map(({ program, shaders }) => {
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = shaders.map((s) => gl.getShaderInfoLog(s)).filter(Boolean).join("\n");
      throw new Error(`hero-rift: ${log || gl.getProgramInfoLog(program) || "link failed"}`);
    }
    for (const shader of shaders) {
      gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
    return program;
  });
}

function makeTexture(gl: GL, wrap: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("hero-rift: createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return tex;
}

function locations(gl: GL, program: WebGLProgram, names: string[]): Uniforms {
  return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]));
}

async function createResources(gl: GL, alive: () => boolean): Promise<Resources | null> {
  const programs = await buildPrograms(
    gl,
    [
      [QUAD_VERT, MAIN_FRAG],
      [PARTICLE_VERT, PARTICLE_FRAG],
      [QUAD_VERT, NEBULA_FRAG],
    ],
    alive,
  );
  if (!programs) return null;
  const [main, particles, bake] = programs;

  const quadBuffer = gl.createBuffer();
  const dotBuffer = gl.createBuffer();
  const quad = gl.createVertexArray();
  const dots = gl.createVertexArray();
  if (!quadBuffer || !dotBuffer || !quad || !dots) throw new Error("hero-rift: buffer allocation failed");

  // One oversized triangle covers the viewport.
  gl.bindVertexArray(quad);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(dots);
  gl.bindBuffer(gl.ARRAY_BUFFER, dotBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, PARTICLE_BYTES, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
  gl.bindVertexArray(null);

  // Bake deep space once; the per-frame shader only samples it.
  const nebula = makeTexture(gl, gl.MIRRORED_REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NEBULA_SIZE, NEBULA_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nebula, 0);
  gl.viewport(0, 0, NEBULA_SIZE, NEBULA_SIZE);
  gl.useProgram(bake);
  gl.bindVertexArray(quad);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteProgram(bake);

  // Empty until the font has loaded and the tile is painted.
  const code = makeTexture(gl, gl.REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

  return {
    main,
    particles,
    quad,
    dots,
    quadBuffer,
    dotBuffer,
    nebula,
    code,
    u: locations(gl, main, MAIN_UNIFORMS),
    pu: locations(gl, particles, PARTICLE_UNIFORMS),
  };
}

function release(gl: GL, r: Resources) {
  gl.deleteProgram(r.main);
  gl.deleteProgram(r.particles);
  gl.deleteVertexArray(r.quad);
  gl.deleteVertexArray(r.dots);
  gl.deleteBuffer(r.quadBuffer);
  gl.deleteBuffer(r.dotBuffer);
  gl.deleteTexture(r.nebula);
  gl.deleteTexture(r.code);
}

/**
 * Drives the rift behind the hero. Returns a controller, or null when WebGL2 is
 * unavailable — the CSS grid underneath is then simply left as it is.
 * GPU set-up finishes asynchronously; pointer input is ignored until then.
 */
export function createRiftEngine(canvas: HTMLCanvasElement, section: HTMLElement, options: EngineOptions): RiftController | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;
  const lens2d = options.over && options.lensCanvas ? options.lensCanvas.getContext("2d") : null;
  /** The device-pixel rect copied to the lens canvas last frame (top-left origin), cleared before the next copy. */
  const lensRect = { x: 0, y: 0, w: 0, h: 0 };

  let res: Resources | null = null;
  let disposed = false;
  const alive = () => !disposed && !gl.isContextLost();

  let cssW = 0;
  let cssH = 0;
  let scale = 1;
  let quality = 1;
  let sizeDirty = true;
  let rect = section.getBoundingClientRect();
  let rectDirty = false;
  let visible = true;
  let raf = 0;
  let last = 0;
  let bestDt = 1000 / 60;
  let slowFrames = 0;
  let drewLastFrame = false;
  let codeScale = 0;
  let cursorX = 0;
  let cursorY = 0;
  let parX = 0;
  let parY = 0;

  // A knife cut, not a gash: a slit that parts just wide enough to show the code glowing through.
  const cutWidth = () => Math.min(64, Math.max(36, cssW * 0.031));
  const trail = new SlashTrail(cutWidth);

  // Sound: created and unlocked on the first click/key press (browsers allow
  // audio only after a gesture; pointermove is not one), then driven per frame.
  let sound: RiftSound | null = null;
  let soundOn = options.soundEnabled;
  let cutting = false;
  let lastSlashAt = 0;
  const particles = new Particles();
  let palette: Palette = readPalette(section);
  const box = { x0: 0, y0: 0, x1: 0, y1: 0 };

  // ------------------------------------------------------------ uniforms
  const applyStatic = () => {
    if (!res) return;
    const { u, pu } = res;
    gl.useProgram(res.main);
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform2f(u.uSize, cssW, cssH);
    gl.uniform1f(u.uScale, scale);
    gl.uniform1i(u.uNebula, 0);
    gl.uniform1i(u.uCode, 1);
    gl.uniform2f(u.uCodeSize, CODE_TILE.width, CODE_TILE.height);
    gl.uniform3fv(u.uBg, palette.bg);
    gl.uniform3fv(u.uFg, palette.fg);
    gl.uniform3fv(u.uAccent, palette.accent);
    gl.uniform3fv(u.uRim, palette.rim);
    gl.uniform3fv(u.uGlow, palette.glow);
    gl.uniform3fv(u.uViolet, palette.violet);
    gl.uniform1f(u.uDark, palette.dark ? 1 : 0);
    gl.useProgram(res.particles);
    gl.uniform2f(pu.uRes, canvas.width, canvas.height);
    gl.uniform1f(pu.uScale, scale);
    gl.uniform3fv(pu.uGlow, palette.glow);
    gl.uniform3fv(pu.uViolet, palette.violet);
    // On the cream ground bright motes read as dust, so they stay faint there.
    gl.uniform1f(pu.uAlpha, palette.dark ? 1 : 0.45);
  };

  const uploadCode = () => {
    const target = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (target === codeScale || !res) return;
    codeScale = target;
    const generation = res;
    const stale = () => !alive() || res !== generation;
    void buildCodeTile(target, stale, options.code, options.fontFamily).then((tile) => {
      if (!tile || stale() || !res) return;
      gl.bindTexture(gl.TEXTURE_2D, res.code);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // Mips give the shader a one-tap soft glow around the glyphs.
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    });
  };

  const resize = () => {
    const r = section.getBoundingClientRect();
    cssW = r.width;
    cssH = r.height;
    const target = Math.min(window.devicePixelRatio || 1, MAX_DPR) * quality;
    const w = Math.max(1, Math.round(cssW * target));
    const h = Math.max(1, Math.round(cssH * target));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (lens2d && (lens2d.canvas.width !== w || lens2d.canvas.height !== h)) {
      lens2d.canvas.width = w;
      lens2d.canvas.height = h;
      lensRect.w = 0;
    }
    scale = cssW > 0 ? w / cssW : target;
    gl.viewport(0, 0, w, h);
    applyStatic();
    sizeDirty = false;
  };

  // ------------------------------------------------------------ drawing
  const clearLens = () => {
    if (lens2d && lensRect.w > 0) lens2d.clearRect(lensRect.x, lensRect.y, lensRect.w, lensRect.h);
    lensRect.w = 0;
  };
  const clear = () => {
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    clearLens();
  };

  const bindTextures = (r: Resources) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.nebula);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, r.code);
  };

  /** One throwaway draw per program, so the driver finishes pipeline set-up now rather than on the first swipe. */
  const warmUp = (r: Resources) => {
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 1, 1);
    gl.useProgram(r.main);
    gl.uniform1i(r.u.uCount, 0);
    bindTextures(r);
    gl.bindVertexArray(r.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(r.particles);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(r.dots);
    gl.drawArrays(gl.POINTS, 0, 1);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    clear();
  };

  /** Union of the cut's and the motes' reach, clamped to the canvas. Allocation-free. */
  const merge = (b: Box) => {
    if (b.x0 < box.x0) box.x0 = b.x0;
    if (b.y0 < box.y0) box.y0 = b.y0;
    if (b.x1 > box.x1) box.x1 = b.x1;
    if (b.y1 > box.y1) box.y1 = b.y1;
  };
  const measureBox = () => {
    box.x0 = Infinity;
    box.y0 = Infinity;
    box.x1 = -Infinity;
    box.y1 = -Infinity;
    if (trail.hasBox) merge(trail.box);
    if (particles.count) merge(particles.box);
    const has = trail.hasBox || particles.count > 0;
    box.x0 = Math.max(0, box.x0);
    box.y0 = Math.max(0, box.y0);
    box.x1 = Math.min(cssW, box.x1);
    box.y1 = Math.min(cssH, box.y1);
    return has && box.x1 > box.x0 && box.y1 > box.y0;
  };

  const render = (now: number) => {
    if (!res) return;
    if (sizeDirty) resize();

    const cutVisible = trail.count > 1 && (trail.maxHalfWidth > 0.3 || trail.energy > 0.02);
    if (!(cutVisible || particles.count) || !measureBox()) {
      if (drewLastFrame) clear();
      drewLastFrame = false;
      return;
    }

    clear();
    const sx0 = Math.floor(box.x0 * scale);
    const sx1 = Math.ceil(box.x1 * scale);
    const sy0 = Math.floor((cssH - box.y1) * scale);
    const sy1 = Math.ceil((cssH - box.y0) * scale);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sx0, sy0, sx1 - sx0, sy1 - sy0);

    if (cutVisible) {
      const { u } = res;
      gl.useProgram(res.main);
      gl.uniform4fv(u.uPts, trail.points, 0, trail.count * 4);
      gl.uniform4fv(u.uSeg, trail.bounds, 0, trail.count * 4);
      gl.uniform1i(u.uCount, trail.count);
      gl.uniform1f(u.uTime, now / 1000);
      gl.uniform2f(u.uParallax, parX, parY);
      bindTextures(res);
      gl.bindVertexArray(res.quad);
      if (lens2d) {
        // Two layers: the lens goes to the canvas behind the content, the cut stays on this one, over it.
        gl.uniform1f(u.uPass, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const x = sx0;
        const y = canvas.height - sy1; // 2D canvases count rows from the top
        const w = sx1 - sx0;
        const h = sy1 - sy0;
        lens2d.drawImage(canvas, x, y, w, h, x, y, w, h);
        lensRect.x = x;
        lensRect.y = y;
        lensRect.w = w;
        lensRect.h = h;
        gl.clear(gl.COLOR_BUFFER_BIT); // scissored: only the box
        gl.uniform1f(u.uPass, 2);
      } else {
        gl.uniform1f(u.uPass, options.over ? 2 : 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (particles.count) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(res.particles);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.dotBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, particles.data, 0, particles.count * 5);
      gl.bindVertexArray(res.dots);
      gl.drawArrays(gl.POINTS, 0, particles.count);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    drewLastFrame = true;
  };

  const frame = (now: number) => {
    raf = 0;
    if (!res || !alive() || !visible) return;
    const dt = last ? Math.min(50, now - last) : 1000 / 60;
    last = now;

    const cutAlive = trail.update(now);
    particles.update(dt / 1000, trail);

    // The window's depth follows the cursor with a soft, frame-rate-independent ease.
    const k = 1 - Math.exp(-dt / 220);
    if (cssW > 0 && cssH > 0) {
      parX += ((cursorX / cssW) * 2 - 1 - parX) * k;
      parY += ((cursorY / cssH) * 2 - 1 - parY) * k;
    }

    render(now);
    voice(now, dt, cutAlive || particles.count > 0);

    // Adaptive quality, relative to this display's own refresh rate: sustained
    // frames well over the best recent interval step the resolution down.
    if (drewLastFrame) {
      bestDt = Math.min(bestDt + 0.02, dt);
      slowFrames = dt > Math.max(bestDt * 1.6, 12) ? slowFrames + 1 : Math.max(0, slowFrames - 1);
      if (slowFrames > 24 && quality > MIN_QUALITY) {
        quality = Math.max(MIN_QUALITY, quality - 0.2);
        slowFrames = 0;
        sizeDirty = true;
      }
    }

    if (cutAlive || particles.count) {
      raf = requestAnimationFrame(frame);
    } else {
      // Fully healed: park the loop. An idle pointer costs nothing.
      if (drewLastFrame) clear();
      drewLastFrame = false;
      last = 0;
    }
  };

  /** Feeds the sound from the same state the picture uses, so they never drift apart. */
  const voice = (now: number, dt: number, alive: boolean) => {
    if (!sound) return;
    if (!alive) {
      sound.update({ energy: 0, open: 0, pan: 0, height: 0.5, dt });
      cutting = false;
      return;
    }
    const pan = cssW > 0 ? Math.max(-1, Math.min(1, (cursorX / cssW) * 2 - 1)) : 0;
    sound.update({
      // Keeps the sound's view of the blade current; only slash() below makes a sound.
      energy: Math.max(trail.energy, 0.2 * trail.motion),
      open: Math.min(1, trail.maxHalfWidth / (0.5 * cutWidth())),
      pan,
      height: cssH > 0 ? Math.max(0, Math.min(1, cursorY / cssH)) : 0.5,
      dt,
    });
    // One slash accent as a fast stroke begins (with hysteresis, so a stroke is one slash).
    if (!cutting && trail.energy > 0.35 && now - lastSlashAt > 250) {
      // Strength from how fast the blade really moves — the energy at the moment
      // it crosses the threshold is always ≈0.4, which would make every swoosh the same.
      const strength = Math.max(0, Math.min(1, (trail.bladeSpeed - 0.8) / 3.2));
      sound.slash(strength, pan, Math.sign(trail.velocityX));
      lastSlashAt = now;
      cutting = true;
    } else if (cutting && trail.energy < 0.2) {
      cutting = false;
    }
  };

  const wake = () => {
    if (!raf && res && alive() && visible) raf = requestAnimationFrame(frame);
  };

  const sleep = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    trail.reset();
    particles.reset();
    if (res && alive()) clear();
    drewLastFrame = false;
    sound?.update({ energy: 0, open: 0, pan: 0, height: 0.5, dt: 16.7 });
    cutting = false;
  };

  // ------------------------------------------------------------ input
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !visible || !res) return;
    if (rectDirty) {
      rect = section.getBoundingClientRect();
      rectDirty = false;
    }
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      trail.lift();
      return;
    }
    // Every sample the device produced since the last event, not just the
    // last one: the cut follows the real path even on a 1000 Hz mouse.
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    if (samples.length > 0) {
      for (const s of samples) trail.sample(s.clientX - rect.left, s.clientY - rect.top, s.timeStamp);
    } else {
      trail.sample(x, y, event.timeStamp);
    }
    cursorX = x;
    cursorY = y;
    wake();
  };

  // Scrolling moves the page under a still pointer; that must not read as a cut.
  const onScroll = () => {
    rectDirty = true;
    trail.lift();
  };
  const onLeave = () => trail.lift();
  const onResize = () => {
    sizeDirty = true;
    rectDirty = true;
    uploadCode();
  };
  const onVisibility = () => {
    if (document.hidden) sleep();
  };
  const onGesture = () => {
    if (!soundOn || disposed || !options.soundUrl) return;
    sound ??= createRiftSound(options.soundUrl);
    sound?.setMuted(false);
    sound?.unlock();
  };
  const setSoundEnabled = (on: boolean) => {
    soundOn = on;
    // Called from a click handler, this is also the gesture that unlocks audio.
    if (soundOn) onGesture();
    else sound?.setMuted(true);
  };

  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(section);

  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (!visible) sleep();
  });
  intersection.observe(section);

  const themeObserver = new MutationObserver(() => {
    palette = readPalette(section);
    applyStatic();
  });
  // Theme switches usually flip a class or data attribute on <html> or on the hero itself.
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  themeObserver.observe(section, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

  // ------------------------------------------------------------ GPU lifecycle
  const setup = async () => {
    try {
      const r = await createResources(gl, alive);
      if (!r) return;
      if (!alive()) {
        release(gl, r);
        return;
      }
      res = r;
      codeScale = 0;
      resize();
      warmUp(r);
      uploadCode();
    } catch (error) {
      warn(error);
      res = null;
    }
  };

  const onContextLost = (event: Event) => {
    event.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    res = null;
    trail.reset();
    particles.reset();
  };
  const onContextRestored = () => {
    void setup();
  };

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  document.addEventListener("pointerleave", onLeave);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pointerdown", onGesture, { passive: true });
  window.addEventListener("keydown", onGesture);
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  void setup();

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pointerdown", onGesture);
    window.removeEventListener("keydown", onGesture);
    sound?.dispose();
    sound = null;
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    resizeObserver.disconnect();
    intersection.disconnect();
    themeObserver.disconnect();
    if (res && !gl.isContextLost()) {
      clear();
      release(gl, res);
    }
    res = null;
  };

  return { setSoundEnabled, destroy };
}
