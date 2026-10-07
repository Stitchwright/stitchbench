// A tech's browser drew a figure from its local manual; keep a copy so phones can see it too.
import { db } from "@/lib/db";
import { isInstallAdmin, sessionUser } from "@/lib/session";
import { figureId } from "@/lib/figures";
import { shareFigure } from "@/lib/hub";
import { formUpTo } from "@/lib/read-body";

/** Whether the signed-in person may replace a stored figure (the figure's Redraw button asks). */
export async function GET() {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  return Response.json({ canReplace: await isInstallAdmin(user) });
}

export async function POST(req: Request) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  // Counted as it arrives: a chunked upload has no Content-Length to refuse it by.
  const form = await formUpTo(req, 2_000_000);
  if (form === "too large") return new Response("Figure too large.", { status: 413 });
  if (!form) return new Response("Missing figure.", { status: 400 });
  const sourcePath = String(form.get("sourcePath") ?? "");
  const page = Number(form.get("page"));
  let box: unknown = [];
  try {
    box = JSON.parse(String(form.get("box") ?? "[]"));
  } catch {
    return new Response("Bad box.", { status: 400 });
  }
  if (!Array.isArray(box) || (box.length !== 0 && box.length !== 4) || !box.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return new Response("Bad box.", { status: 400 });
  }
  const file = form.get("file");
  if (!sourcePath || !Number.isInteger(page) || !(file instanceof Blob) || file.type !== "image/jpeg") {
    return new Response("Missing figure.", { status: 400 });
  }
  if (file.size > 1_500_000) return new Response("Figure too large.", { status: 413 });
  // Only the exact figure a known factory setting or test mode shows is stored (same manual, page and box).
  const id = figureId(sourcePath, page, box);
  const known = await Promise.all([
    db.factorySetting.findMany({ where: { sourcePath, figurePage: page }, select: { figureBox: true } }),
    db.serviceMode.findMany({ where: { sourcePath, figurePage: page }, select: { figureBox: true } }),
  ]);
  if (!known.flat().some((s) => figureId(sourcePath, page, s.figureBox) === id)) return new Response("Unknown figure.", { status: 404 });
  const width = Number(form.get("width")) || 0;
  const height = Number(form.get("height")) || 0;
  const data = new Uint8Array(await file.arrayBuffer());
  if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return new Response("Not a JPEG.", { status: 415 });
  // Figures are shared by every company on this install: the first copy is kept, and only whoever runs the install
  // (its administrator, or the owner or admin when it has one company) can replace a wrong one.
  const replace = await isInstallAdmin(user);
  await db.figureImage.upsert({
    where: { id },
    create: { id, sourcePath, page, box, width, height, mime: "image/jpeg", data },
    update: replace ? { width, height, data } : {},
  });
  // Offer it to the community hub too, so shops without this manual can see the figure.
  shareFigure(id, "image/jpeg", data, width, height).catch(() => {});
  return Response.json({ id, replaced: replace });
}
