import "server-only";
// Pasting a license key in Settings -> Modules (modules-design.md section 7). The action wrapper is src/actions/licenses.ts.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { extractKey, windows } from "@/lib/license";
import { fmtYmd } from "@/lib/module-info";
import { loadModules, verifyFor } from "@/lib/modules";

const NOT_A_KEY = "That doesn't look like a StitchBench license key. Copy the whole key: it starts with SB1.";

export async function activateLicenseFor(user: CurrentUser, fd: FormData) {
  const key = extractKey(String(fd.get("key") ?? ""));
  if (!key) throw new UserError(NOT_A_KEY);
  const v = verifyFor(key, "pasted");
  if (!v.ok) throw new UserError(v.reason);
  const p = v.payload;
  if (p.s !== user.shopId) {
    throw new UserError(`This key is for another company (Company ID ${p.s}). Check that you're signed in to the right company, or ask for a key for Company ID ${user.shopId}.`);
  }
  if (await db.license.findFirst({ where: { shopId: user.shopId, keyId: p.id }, select: { id: true } })) throw new UserError("That key is already added.");
  // Already past its grace for every module at the effective time: nothing it could switch on.
  const [shop, mods] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { timeZone: true } }), loadModules(user.shopId)]);
  const ws = windows(p, shop.timeZone, "key");
  if (ws.length && ws.every((w) => mods.now >= w.graceUntil)) throw new UserError(`This key ended on ${fmtYmd(p.u)}. Ask for your renewal key.`);
  await db.license.create({ data: { shopId: user.shopId, keyId: p.id, key, addedBy: user.name, addedById: user.id } });
  revalidatePath("/", "layout");
}
