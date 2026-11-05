import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/500.css";
import "./hero-rift/hero-rift.css";
import "./demo.css";
import { canRunHeroRift, createHeroRift } from "./hero-rift";

// ?theme=light shows the light theme (hero-rift.css reads data-theme="light").
if (new URLSearchParams(location.search).get("theme") === "light") {
  document.documentElement.dataset.theme = "light";
}

const SOUND_URL = "/sounds/rift.wav";
const STORAGE_KEY = "hero-rift-sound";

const section = document.getElementById("hero")!;
const hint = document.getElementById("hint")!;
const button = document.getElementById("sound") as HTMLButtonElement;

const readSound = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
};

// The demo draws the cut over the text; ?layer=behind shows the other mode.
const layer = new URLSearchParams(location.search).get("layer") === "behind" ? "behind" : "over";
const rift = createHeroRift(section, { sound: SOUND_URL, soundEnabled: readSound(), layer });

if (!canRunHeroRift()) {
  hint.textContent = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "The effect is off because your system asks for reduced motion"
    : "Open this on a computer with a mouse or trackpad to try it";
} else {
  // The sound file is optional (see public/sounds/README.md): only offer the toggle when it's there.
  fetch(SOUND_URL, { method: "HEAD" })
    .then((r) => r.ok && (r.headers.get("content-type") ?? "").startsWith("audio"))
    .catch(() => false)
    .then((hasSound) => {
      if (!hasSound) return;
      let on = readSound();
      const render = () => {
        button.setAttribute("aria-pressed", String(on));
        button.querySelector(".sound__label")!.textContent = on ? "Sound on" : "Sound off";
      };
      render();
      button.hidden = false;
      button.addEventListener("click", () => {
        on = !on;
        try {
          localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
        } catch {
          // storage blocked: the choice just isn't remembered
        }
        rift.setSoundEnabled(on);
        render();
      });

      // Browsers only allow audio after a click or key press, so say so once.
      if (on) {
        hint.textContent = "Click anywhere to turn on sound, then swipe fast";
        const unlocked = () => {
          hint.textContent = "Swipe fast across the page";
          window.removeEventListener("pointerdown", unlocked);
          window.removeEventListener("keydown", unlocked);
        };
        window.addEventListener("pointerdown", unlocked);
        window.addEventListener("keydown", unlocked);
      }
    });
}
