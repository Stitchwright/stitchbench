// A tech's browser drew a figure from its local manual; keep a copy so phones can see it too.
import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { figureId } from "@/lib/figures";
import { shareFigure } from "@/lib/hub";

export async function POST(req: Request) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (Number(req.headers.get("content-length") ?? 0) > 2_000_000) return new Response("Figure too large.", { status: 413 });
  const form = await req.formData();
  const sourcePath = String(form.get("sourcePath") ?? "");
  const page = Number(form.get("page"));
  let box: number[] = [];
  try {
    box = JSON.parse(String(form.get("box") ?? "[]"));
  } catch {
    return new Response("Bad box.", { status: 400 });
  }
  const file = form.get("file");
  if (!sourcePath || !Number.isInteger(page) || !(file instanceof Blob) || file.type !== "image/jpeg") {
    return new Response("Missing figure.", { status: 400 });
  }
  if (file.size > 1_500_000) return new Response("Figure too large.", { status: 413 });
  // Only figures that belong to a known factory setting are stored.
  const known = await db.factorySetting.findFirst({ where: { sourcePath, figurePage: page }, select: { id: true } });
  if (!known) return new Response("Unknown figure.", { status: 404 });
  const id = figureId(sourcePath, page, box);
  const width = Number(form.get("width")) || 0;
  const height = Number(form.get("height")) || 0;
  const data = new Uint8Array(await file.arrayBuffer());
  // The first copy of a figure is kept; an owner or admin drawing it again from the manual replaces a wrong one.
  await db.figureImage.upsert({
    where: { id },
    create: { id, sourcePath, page, box, width, height, mime: "image/jpeg", data },
    update: user.role === "TECH" ? {} : { width, height, data },
  });
  // Offer it to the community hub too, so shops without this manual can see the figure.
  shareFigure(id, "image/jpeg", data, width, height).catch(() => {});
  return Response.json({ id });
}
