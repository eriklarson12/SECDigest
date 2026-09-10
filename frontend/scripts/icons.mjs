/**
 * Renders the PWA app icons from the same tokens as the link cards.
 *
 * The mark is an "SD" monogram, not the "SECDigest" wordmark that
 * `opengraph-image.png` carries. A 1200px card can hold nine letters; a 192px
 * launcher icon cannot, and a maskable icon crops another 20% off every edge.
 *
 * Three files, because Android and Chrome want different things from the same
 * art: two `any` icons that are used as drawn, and one `maskable` that the
 * platform clips to whatever shape it likes. The maskable variant is the same
 * monogram at 60% scale on a full bleed of paper, so a circular or squircle
 * mask never touches a letter.
 *
 * Usage: npm run icons
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { FONTS, T } from "./tokens.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const REPO = resolve(FRONTEND, "..");
const PUBLIC = resolve(FRONTEND, "public");

/** Safe zone for a maskable icon: the spec guarantees only the middle 80% of
 *  the width survives, and platforms crop a circle inside even that. */
const MASKABLE_SCALE = 0.6;

/** Rendered at the icon's exact pixel size rather than screenshotted down from
 *  one master, so the letterforms are hinted for the size they ship at. */
function monogram(size, { maskable }) {
  const inset = maskable ? Math.round(size * ((1 - MASKABLE_SCALE) / 2)) : 0;
  const box = size - inset * 2;
  return `<!doctype html><meta charset="utf-8">${FONTS}<style>
    *{ margin:0; padding:0; box-sizing:border-box; }
    body{
      width:${size}px; height:${size}px; background:${T.bg};
      display:flex; align-items:center; justify-content:center;
      -webkit-font-smoothing:antialiased;
    }
    .mark{
      width:${box}px; height:${box}px;
      display:flex; align-items:center; justify-content:center;
      font-family:"IBM Plex Sans",system-ui,sans-serif;
      font-weight:600; color:${T.primary};
      /* Sized off the safe box, not the canvas, so the maskable variant is the
         same mark smaller rather than a differently proportioned one. */
      font-size:${Math.round(box * 0.58)}px;
      letter-spacing:-0.03em;
      /* Optical centering: the cap height sits high in the line box, so a
         flex-centered pair of capitals reads low without this. */
      padding-bottom:${Math.round(box * 0.04)}px;
    }
  </style>
  <div class="mark">SD</div>`;
}

const OUT = [
  { size: 192, maskable: false, file: "icon-192.png" },
  { size: 512, maskable: false, file: "icon-512.png" },
  { size: 512, maskable: true, file: "icon-maskable-512.png" },
];

const browser = await chromium.launch();
mkdirSync(PUBLIC, { recursive: true });

for (const { size, maskable, file } of OUT) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
  });
  await page.setContent(monogram(size, { maskable }), {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(PUBLIC, file);
  await page.screenshot({ path, type: "png" });
  await page.close();
  console.log(`wrote ${path.replace(REPO + "/", "")}`);
}

await browser.close();
