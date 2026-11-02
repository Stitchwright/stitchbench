// A design file on a decorating order (docs/plans/decorators-proposal.md): the signed-in company's own order only, as a
// download. The customer's file is theirs: never shown inline.
import { sessionUser } from "@/lib/session";
import { headerFileName } from "@/lib/download-name";
import { placementFile } from "@/lib/decor";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const f = await placementFile(user.shopId, id);
  if (!f) return new Response("The file isn't here.", { status: 404 });
  const name = headerFileName(f.name);
  return new Response(Buffer.from(f.data), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
