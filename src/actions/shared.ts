"use server";

// Offering a hint about a model (a tech's photos and notes) to every shop on the community hub (kept here until the
// hub has it). The body is in src/lib/offer.ts: brand and model, kind, title, body and the ticked photos go; nothing
// of the customer, the serial or the ticket does.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, UserError } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { isPlatformAdmin } from "@/lib/shops";
import { modelHref } from "@/components/ui";
import { hubJoined, syncSoon } from "@/lib/hub";
import { offerHintAs } from "@/lib/offer";
import { assertId } from "@/lib/input";

export const sharePost = safe(async function sharePost(machineId: string, formData: FormData) {
  assertId(machineId);
  const user = await requireUser();
  const id = await offerHintAs(user, machineId, formData);
  const m = await db.sharedPost.findUniqueOrThrow({ where: { id }, select: { brand: true, model: true } });
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
