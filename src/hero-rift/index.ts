import { DEFAULT_CODE } from "./codeTexture";
import type { RiftController } from "./engine";

export type HeroRiftOptions = {
  /** Text shown inside the cut. Defaults to a few lines of the rift's own source. */
  code?: string;
  /** URL of a short slash sample (wav/mp3/ogg). Leave it out for a silent rift. */
  sound?: string;
  /** Start with the sound on. Default true. (Audio still waits for one click or key press — a browser rule.) */
  soundEnabled?: boolean;
  /**
   * "behind" (default): the whole effect sits under the hero's content.
   * "over": the cut is drawn on top of the hero's content (text, buttons), while
   * the grid bending around it stays behind the content so text stays sharp.
   * Clicks pass through either way.
   */
  layer?: "behind" | "over";
};

export type HeroRift = {
  /** False on touch-only devices, with reduced motion, or without WebGL2: the static grid stays. */
  readonly active: boolean;
  setSoundEnabled(on: boolean): void;
  /** Stops the effect and removes everything it added to the section. */
  destroy(): void;
};

/** Whether this device gets the effect: a fine pointer (mouse/trackpad) and no reduced-motion preference. */
export function canRunHeroRift(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: fine)").matches && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const layer = (tag: "div" | "canvas", className: string) => {
  const el = document.createElement(tag);
  el.className = className;
  el.setAttribute("aria-hidden", "true");
  return el;
};

/**
 * Turns `section` into a hero you can cut open: a fast swipe slices the
 * background, the grid lenses around the cut, and code glows inside it over
 * deep space. It heals about a second after the blade passes.
 *
 * Progressive enhancement: the grid and light layers are plain CSS and show
 * everywhere; the WebGL engine is a separate chunk that is only fetched for
 * fine pointers without reduced motion, once the browser is idle, so it never
 * competes with the page's first paint.
 */
export function createHeroRift(section: HTMLElement, options: HeroRiftOptions = {}): HeroRift {
  const over = options.layer === "over";
  section.classList.add("hero-rift");
  if (over) section.classList.add("hero-rift--over");
  const grid = layer("div", "hero-rift__grid");
  const atmosphere = layer("div", "hero-rift__atmosphere");
  // In "over" mode the grid bending gets its own canvas in the background slot.
  const lens = over ? (layer("canvas", "hero-rift__lens") as HTMLCanvasElement) : null;
  const canvas = layer("canvas", "hero-rift__canvas") as HTMLCanvasElement;
  section.prepend(...(lens ? [grid, atmosphere, lens, canvas] : [grid, atmosphere, canvas]));

  const fine = window.matchMedia("(pointer: fine)");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let engine: RiftController | null = null;
  let soundEnabled = options.soundEnabled ?? true;
  let destroyed = false;
  let loading = false;
  let idle = 0;
  let timer = 0;

  const start = () => {
    if (engine || loading || destroyed || !canRunHeroRift()) return;
    loading = true;
    import("./engine")
      .then(({ createRiftEngine }) => {
        if (destroyed || engine) return;
        const mono = getComputedStyle(section).getPropertyValue("--rift-font-mono").trim();
        engine = createRiftEngine(canvas, section, {
          code: options.code ?? DEFAULT_CODE,
          fontFamily: mono,
          soundUrl: options.sound ?? null,
          soundEnabled,
          over,
          lensCanvas: lens,
        });
      })
      .catch((error) => console.warn("hero-rift: engine failed to load", error))
      .finally(() => {
        loading = false;
      });
  };

  const stop = () => {
    engine?.destroy();
    engine = null;
  };

  const onPreferenceChange = () => (canRunHeroRift() ? start() : stop());

  if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(start, { timeout: 2000 });
  else timer = window.setTimeout(start, 500);
  fine.addEventListener("change", onPreferenceChange);
  reduced.addEventListener("change", onPreferenceChange);

  return {
    get active() {
      return engine !== null;
    },
    setSoundEnabled(on: boolean) {
      soundEnabled = on;
      engine?.setSoundEnabled(on);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (idle) window.cancelIdleCallback(idle);
      if (timer) window.clearTimeout(timer);
      fine.removeEventListener("change", onPreferenceChange);
      reduced.removeEventListener("change", onPreferenceChange);
      stop();
      grid.remove();
      atmosphere.remove();
      lens?.remove();
      canvas.remove();
      section.classList.remove("hero-rift", "hero-rift--over");
    },
  };
}
