import "server-only";
// The single consent gate (allowed(), pure) and the consent records around it (scheduling-messaging-design.md
// sections 3.2 and 4.1). Suppressions and ConsentEvents are the law's records: appended, never edited away.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { toE164, usMarketingNumber, validEmail } from "@/lib/phone";
import type { MessagingView } from "./settings";
import type { Channel, Purpose, SkipReason } from "./types";

export type ConsentCustomer = { id: string; kind: "RETAIL" | "TRADE"; phone: string | null; email: string | null; notifyBy: string; smsConsentAt: Date | null; smsConsentPhone: string | null };
export type SupMap = Map<string, "marketing" | "all">; // key `${channel}:${address}`
export type Allowed = { ok: true; address: string } | { ok: false; reason: SkipReason };

const no = (reason: SkipReason): Allowed => ({ ok: false, reason });
const ok = (address: string): Allowed => ({ ok: true, address });

/**
 * May this message go to this customer on this channel? Called when queueing AND again by the worker right before
 * sending. `explicit` is an address given by staff (tests, confirmations): then only suppression is checked.
 */
export function allowed(c: ConsentCustomer | null, channel: Channel, purpose: Purpose, ms: Pick<MessagingView, "emailReady" | "smsReady">, sup: SupMap, explicit?: string): Allowed {
  if (channel === "email" ? !ms.emailReady : !ms.smsReady) return no("channel_off");
  const address = explicit ?? (channel === "email" ? validEmail(c?.email) : toE164(c?.phone));
  if (!address) return no("no_address");
  const s = sup.get(`${channel}:${address}`);
  if (channel === "sms" && s) return no("opted_out"); // STOP stops every text, reminders included
  if (channel === "email" && s === "all") return no("opted_out");
  if (channel === "email" && s === "marketing" && purpose === "marketing") return no("unsubscribed");
  if (!c) return ok(address); // explicit address (tests, confirmations): suppression only
  if (c.notifyBy === "none") return no("no_messages"); // "No messages (call them)" blocks marketing too
  if (purpose === "notice") {
    if (channel === "sms" && c.notifyBy !== "sms" && c.notifyBy !== "both") return no(c.notifyBy === "" ? "not_asked" : "prefers_other");
    if (channel === "email" && c.notifyBy === "sms") return no("prefers_other");
    return ok(address);
  }
  if (c.kind === "TRADE") return no("trade");
  if (channel === "sms" && !usMarketingNumber(address)) return no("not_us");
  if (channel === "sms" && !(c.smsConsentAt && c.smsConsentPhone === address)) return no("no_text_consent");
  return ok(address);
}

type Db = Prisma.TransactionClient | typeof db;

/** The customers (as allowed() needs them) and every suppression of the shop, in two queries. */
export async function consentState(tx: Db, shopId: string, customerIds: string[]): Promise<{ customers: Map<string, ConsentCustomer>; sup: SupMap }> {
  const ids = [...new Set(customerIds)];
  const [rows, sups] = await Promise.all([
    ids.length ? tx.customer.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, kind: true, phone: true, email: true, notifyBy: true, smsConsentAt: true, smsConsentPhone: true } }) : Promise.resolve([]),
    tx.suppression.findMany({ where: { shopId }, select: { channel: true, address: true, scope: true } }),
  ]);
  const sup: SupMap = new Map();
  for (const s of sups) sup.set(`${s.channel}:${s.address}`, s.scope === "all" ? "all" : "marketing");
  return { customers: new Map(rows.map((c) => [c.id, c])), sup };
}

/** Every suppression of the shop as a map (for the worker's per-row re-check). */
export async function suppressionMap(tx: Db, shopId: string): Promise<SupMap> {
  const sups = await tx.suppression.findMany({ where: { shopId }, select: { channel: true, address: true, scope: true } });
  const sup: SupMap = new Map();
  for (const s of sups) sup.set(`${s.channel}:${s.address}`, s.scope === "all" ? "all" : "marketing");
  return sup;
}

/** An append-only consent record. */
export async function recordConsent(tx: Db, e: Omit<Prisma.ConsentEventUncheckedCreateInput, "id" | "at">): Promise<void> {
  await tx.consentEvent.create({ data: e });
}

/**
 * Do-not-send for an address: upsert the Suppression (never downgrading "all" to "marketing"), a ConsentEvent
 * "optout", and for texts: cancel queued texts to the address and withdraw marketing consent on customers whose
 * consent number it is (ConsentEvent "marketing_no").
 */
export async function suppress(tx: Db, a: { shopId: string; channel: Channel; address: string; scope: "marketing" | "all"; source: string; customerId?: string | null; detail?: string | null; byUserId?: string | null }): Promise<void> {
  const scope = a.channel === "sms" ? "all" : a.scope;
  const existing = await tx.suppression.findUnique({ where: { shopId_channel_address: { shopId: a.shopId, channel: a.channel, address: a.address } } });
  if (!existing) await tx.suppression.create({ data: { shopId: a.shopId, channel: a.channel, address: a.address, scope, source: a.source } });
  else if (existing.scope !== "all" && scope === "all") await tx.suppression.update({ where: { shopId_channel_address: { shopId: a.shopId, channel: a.channel, address: a.address } }, data: { scope: "all", source: a.source } });
  await recordConsent(tx, { shopId: a.shopId, customerId: a.customerId ?? null, channel: a.channel, address: a.address, event: "optout", source: a.source, detail: a.detail ?? scope, byUserId: a.byUserId ?? null });
  if (a.channel === "sms") {
    await tx.outMessage.updateMany({ where: { shopId: a.shopId, channel: "sms", address: a.address, status: "QUEUED" }, data: { status: "CANCELLED", error: "They opted out" } });
    const consented = await tx.customer.findMany({ where: { shopId: a.shopId, smsConsentPhone: a.address }, select: { id: true } });
    if (consented.length) {
      await tx.customer.updateMany({ where: { shopId: a.shopId, smsConsentPhone: a.address }, data: { smsConsentAt: null, smsConsentPhone: null, smsConsentSource: null, smsConsentText: null } });
      for (const c of consented) await recordConsent(tx, { shopId: a.shopId, customerId: c.id, channel: "sms", address: a.address, event: "marketing_no", source: a.source, detail: "Opted out of texts", byUserId: a.byUserId ?? null });
    }
  }
}

/** Lift a suppression (START, or an admin with a reason): the row goes, a ConsentEvent "optin" stays. */
export async function unsuppress(tx: Db, a: { shopId: string; channel: Channel; address: string; source: string; byUserId?: string | null; detail?: string | null; customerId?: string | null }): Promise<void> {
  await tx.suppression.deleteMany({ where: { shopId: a.shopId, channel: a.channel, address: a.address } });
  await recordConsent(tx, { shopId: a.shopId, customerId: a.customerId ?? null, channel: a.channel, address: a.address, event: "optin", source: a.source, detail: a.detail ?? null, byUserId: a.byUserId ?? null });
}

/** A pasted "unsubscribe <token>" subject, a /u/<token> link or the bare token -> the address it was sent to. */
export async function addressForOptOutCode(shopId: string, text: string): Promise<{ channel: "email"; address: string; customerId: string | null } | null> {
  const m = /([A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(String(text ?? "").replace(/^.*unsubscribe\s+/i, "").replace(/^.*\/u\//, ""));
  if (!m) return null;
  const row = await db.outMessage.findFirst({ where: { shopId, optOutToken: m[1] }, select: { address: true, customerId: true } });
  if (!row) return null;
  return { channel: "email", address: row.address, customerId: row.customerId };
}
