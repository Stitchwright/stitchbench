import "server-only";
// Thread match from a phone photo (shop-features-round-2-design.md 9.10, package thread-photo; an Assistant photo
// feature, "Fabric and thread helpers" switch). A photo of her thread or fabric (shrunk in the browser) goes through the
// hub's Assistant proxy; the model reads the main colors off it (never a maker or number), and the program ranks the
// shop's own threads with a swatch color against each: "Pull these and check against the swatch card". Counts one call.
// Nothing is saved. Every query filters by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { requireOn } from "@/lib/module-gate";
import { runAssistant } from "@/lib/assistant/client";
import { buildThreadPhoto, parseThreadColors, type PhotoColor } from "@/lib/assistant/prompts";
import { FIRST_PHOTO, viewItem, type RegisterItem } from "@/lib/register-item";
import { closeness, rankByColor } from "@/lib/thread-photo-math";
import type { CurrentUser } from "@/lib/session";

export type ThreadMatch = { color: PhotoColor; hits: (RegisterItem & { distance: number; closeness: string; location: string | null })[] };

const photoOf = (data: string, mediaType: string) => {
  const type = mediaType === "image/png" || mediaType === "image/webp" ? mediaType : "image/jpeg";
  const photo = { mediaType: type, data: String(data ?? "").replace(/^data:[^,]*,/, "") } as const;
  if (!/^[A-Za-z0-9+/=]{100,}$/.test(photo.data)) throw new UserError("Take the photo again: it didn't come through.");
  return photo;
};

/** The shop's threads that can be matched by color: those with a swatch color (Part.colorHex). */
async function threadsOf(shopId: string) {
  return db.part.findMany({ where: { shopId, colorHex: { not: null }, OR: [{ itemType: "thread" }, { kind: "THREAD" }] }, include: FIRST_PHOTO, take: 6000 });
}

export async function threadMatchFor(user: Pick<CurrentUser, "id" | "shopId">, data: string, mediaType: string): Promise<{ matches: ThreadMatch[]; unmatched: number }> {
  await requireOn(user as CurrentUser, "assistant");
  const photo = photoOf(data, mediaType);
  const threads = await threadsOf(user.shopId);
  if (!threads.length) throw new UserError("None of your threads has a swatch color yet: give them one on their pages (Details), then try again.");
  const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildThreadPhoto(), photo });
  const colors = parseThreadColors(text);
  if (!colors) throw new UserError("The Assistant couldn't read the colors from that photo. Take it again in daylight, closer, or use Find a color.");
  const unmatched = await db.part.count({ where: { shopId: user.shopId, colorHex: null, OR: [{ itemType: "thread" }, { kind: "THREAD" }] } });
  return {
    unmatched,
    matches: colors.map((color) => ({
      color,
      hits: rankByColor(color.hex, threads).map((p) => ({ ...viewItem(p), distance: Math.round(p.distance * 10) / 10, closeness: closeness(p.distance), location: p.location })),
    })),
  };
}
