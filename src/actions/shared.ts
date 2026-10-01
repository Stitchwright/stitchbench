"use server";

// Sharing a tech's photos and notes with every shop on the community hub (kept here until the hub has it).
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { str } from "@/lib/format";
import { modelHref } from "@/components/ui";
import { hubJoined, syncSoon } from "@/lib/hub";
import { requireHubWrites } from "@/lib/hub-writes";
import type { NoteKind } from "@/generated/prisma/enums";

const KINDS: NoteKind[] = ["GOTCHA", "TIP", "FACT"];

export const sharePost = safe(async function sharePost(machineId: string, formData: FormData) {
  const user = await requireUser();
  await requireHubWrites(user);
  const m = await db.machine.findFirst({ where: { id: machineId, shopId: user.shopId }, select: { brand: true, model: true, modelKey: true } });
  if (!m) throw new UserError("Machine not found.");
  const title = str(formData.get("title"));
  const body = str(formData.get("body"));
  if (!title || !body) throw new UserError("Give it a short title and write what you found.");
  // Said, not cut off: the hub keeps a title to 140 characters and a note to 5,000, and would drop the rest silently.
  if (title.length > 140) throw new UserError(`Keep the title to 140 characters (it is ${title.length}).`);
  if (body.length > 5000) throw new UserError(`A note can be up to 5,000 characters; this one is ${body.length.toLocaleString("en-US")}. Shorten it, or share it as two notes.`);
  const kind = (str(formData.get("kind")) ?? "GOTCHA") as NoteKind;
  if (!KINDS.includes(kind)) throw new UserError("Pick what kind of note this is.");
  const photoIds = formData.getAll("photoIds").map(String).slice(0, 12);
  const photos = photoIds.length
    ? await db.machinePhoto.findMany({ where: { id: { in: photoIds }, machineId, shopId: user.shopId }, select: { kind: true, caption: true, mime: true, data: true } })
    : [];
  await db.sharedPost.create({
    data: {
      shopId: user.shopId,
      authorId: user.id,
      brand: m.brand,
      model: m.model,
      modelKey: m.modelKey,
      kind,
      title,
      body,
      photos: { create: photos.map((p, i) => ({ kind: p.kind, caption: p.caption, mime: p.mime, data: p.data, sortOrder: i })) },
    },
  });
  // Send it to the community hub now (a few seconds at most; not at all while the hub is known to be down): it's saved
  // here either way, and the next sync sends it.
  if (await hubJoined()) await syncSoon();
  revalidatePath(`/machines/${machineId}`);
  revalidatePath(modelHref(m.brand, m.model));
  revalidatePath("/shared");
});

export const deleteSharedPost = safe(async function deleteSharedPost(postId: string) {
  const user = await requireUser();
  const p = await db.sharedPost.findUnique({ where: { id: postId }, select: { shopId: true, authorId: true, brand: true, model: true } });
  if (!p) throw new UserError("Already removed.");
  const own = p.shopId === user.shopId && (p.authorId === user.id || user.role !== "TECH");
  if (!own && !isPlatformAdmin(user.email)) throw new UserError("Only the tech who shared it, their shop's owner, or the StitchBench admin can remove it.");
  await db.sharedPost.delete({ where: { id: postId } });
  revalidatePath(modelHref(p.brand, p.model));
  revalidatePath("/shared");
});
