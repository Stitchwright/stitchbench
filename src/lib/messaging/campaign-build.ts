import "server-only";
// Turns a campaign's members into OutMessage rows, 500 per campaign per run (scheduling-messaging-design.md 4.3 step 6
// and 11.1). The worker calls buildCampaigns(now, live) each run; a campaign CANCELLED meanwhile is left alone.
import type { Campaign, Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { allowed, consentState } from "@/lib/messaging/consent";
import { audienceOf, campaignShop, upcomingClassesLine } from "@/lib/messaging/audiences";
import { finalize, unsubscribeParts } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { machinesDue } from "@/lib/messaging/service-due";
import { cleanSubject, firstName, render } from "@/lib/messaging/templates";
import type { Channel, SkipReason } from "@/lib/messaging/types";

export const CAMPAIGN_BATCH = 500;
const RUN_MS = 10_000;

type Skipped = Partial<Record<SkipReason | "same_address", number>>;

const skippedOf = (json: unknown): Skipped => (json && typeof json === "object" ? (json as Skipped) : {});

/** One batch of one campaign: the rows, the counts, and the step to SENDING when every member is built. */
export async function buildCampaign(c: Campaign, now: Date): Promise<{ built: number; inserted: number; done: boolean }> {
  const members = Array.isArray(c.members) ? (c.members as unknown[]).filter((m): m is string => typeof m === "string") : [];
  const batch = members.slice(c.built, c.built + CAMPAIGN_BATCH);
  const channel = c.channel as Channel;
  if (!batch.length) {
    await db.campaign.updateMany({ where: { id: c.id, shopId: c.shopId, status: "QUEUING" }, data: { status: "SENDING", built: members.length } });
    return { built: 0, inserted: 0, done: true };
  }
  const ms = await messagingView(c.shopId);
  const [shop, { customers, sup }] = await Promise.all([campaignShop(c.shopId, ms), consentState(db, c.shopId, batch)]);
  const audience = audienceOf(c.audience);
  const [upcoming, names] = await Promise.all([
    upcomingClassesLine(c.shopId, now, shop.tz),
    db.customer.findMany({ where: { shopId: c.shopId, id: { in: batch } }, select: { id: true, name: true } }),
  ]);
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  // The service-due audience names the machines: looked up for this batch only.
  const machineOf = new Map<string, string[]>();
  if (audience.kind === "service_due") {
    for (const m of await machinesDue(c.shopId, audience.months, now, { customerIds: batch })) {
      machineOf.set(m.customerId, [...(machineOf.get(m.customerId) ?? []), `${m.brand} ${m.model}`.replace(/\s+/g, " ").trim()]);
    }
  }
  const joinNames = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

  const skipped: Skipped = { ...skippedOf(c.skipped) };
  const rows: Prisma.OutMessageCreateManyInput[] = [];
  const seen = new Set<string>();
  for (const customerId of batch) {
    const cust = customers.get(customerId) ?? null;
    const r = allowed(cust, channel, "marketing", ms, sup);
    if (!r.ok) {
      skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
      continue;
    }
    if (seen.has(r.address)) {
      skipped.same_address = (skipped.same_address ?? 0) + 1;
      continue;
    }
    seen.add(r.address);
    const name = nameOf.get(customerId) ?? "";
    const vars = { first_name: firstName(name), name, shop_name: shop.name, shop_phone: shop.phone ?? "", machine: joinNames(machineOf.get(customerId) ?? []), upcoming_classes: upcoming };
    const unsub = channel === "email" ? unsubscribeParts(c.shopId, shop.replyTo ?? "") : null;
    rows.push({
      shopId: c.shopId,
      channel,
      purpose: "marketing",
      kind: "campaign",
      campaignId: c.id,
      customerId,
      address: r.address,
      subject: channel === "email" ? cleanSubject(render(c.subject ?? "", vars)) || null : null,
      body: finalize(channel, "campaign", render(c.body, vars), { shopName: shop.name, shopPhone: shop.phone, postal: shop.postal, unsubscribeUrl: unsub?.url ?? null, replyWord: true }),
      status: "QUEUED",
      sendAfter: now,
      dedupeKey: `campaign:${c.id}:${channel}:${r.address}`,
      optOutToken: unsub?.token ?? null,
    });
  }
  // The same address again (a second run after a crash, or a couple sharing an inbox) is one message.
  const inserted = rows.length ? (await db.outMessage.createMany({ data: rows, skipDuplicates: true })).count : 0;
  if (rows.length > inserted) skipped.same_address = (skipped.same_address ?? 0) + (rows.length - inserted);
  const built = c.built + batch.length;
  const done = built >= members.length;
  await db.campaign.updateMany({
    where: { id: c.id, shopId: c.shopId, status: "QUEUING" },
    data: { built, recipients: { increment: inserted }, skipped: skipped as Prisma.InputJsonValue, ...(done ? { status: "SENDING" } : {}) },
  });
  return { built: batch.length, inserted, done };
}

/** Every QUEUING campaign of these shops, oldest first, one batch each per call; stops after 10 s of work. */
export async function buildCampaigns(now: Date, shopIds: string[]): Promise<void> {
  if (!shopIds.length) return;
  const deadline = Date.now() + RUN_MS;
  const campaigns = await db.campaign.findMany({ where: { shopId: { in: shopIds }, status: "QUEUING" }, orderBy: { queuedAt: "asc" } });
  for (const c of campaigns) {
    if (Date.now() > deadline) return;
    await buildCampaign(c, now);
  }
}
