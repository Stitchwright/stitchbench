import { sessionUser } from "@/lib/session";
import { hubPicture } from "@/lib/hub";
import { imageResponse } from "@/lib/image-response";

// A marketplace listing photo from the community hub (kept locally after the first look).
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await sessionUser())) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  const p = await hubPicture("listing", id).catch(() => null);
  if (!p) return new Response("Not found", { status: 404 });
  return imageResponse(p.data, p.mime);
}
