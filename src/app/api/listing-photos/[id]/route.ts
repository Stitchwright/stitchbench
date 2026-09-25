import { auth } from "@/auth";
import { hubPicture } from "@/lib/hub";

// A marketplace listing photo from the community hub (kept locally after the first look).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await auth())?.user) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await hubPicture("listing", id).catch(() => null);
  if (!p) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(p.data), {
    headers: { "Content-Type": p.mime, "Cache-Control": "private, max-age=31536000, immutable" },
  });
}
