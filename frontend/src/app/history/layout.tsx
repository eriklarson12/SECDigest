import type { Metadata } from "next";

export const metadata: Metadata = { title: "All analyses" };

export default function HistoryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
