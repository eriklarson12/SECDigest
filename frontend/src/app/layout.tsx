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
        <NavBar />
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
