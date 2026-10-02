// A listed item's photo for the public shop page (online-and-parts-design.md section 3): served only while the item
// is listed and the shop's page is on; cached by the browser like other photos.
import { imageResponse } from "@/lib/image-response";
import { allowPublic } from "@/lib/rate-limit";
import { publicPhoto } from "@/lib/shop/online-shop";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!allowPublic(req, "shop-photo", 600, 60_000)) return new Response("Too many requests.", { status: 429 });
  const { id } = await ctx.params;
  const p = await publicPhoto(id);
  if (!p) return new Response("Not found", { status: 404 });
  return imageResponse(p.data, p.mime, "public, max-age=3600");
}
