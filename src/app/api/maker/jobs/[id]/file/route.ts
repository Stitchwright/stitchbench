// A print or cut job's file (shop-features-round-2-design.md 6.5): the signed-in company's own job only, while the file is
// kept (30 days after pickup), as a download. The customer's file is theirs: never shown inline.
import { sessionUser } from "@/lib/session";
import { jobFile } from "@/lib/make-jobs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const f = await jobFile(user.shopId, id);
  if (!f) return new Response("The file isn't here any more.", { status: 404 });
  const name = f.name.replace(/["\\\r\n]/g, "_");
  return new Response(Buffer.from(f.data), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
