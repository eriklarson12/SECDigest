/**
 * Renders the shared-link cards from one design source.
 *
 * Two cards, same brand: `opengraph-image.png` (link unfurls + the README hero)
 * and `linkedin-featured.png` (uploaded to LinkedIn by hand). They live here
 * together because they share a wordmark, palette, and type scale — splitting
 * them across two mechanisms is how the old pair drifted apart.
 *
 * Stats are counted at render time, never typed in. The card this replaced
 * claimed 272 tests when the suite held 504.
 *
 * Usage: npm run cards
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const REPO = resolve(FRONTEND, "..");

const WIDTH = 1200;
const HEIGHT = 630;
// Renders at 2x so display type stays crisp; unfurlers key on aspect ratio.
const SCALE = 2;

/** Tokens mirror `src/app/globals.css` @theme. Kept in sync by hand — this file
 *  is not compiled by Tailwind, so it cannot read the tokens directly. */
const T = {
  bg: "#F7F2E6",
  surface: "#F1EAD9",
  border: "#D3C9B2",
  text: "#1B1B1A",
  muted: "#4A443E",
  primary: "#A6300E",
  accent: "#3E4A5C",
};

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** A stat card that silently prints a stale number is worse than one that fails
 *  to build, so every counter throws rather than falling back to a literal. */
function countTests() {
  const py = resolve(REPO, "backend/.venv/bin/python");
  const backendOut = sh(
    py,
    ["-m", "pytest", "--collect-only", "-q"],
    resolve(REPO, "backend"),
  );
  const backend = Number(backendOut.match(/(\d+) tests? collected/)?.[1]);

  const unitOut = sh("npx", ["vitest", "list", "--json"], FRONTEND);
  const unit = JSON.parse(unitOut.slice(unitOut.indexOf("["))).length;

  const e2eOut = sh("npx", ["playwright", "test", "--list"], FRONTEND);
  const e2e = Number(e2eOut.match(/Total: (\d+) tests?/)?.[1]);

  for (const [label, n] of [
    ["backend", backend],
    ["unit", unit],
    ["e2e", e2e],
  ]) {
    if (!Number.isFinite(n) || n === 0) {
      throw new Error(
        `could not count ${label} tests — refusing to print a stale figure`,
      );
    }
  }
  return backend + unit + e2e;
}

/** The filing truncation cap, read from the backend env sample so the card and
 *  the code cannot disagree. */
function filingTokens() {
  const env = readFileSync(resolve(REPO, "backend/.env.example"), "utf8");
  const chars = Number(env.match(/^MAX_FILING_CHARS=(\d+)/m)?.[1]);
  if (!Number.isFinite(chars))
    throw new Error("MAX_FILING_CHARS not found in backend/.env.example");
  // 4 chars/token — the ratio backend/.env.example and docs/decisions.md both
  // quote. (embeddings.py paces on a stricter 1.8 for token-dense prose; that
  // governs the pacer, not this headline figure.)
  return Math.round(chars / 4 / 1000);
}

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">`;

const BASE = `
  *{ margin:0; padding:0; box-sizing:border-box; }
  body{
    width:${WIDTH}px; height:${HEIGHT}px; background:${T.bg}; color:${T.text};
    font-family:"Source Serif 4",Georgia,serif; -webkit-font-smoothing:antialiased;
    display:flex; flex-direction:column; padding:56px 64px;
  }
  .sans{ font-family:"IBM Plex Sans",system-ui,sans-serif; font-variant-numeric:tabular-nums; }
  .head{ display:flex; align-items:baseline; justify-content:space-between; }
  .mark{ font-size:52px; font-weight:600; letter-spacing:-0.01em; }
  .domain{ font-size:19px; color:${T.muted}; letter-spacing:0.04em; }
  .rule{ height:1px; background:${T.text}; margin-top:18px; }
  /* Radius 0 and a 1px rule for elevation — no shadows anywhere. */
  .box{ border:1px solid ${T.border}; border-radius:0; }
`;

/** Echoes the real trend chart: one slate line, red endpoint dot, faint baseline. */
function sparkline(w, h) {
  const pts = [0.3, 0.38, 0.34, 0.52, 0.47, 0.63, 0.72, 0.68, 0.88];
  const r = 5;
  // Inset the plot so the endpoint dot lands inside the viewBox rather than
  // half-clipped on the right edge.
  const x0 = r;
  const x1 = w - r;
  const y = (p) => r + (1 - p) * (h - 2 * r);
  const step = (x1 - x0) / (pts.length - 1);
  const d = pts
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${(x0 + i * step).toFixed(1)},${y(p).toFixed(1)}`,
    )
    .join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">
    <line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="${T.border}" stroke-width="1"/>
    <path d="${d}" stroke="${T.accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x1}" cy="${y(pts.at(-1))}" r="${r}" fill="${T.primary}"/>
  </svg>`;
}

function ogCard() {
  return `<!doctype html><meta charset="utf-8">${FONTS}<style>${BASE}
    /* Sized to fill the middle: an unfurl renders small, and a card that is
       mostly bare paper at 400px wide reads as a broken image. */
    .tag{ font-size:53px; line-height:1.28; margin-top:40px; max-width:17ch; }
    .kicker{ font-size:17px; letter-spacing:0.09em; text-transform:uppercase;
             color:${T.muted}; font-weight:500; }
    .foot{ margin-top:auto; display:flex; align-items:flex-end; justify-content:space-between; }
  </style>
  <div class="head">
    <div class="mark">SECDigest</div>
    <div class="domain sans">secdigest.tech</div>
  </div>
  <div class="rule"></div>
  <div class="tag">SEC filings, read down to the numbers that moved.</div>
  <div class="foot">
    <div class="kicker sans">Exact XBRL &middot; Risk drift &middot; Plain-English summaries</div>
    ${sparkline(300, 84)}
  </div>`;
}

function linkedInCard({ tests, tokens }) {
  const pipeline = [
    "10-K / 10-Q",
    "Section targeting",
    "XBRL financials",
    "pgvector index",
    "RAG answers",
  ];
  const stats = [
    [tests.toLocaleString(), "automated tests"],
    [`${tokens}K`, "token filing cap"],
    ["$0", "out of pocket"],
  ];
  const stack = [
    "Python",
    "FastAPI",
    "Next.js",
    "PostgreSQL",
    "pgvector",
    "Gemini",
  ];

  return `<!doctype html><meta charset="utf-8">${FONTS}<style>${BASE}
    body{ padding:48px 60px; }
    .mark{ font-size:44px; }
    .tag{ font-size:28px; margin-top:34px; color:${T.text}; }
    .flow{ display:flex; align-items:center; gap:11px; margin-top:40px; }
    .step{ padding:11px 16px; font-size:16px; font-weight:500; color:${T.text}; background:${T.surface}; }
    .arrow{ color:${T.muted}; font-size:17px; }
    .stats{ display:grid; grid-template-columns:repeat(3,1fr); gap:18px; margin-top:40px; }
    .stat{ padding:26px 24px; }
    /* Numerals are Plex Sans + tabular-nums, never the serif. */
    .figure{ font-size:54px; font-weight:600; letter-spacing:-0.02em; line-height:1; }
    .label{ font-size:16px; color:${T.muted}; margin-top:11px; }
    .stack{ display:flex; gap:9px; margin-top:40px; }
    .pill{ padding:9px 14px; font-size:15px; color:${T.muted}; }
    .note{ margin-top:auto; padding-top:20px; font-size:15px; color:${T.muted}; }
  </style>
  <div class="head">
    <div class="mark">SECDigest</div>
    <div class="domain sans">secdigest.tech</div>
  </div>
  <div class="rule"></div>
  <div class="tag">SEC filings &rarr; structured financials + answers from the filing text</div>
  <div class="flow">
    ${pipeline.map((s) => `<div class="step box sans">${s}</div>`).join('<div class="arrow sans">&rarr;</div>')}
  </div>
  <div class="stats">
    ${stats.map(([f, l]) => `<div class="stat box"><div class="figure sans">${f}</div><div class="label sans">${l}</div></div>`).join("")}
  </div>
  <div class="stack">${stack.map((s) => `<div class="pill box sans">${s}</div>`).join("")}</div>
  <div class="note sans">Rolling-window pacer for 30K tokens/min &middot; halt-not-retry at 1,000 requests/day</div>`;
}

// The OG card is a project asset and always renders. The LinkedIn card is a
// personal upload that lives outside the repo, so its destination comes from
// LINKEDIN_CARD_OUT — this file is public, and a home directory does not belong
// hard-coded in it.
const OUT = [
  { html: ogCard, path: resolve(FRONTEND, "src/app/opengraph-image.png") },
];

if (process.env.LINKEDIN_CARD_OUT) {
  OUT.push({
    html: linkedInCard,
    path: resolve(process.env.LINKEDIN_CARD_OUT),
  });
} else {
  console.log("LINKEDIN_CARD_OUT unset - skipping the LinkedIn card");
}

const tests = countTests();
const tokens = filingTokens();
console.log(`counted ${tests} tests · ${tokens}K token filing cap`);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: SCALE,
});

for (const { html, path } of OUT) {
  await page.setContent(html({ tests, tokens }), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, type: "png" });
  console.log(`wrote ${path.replace(REPO + "/", "")}`);
}

await browser.close();
