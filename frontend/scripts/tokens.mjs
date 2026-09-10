/** Design tokens, mirroring `src/app/globals.css` @theme.
 *
 * Kept in sync by hand: these scripts are not compiled by Tailwind, so they
 * cannot read the tokens directly. Shared by `cards.mjs` and `icons.mjs` so the
 * link cards and the app icons cannot drift into two different reds.
 */
export const T = {
  bg: "#F7F2E6",
  surface: "#F1EAD9",
  border: "#D3C9B2",
  text: "#1B1B1A",
  muted: "#4A443E",
  primary: "#A6300E",
  accent: "#3E4A5C",
};

/** Both scripts render display type, and a fallback face would change the
 *  metrics the layouts were tuned against. */
export const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">`;
