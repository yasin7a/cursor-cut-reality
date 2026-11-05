export type RGB = [number, number, number];

export type Palette = {
  bg: RGB;
  fg: RGB;
  accent: RGB;
  /** Hairline core of the rift's lip. */
  rim: RGB;
  /** Warm light inside the cut and the colour of the motes it pulls in. */
  glow: RGB;
  violet: RGB;
  dark: boolean;
};

/** "220 13% 5%" (the token format in hero-rift.css) → 0..1 sRGB triple. */
function hsl(token: string, fallback: RGB): RGB {
  const parts = token.trim().split(/\s+/);
  if (parts.length < 3) return fallback;
  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;
  if ([h, s, l].some(Number.isNaN)) return fallback;

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/**
 * Reads the --rift-* tokens that are live on the hero, so the background the
 * shader rebuilds under its lens matches the CSS one pixel for pixel. Light or
 * dark is decided by the background itself — no theme class needed.
 */
export function readPalette(section: HTMLElement): Palette {
  const css = getComputedStyle(section);
  const token = (name: string, fallback: RGB) => hsl(css.getPropertyValue(name), fallback);

  const bg = token("--rift-bg", [0.04, 0.05, 0.06]);
  const dark = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 0.5;
  const accent = token("--rift-accent", [0.94, 0.87, 0.71]);
  return {
    bg,
    fg: token("--rift-fg", [0.93, 0.94, 0.95]),
    accent,
    // White-hot reads on a dark ground; on a light ground it would vanish,
    // so the lip falls back to the deeper accent there.
    rim: dark ? [1, 0.97, 0.92] : token("--rift-accent-strong", [0.8, 0.62, 0.3]),
    glow: dark ? [1, 0.74, 0.38] : accent,
    violet: [0.62, 0.34, 0.85],
    dark,
  };
}
