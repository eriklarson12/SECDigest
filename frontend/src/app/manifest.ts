import type { MetadataRoute } from "next";

/** Served at /manifest.webmanifest and linked by Next automatically -- the
 *  layout does not declare it.
 *
 *  Colours are the paper palette from globals.css, not the `#0B0F1A` the
 *  roadmap entry names: that is from the retired dark design. `theme_color`
 *  tints the Android status bar, so it matches the page background rather than
 *  the primary red, which would read as a permanent alert bar. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SECDigest",
    short_name: "SECDigest",
    description:
      "AI-powered SEC filing analysis: exact XBRL financials, risk drift, plain-English summaries.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f2e6",
    theme_color: "#f7f2e6",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      // Android clips this one to its own shape. `scripts/icons.mjs` insets the
      // monogram to a 60% safe zone so no mask ever crosses a letter.
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
