import type { Metadata } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import NavBar from "@/components/NavBar";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

// Labels, nav, tables, and every numeral. Serif figures vary in height and
// misalign a column of money.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const DESCRIPTION =
  "AI-powered SEC filing analysis — exact XBRL financials, risk drift, plain-English summaries.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "SECDigest", template: "%s · SECDigest" },
  description: DESCRIPTION,
  openGraph: {
    title: "SECDigest",
    description: DESCRIPTION,
    siteName: "SECDigest",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "SECDigest" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "SECDigest",
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${sourceSerif.variable} ${plexSans.variable} min-h-dvh bg-bg text-text antialiased`}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-border focus:bg-surface-2 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Skip to content
        </a>
        <NavBar />
        {/* tabIndex -1 so the skip link moves focus, not just the scroll position */}
        <main id="main" tabIndex={-1} className="mx-auto max-w-4xl px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
