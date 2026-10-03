import "server-only";
// The StitchBench administrator's switch on Companies (modules-design.md section 8). Wrappers: src/actions/companies.ts.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { adminPosition, NO_END, planLastDay, validYmd, verifyLicense } from "@/lib/license";
import { LICENSE_PUBLIC_KEYS } from "@/lib/license-keys";
import { hostedSigner, signGrant } from "@/lib/license-signing";
import { isModuleId } from "@/lib/module-info";
import { isDesktop } from "@/lib/modules";
import { addDaysYmd } from "@/lib/license";
import { str } from "@/lib/format";
import { todayIn } from "@/lib/time-zone";

export const NO_HOSTING_KEY = "This server has no hosting key (LICENSE_HOSTED_KEY), so it can't switch modules on. Send the company a license key instead. Turning off still works.";

export async function setCompanyModuleFor(admin: CurrentUser, fd: FormData) {
  if (isDesktop()) throw new UserError("Switch modules on from the hosted StitchBench.");
  const shopId = str(fd.get("shopId"));
  const shop = shopId ? await db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, timeZone: true } }) : null;
  if (!shop) throw new UserError("Company not found.");
  const mod = str(fd.get("module"));
  if (!isModuleId(mod)) throw new UserError("Pick a module.");
  const mode = str(fd.get("mode"));
  if (mode !== "on" && mode !== "off" && mode !== "none" && mode !== "extend") throw new UserError("Pick what to do.");
  const note = str(fd.get("note"))?.slice(0, 200) ?? null;
  let key: string | null = null;
  let lastDay: string | null = null;
  let finalNote = note;
  if (mode === "on") {
    if (!hostedSigner()) throw new UserError(NO_HOSTING_KEY);
    const typed = str(fd.get("lastDay"));
    lastDay = typed ?? NO_END;
    if (!validYmd(lastDay) || lastDay < todayIn(shop.timeZone)) throw new UserError("Pick a date from today on, or leave it blank for no end date.");
    const grace = graceOf(fd);
    key = signGrant({ shopId: shop.id, shopName: shop.name, module: mod, lastDay, graceDays: grace, timeZone: shop.timeZone });
  } else if (mode === "extend") {
    if (!hostedSigner()) throw new UserError(NO_HOSTING_KEY);
    const period = str(fd.get("period"));
    if (period !== "m" && period !== "y") throw new UserError("Pick a month or a year.");
    const rows = await db.moduleGrant.findMany({ where: { shopId: shop.id, module: mod }, select: { id: true, mode: true, key: true, createdAt: true } });
    const pos = adminPosition(rows);
    const current = pos.onKey ? verifyLicense(pos.onKey, LICENSE_PUBLIC_KEYS) : null;
    const today = todayIn(shop.timeZone);
    if (!current?.ok || current.payload.u < today || current.payload.u >= NO_END) throw new UserError("Turn it on first.");
    const start = current.payload.u >= today ? addDaysYmd(current.payload.u, 1) : today;
    lastDay = planLastDay(start, period);
    finalNote = period === "m" ? "Extended 1 month" : "Extended 1 year";
    key = signGrant({ shopId: shop.id, shopName: shop.name, module: mod, lastDay, graceDays: current.payload.g, timeZone: shop.timeZone });
  }
  await db.moduleGrant.create({ data: { shopId: shop.id, module: mod, mode: mode === "extend" ? "on" : mode, key, byEmail: admin.email, note: finalNote } });
  // A record outside the database too.
  console.info(`[modules] ${JSON.stringify({ company: shop.id, module: mod, mode, until: lastDay ?? null, by: admin.email })}`);
  revalidatePath("/companies");
  revalidatePath("/", "layout");
}

function graceOf(fd: FormData) {
  const s = str(fd.get("grace"));
  if (s == null) return 14;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 90) throw new UserError("Grace is 0 to 90 days.");
  return n;
}

export async function setHubWritesFor(admin: CurrentUser, shopId: string, off: boolean) {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (!shop) throw new UserError("Company not found.");
  await db.shop.update({ where: { id: shop.id }, data: { hubWritesOff: off === true } });
  console.info(`[hub] ${JSON.stringify({ company: shop.id, writesOff: off === true, by: admin.email })}`);
  revalidatePath("/companies");
}
