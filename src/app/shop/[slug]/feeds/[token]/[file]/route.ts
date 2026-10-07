// The product feeds Google and Meta fetch (shop-features-round-2-design.md 4.1, 4.2): /shop/{slug}/feeds/{token}/google.xml,
// local.tsv and meta.csv. The secret in the path is the shop's; rate limited per address and per shop. Not found when
// anything is wrong or the feeds are off. Bodies in src/lib/shop/feeds.ts.
import { allow, allowPublic } from "@/lib/rate-limit";
import { feedFile } from "@/lib/shop/feeds";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

export async function GET(req: Request, { params }: { params: Promise<{ slug: string; token: string; file: string }> }) {
  const { slug, token, file } = await params;
  if (!allowPublic(req, "shop-feed", 30, 10 * 60_000) || !allow(`shop-feed:${slug}`, 120, 60 * 60_000)) {
    return new Response("Too many requests.", { status: 429, headers: HEADERS });
  }
  const f = await feedFile(slug, token, file);
  if (!f) return new Response("Not found", { status: 404, headers: HEADERS });
  return new Response(f.body, { status: 200, headers: { ...HEADERS, "Content-Type": f.type } });
}
