import "server-only";
// The customer named on a check-in or take-in form, and the "how should we tell them" rule (design 4.1, 8.3).
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { str } from "@/lib/format";
import { moduleOn } from "@/lib/module-gate";
import { recordConsent } from "@/lib/messaging/consent";
import { messagingView } from "@/lib/messaging/settings";
import { isNotifyBy } from "@/components/notify-by-field";

type Db = Prisma.TransactionClient | typeof db;

/** Whether check-in must ask how to tell the customer: Marketing on and a channel ready. */
export async function needNotifyBy(shopId: string): Promise<boolean> {
  if (!(await moduleOn(shopId, "marketing"))) return false;
  const ms = await messagingView(shopId);
  return ms.emailReady || ms.smsReady;
}

/**
 * The form's customer: an existing one (`${p}customerId`, checked with shopId) or a new RETAIL one from
 * `${p}customerName|customerPhone|customerEmail`. A `${p}notifyBy` present and valid is set (with a ConsentEvent
 * notify_pref); when `notifyRequired` and the customer hasn't been asked yet, the form must carry one.
 */
export async function customerFromForm(tx: Db, shopId: string, fd: FormData, byUserId: string, source: "counter" | "intake", p = "", o: { notifyRequired?: boolean } = {}): Promise<{ id: string; name: string }> {
  const pickedId = str(fd.get(`${p}customerId`));
  const typedNotify = fd.has(`${p}notifyBy`) ? str(fd.get(`${p}notifyBy`)) ?? "" : null;
  const notifyBy = typedNotify != null && isNotifyBy(typedNotify) ? typedNotify : null;
  if (pickedId) {
    const c = await tx.customer.findFirst({ where: { id: pickedId, shopId }, select: { id: true, name: true, notifyBy: true } });
    if (!c) throw new UserError("Customer not found.");
    if (o.notifyRequired && c.notifyBy === "" && !notifyBy) throw new UserError("Ask how they'd like to be told (text, email or a call).");
    if (notifyBy && notifyBy !== c.notifyBy) {
      await tx.customer.update({ where: { id: c.id }, data: { notifyBy } });
      await recordConsent(tx, { shopId, customerId: c.id, channel: "any", event: "notify_pref", source, detail: notifyBy, byUserId });
    }
    return { id: c.id, name: c.name };
  }
  const name = str(fd.get(`${p}customerName`));
  const phone = str(fd.get(`${p}customerPhone`));
  const email = str(fd.get(`${p}customerEmail`));
  if (!name || (!phone && !email)) throw new UserError("Enter the customer's name and a phone or email.");
  if (o.notifyRequired && !notifyBy) throw new UserError("Ask how they'd like to be told (text, email or a call).");
  const c = await tx.customer.create({ data: { shopId, name, phone, email, notifyBy: notifyBy ?? "" }, select: { id: true, name: true } });
  if (notifyBy) await recordConsent(tx, { shopId, customerId: c.id, channel: "any", event: "notify_pref", source, detail: notifyBy, byUserId });
  return c;
}

/** Sets a customer's notifyBy from a form field, when present and valid, with the consent record. */
export async function applyNotifyBy(tx: Db, shopId: string, customerId: string, fd: FormData, byUserId: string, source: string, p = ""): Promise<void> {
  if (!fd.has(`${p}notifyBy`)) return;
  const v = str(fd.get(`${p}notifyBy`)) ?? "";
  if (!isNotifyBy(v)) throw new UserError("Pick how to tell them.");
  const c = await tx.customer.findFirst({ where: { id: customerId, shopId }, select: { id: true, notifyBy: true } });
  if (!c || c.notifyBy === v) return;
  await tx.customer.update({ where: { id: c.id }, data: { notifyBy: v } });
  await recordConsent(tx, { shopId, customerId: c.id, channel: "any", event: "notify_pref", source, detail: v, byUserId });
}
