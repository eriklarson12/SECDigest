import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Static routes only. /analysis/[id] and /company/[ticker] are unbounded and
// user-generated, so enumerating them would mean crawling our own database.
const ROUTES = ["/", "/compare", "/history", "/watchlist"];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((route) => ({ url: `${SITE_URL}${route}` }));
}
