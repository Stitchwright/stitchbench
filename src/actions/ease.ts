"use server";
// "What's new", "Getting started" and the answers in Help (ease-of-use-design.md 2 to 4). Small writes about the person's
// own screen, so they work while the program is read-only.
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { parseTextSize, TEXT_SIZE_COOKIE } from "@/lib/text-size";
import { safe } from "@/lib/action";
import { db } from "@/lib/db";
import { requireAdmin, requireUser } from "@/lib/session";
import { currentWhatsNewVersion } from "@/lib/ease";

/** "Got it": this person has seen the news up to the version the program is at. */
export const dismissWhatsNew = safe.whileLapsed("dismissWhatsNew")(async function dismissWhatsNew() {
  const user = await requireUser();
  const v = currentWhatsNewVersion();
  if (v) await db.user.update({ where: { id: user.id }, data: { whatsNewSeen: v } });
  revalidatePath("/");
  revalidatePath("/register");
});

/** "Hide this list": the shop's setup list goes away (owners and admins). */
export const hideGettingStarted = safe.whileLapsed("hideGettingStarted")(async function hideGettingStarted() {
  const user = await requireAdmin();
  await db.shop.update({ where: { id: user.shopId }, data: { gettingStartedHiddenAt: new Date() } });
  revalidatePath("/");
  revalidatePath("/register");
});

/** The Help panel was opened: the answers shown there count as read. */
export const markHelpRepliesRead = safe.whileLapsed("markHelpRepliesRead")(async function markHelpRepliesRead() {
  const user = await requireUser();
  await db.helpReply.updateMany({ where: { shopId: user.shopId, readAt: null }, data: { readAt: new Date() } });
});

/** "Text size": Normal, Large or Larger for this person; the device remembers it for the sign-in page. */
export const setTextSize = safe.whileLapsed("setTextSize")(async function setTextSize(size: string) {
  const user = await requireUser();
  const s = parseTextSize(size);
  await db.user.update({ where: { id: user.id }, data: { textSize: s } });
  (await cookies()).set(TEXT_SIZE_COOKIE, s, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true });
  revalidatePath("/", "layout");
});
