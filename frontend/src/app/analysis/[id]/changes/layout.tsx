import type { Metadata } from "next";

export const metadata: Metadata = { title: "What changed" };

export default function ChangesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
