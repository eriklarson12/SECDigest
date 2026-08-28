import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/lib/site";

describe("sitemap", () => {
  it("lists exactly the four static routes", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual([
      `${SITE_URL}/`,
      `${SITE_URL}/compare`,
      `${SITE_URL}/history`,
      `${SITE_URL}/watchlist`,
    ]);
  });

  it("omits the unbounded user-generated routes", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls.some((url) => url.includes("/analysis/"))).toBe(false);
    expect(urls.some((url) => url.includes("/company/"))).toBe(false);
  });

  it("emits absolute URLs", () => {
    for (const entry of sitemap()) {
      expect(() => new URL(entry.url)).not.toThrow();
    }
  });
});

describe("robots", () => {
  it("allows every crawler and points at the sitemap", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: `${SITE_URL}/sitemap.xml`,
    });
  });
});

describe("SITE_URL", () => {
  it("falls back to localhost when NEXT_PUBLIC_SITE_URL is unset", () => {
    expect(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").toBe(
      SITE_URL,
    );
  });
});
