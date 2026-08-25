import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import NavBar from "@/components/NavBar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "AI-powered SEC filing analysis — exact XBRL financials, risk drift, plain-English summaries.";

export const metadata: Metadata = {
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
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-dvh bg-bg text-text antialiased`}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface-2 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Skip to content
        </a>
        <NavBar />
        {/* tabIndex -1 so the skip link moves focus, not just the scroll position */}
        <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
