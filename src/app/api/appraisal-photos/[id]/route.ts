// A quilt appraisal's photo (shop-features-round-2-design.md 9.8): the signed-in company's own only.
import { sessionUser } from "@/lib/session";
import { appraisalPhoto } from "@/lib/appraisals";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await appraisalPhoto(user.shopId, id);
  if (!p) return new Response("Not found.", { status: 404 });
  return new Response(Buffer.from(p.data), { headers: { "Content-Type": p.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } });
}
