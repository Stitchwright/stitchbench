// A co-op claim's proof (shop-features-round-2-design.md 9.2): the signed-in company's own only. Photos show in the page;
// a PDF opens in the browser.
import { sessionUser } from "@/lib/session";
import { coopProof } from "@/lib/coop-claims";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const f = await coopProof(user.shopId, id);
  if (!f) return new Response("Not found.", { status: 404 });
  const name = f.name.replace(/["\\r\n]/g, "_");
  return new Response(Buffer.from(f.data), {
    headers: {
      "Content-Type": /^image\/(jpeg|png|webp)$|^application\/pdf$/.test(f.mime) ? f.mime : "application/octet-stream",
      "Content-Disposition": `inline; filename="${name}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      "Cache-Control": "private, no-store",
    },
  });
}
