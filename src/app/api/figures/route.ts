// A tech's browser drew a figure from its local manual; keep a copy so phones can see it too.
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { figureId } from "@/lib/figures";

export async function POST(req: Request) {
  if (!(await auth())?.user) return new Response("Sign in first.", { status: 401 });
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
  await db.figureImage.upsert({
    where: { id },
    create: { id, sourcePath, page, box, width, height, mime: "image/jpeg", data: new Uint8Array(await file.arrayBuffer()) },
    update: {},
  });
  return Response.json({ id });
}
