/** Tile size in CSS px. Height is a whole number of lines so the tile repeats seamlessly. */
export const CODE_TILE = { width: 1536, height: 1008, line: 28 };

/** What shows through the cut by default: a few lines of the rift's own source. */
export const DEFAULT_CODE = `export function createHeroRift(section: HTMLElement, options = {}) {
for (const s of event.getCoalescedEvents()) trail.sample(s.clientX, s.clientY, s.timeStamp);
float e = unevenCapsule(p, A.xy, B.xy, A.z, B.z);
vec2 push = (away * 1.3 + h.side * h.tg * .2) * width * f;
// heals shut about a second after the blade passes
const strength = Math.max(0, Math.min(1, (trail.bladeSpeed - 0.8) / 3.2));
gl.scissor(sx0, sy0, sx1 - sx0, sy1 - sy0);
c += bloom.rgb * vec3(1., .75, .45) * 1.6;
window.addEventListener("pointermove", onPointerMove, { passive: true });
sound.slash(strength, pan, Math.sign(trail.velocityX));
return { setSoundEnabled, destroy };
gl.drawArrays(gl.TRIANGLES, 0, 3);
// one oversized triangle covers the viewport`;

const TOKEN = /(\s+|[(){}[\],.;:<>="'/])/;
const KEYWORD =
  /^(export|default|async|function|const|let|await|return|new|true|false|for|of|if|else|import|from|float|vec2|vec3|vec4|type|class|while)$/;
const PUNCT = /^[(){}[\],.;:<>=/"']$/;
/** Paint for at most this long before handing the main thread back. */
const SLICE_MS = 6;

function colour(token: string, comment: boolean) {
  if (comment) return "rgba(170,140,200,0.55)";
  if (KEYWORD.test(token)) return "rgba(255,218,150,1)";
  if (/^[A-Z]/.test(token)) return "rgba(255,242,214,0.95)";
  if (PUNCT.test(token)) return "rgba(196,150,220,0.6)";
  return "rgba(236,200,130,0.62)";
}

const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Paints the code that lives "under" the page into a tiling canvas, once.
 * Every row wraps around the tile's right edge so the texture repeats in both
 * directions without a seam. Painting is split into short slices so it never
 * shows up as a long task, even on a slow machine.
 */
export async function buildCodeTile(
  scale: number,
  cancelled: () => boolean,
  code: string,
  fontFamily: string,
): Promise<HTMLCanvasElement | null> {
  const { width: W, height: H, line } = CODE_TILE;
  const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const font = `500 17px ${fontFamily ? `${fontFamily}, ` : ""}ui-monospace, monospace`;
  try {
    await document.fonts.load(font);
  } catch {
    // A fallback monospace is fine — this layer is decoration.
  }
  if (cancelled()) return null;

  ctx.scale(scale, scale);
  ctx.font = font;
  const widths = new Map<string, number>();
  const measure = (s: string) => {
    let w = widths.get(s);
    if (w === undefined) {
      w = ctx.measureText(s).width;
      widths.set(s, w);
    }
    return w;
  };
  const gap = measure(" ") * 6;
  let next = 0;
  let slice = performance.now();

  for (let row = 0; row < Math.round(H / line); row++) {
    if (performance.now() - slice > SLICE_MS) {
      await yieldToMain();
      if (cancelled()) return null;
      slice = performance.now();
    }
    const y = row * line + 20;
    let x = (row * 173) % W;
    let used = 0;
    let full = false;

    for (let segment = 0; segment < 12 && !full; segment++) {
      const text = lines[next++ % lines.length];
      const comment = text.startsWith("//") || text.startsWith("#");
      for (const token of text.split(TOKEN)) {
        if (!token) continue;
        const w = measure(token);
        if (used + w > W - 72) {
          full = true;
          break;
        }
        ctx.fillStyle = colour(token, comment);
        ctx.fillText(token, x, y);
        if (x + w > W) ctx.fillText(token, x - W, y);
        x += w;
        used += w;
        if (x >= W) x -= W;
      }
      x += gap;
      used += gap;
      if (x >= W) x -= W;
    }
  }
  return canvas;
}
