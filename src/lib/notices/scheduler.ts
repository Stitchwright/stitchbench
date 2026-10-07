import "server-only";
// The automatic notices' schedulers (scheduling-messaging-design.md section 9.3), run by the message worker for the
// shops with Marketing on: reminders, uncollected-machine notices, service due, review requests, and last bags due.
// Every queue call carries a dedupe key, so a second run (two servers, a restart) queues nothing new.
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { isDesktop } from "@/lib/modules";
import { canWorkOn } from "@/lib/equipment/gate";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView, type MessagingView } from "@/lib/messaging/settings";
import { firstName, renderKind } from "@/lib/messaging/templates";
import { machinesDue } from "@/lib/messaging/service-due";
import { shopsWith } from "@/lib/module-gate";
import { addDays, dayStart, fmtWhen, monthsBetween, ymdOf, zonedTime } from "@/lib/zoned";
import { abandonDate, abandonStages, sendable, stageKey } from "@/lib/notices/abandon";
import { queueAbandonNotice } from "@/lib/notices/hooks";
import { abandonTarget, termDays } from "@/lib/notices/vars";
import { runBagsDue } from "@/lib/vac/bags-due";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Most new messages one shop gets queued in one run. */
const RUN_CAP = 200;
/** Most customers one shop gets a service-due message on in a shop day. */
const SERVICE_DAILY_CAP = 50;

type Shop = { id: string; name: string; phone: string | null; address: string | null; timeZone: string; abandonedAfterDays: number };
type Run = { now: Date; tz: string; today: string; shop: Shop; ms: MessagingView; left: number; marketingEmailOk: boolean };

export async function runSchedulers(now: Date, shopIds: string[]): Promise<void> {
  // Notices are Marketing work: a shop without it is skipped (the worker passes only those, this keeps a direct call honest).
  const live = new Set(await shopsWith("marketing", shopIds));
  for (const shopId of shopIds) {
    if (!live.has(shopId)) continue;
    try {
      await runShop(now, shopId);
    } catch (e) {
      console.error(`notices: scheduler for shop ${shopId} failed:`, e);
    }
  }
  await runBagsDue(now, shopIds);
}

async function runShop(now: Date, shopId: string) {
  const [shop, ms] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true, phone: true, address: true, timeZone: true, abandonedAfterDays: true } }),
    messagingView(shopId),
  ]);
  if (!shop) return;
  // Marketing email carries the postal address, and without a public link the unsubscribes arrive as replies someone reads.
  const needsWatched = isDesktop() || !ms.publicUrl;
  const run: Run = { now, tz: shop.timeZone, today: ymdOf(now, shop.timeZone), shop, ms, left: RUN_CAP, marketingEmailOk: !!(ms.postalAddress ?? shop.address) && (!needsWatched || ms.replyWatched) };
  const steps: [string, boolean, () => Promise<void>][] = [
    ["reminders", ms.reminders, () => reminders(run)],
    ["uncollected", ms.abandonNotices, () => uncollected(run)],
    ["service due", ms.serviceDue && ms.serviceDueDay !== run.today, () => serviceDue(run)],
    ["review", ms.reviewRequest && !!ms.reviewUrl, () => reviews(run)],
    ["software renewals", true, () => softwareRenewals(run)],
  ];
  for (const [name, on, fn] of steps) {
    if (!on || run.left <= 0) continue;
    try {
      await fn();
    } catch (e) {
      console.error(`notices: ${name} for shop ${shopId} failed:`, e);
    }
  }
}

const common = (shop: Shop, customer: { name: string } | undefined) => ({ first_name: firstName(customer?.name ?? ""), name: customer?.name ?? "", shop_name: shop.name, shop_phone: shop.phone ?? "" });

async function customerNames(shopId: string, ids: string[]): Promise<Map<string, { name: string; email: string | null }>> {
  const rows = ids.length ? await db.customer.findMany({ where: { shopId, id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } }) : [];
  return new Map(rows.map((c) => [c.id, { name: c.name, email: c.email }]));
}

/**
 * Marketing email needs the shop's postal address and, without a public unsubscribe link, someone reading replies
 * (design 3.3). When that is missing, a SKIPPED row with the reason shows on the Messages page, so the shop knows why
 * these customers hear nothing, instead of the message quietly falling back to a text they may not have agreed to.
 */
async function recordEmailSkip(tx: Prisma.TransactionClient, run: Run, a: { customerId: string; email: string | null; kind: "service_due" | "review"; dedupeKey: string; refType?: string; refId?: string; content: { subject?: string | null; body: string } }) {
  if (run.marketingEmailOk) return;
  const why = run.ms.postalAddress ?? run.shop.address ? "No watched reply-to address" : "No postal address set";
  await tx.outMessage.createMany({
    data: [{ shopId: run.shop.id, channel: "email", purpose: "marketing", kind: a.kind, customerId: a.customerId, address: a.email ?? "", subject: a.content.subject ?? null, body: a.content.body, status: "SKIPPED", error: why, dedupeKey: `${a.dedupeKey}:email:skipped`, sendAfter: run.now, refType: a.refType ?? null, refId: a.refId ?? null }],
    skipDuplicates: true,
  });
}

/** The base keys (without the ":channel" the queue adds) that already have a row, of any status. */
async function doneKeys(shopId: string, base: string[]): Promise<Set<string>> {
  if (!base.length) return new Set();
  const all = base.flatMap((k) => [`${k}:email`, `${k}:sms`, `${k}:email:skipped`, `${k}:sms:skipped`]);
  const rows = await db.outMessage.findMany({ where: { shopId, dedupeKey: { in: all } }, select: { dedupeKey: true } });
  const have = new Set(rows.map((r) => r.dedupeKey ?? ""));
  return new Set(base.filter((k) => have.has(`${k}:email`) || have.has(`${k}:sms`) || have.has(`${k}:email:skipped`) || have.has(`${k}:sms:skipped`)));
}

// ---------- 1. reminders ----------

type Item = { base: string; customerId: string; refType: "meeting" | "appointment"; refId: string; startsAt: Date; madeAt: Date; vars: Record<string, string> };

async function reminders(run: Run) {
  const { now, tz, today, shop, ms } = run;
  const from = new Date(now.getTime() + 2 * HOUR);
  const to = dayStart(addDays(today, 2), tz);
  if (to.getTime() <= from.getTime()) return;
  const tomorrow = addDays(today, 1);
  const tomorrowAt = new Date(Math.max(now.getTime(), zonedTime(today, ms.reminderHour * 60, tz).getTime()));
  const items: Item[] = [];

  const meetings = await db.classMeeting.findMany({
    where: { shopId: shop.id, cancelled: false, startsAt: { gte: from, lt: to }, shopClass: { status: { not: "CANCELLED" }, remind: { not: "never" } } },
    include: { shopClass: true },
    orderBy: { startsAt: "asc" },
  });
  if (meetings.length) {
    const classIds = [...new Set(meetings.map((m) => m.classId))];
    const [all, enrollments] = await Promise.all([
      db.classMeeting.findMany({ where: { shopId: shop.id, classId: { in: classIds }, cancelled: false }, select: { id: true, classId: true }, orderBy: { startsAt: "asc" } }),
      db.enrollment.findMany({ where: { shopId: shop.id, classId: { in: classIds }, status: "ENROLLED", customerId: { not: null } }, select: { id: true, classId: true, customerId: true, attendee: true, createdAt: true } }),
    ]);
    const byClass = new Map<string, string[]>();
    for (const m of all) byClass.set(m.classId, [...(byClass.get(m.classId) ?? []), m.id]);
    for (const m of meetings) {
      const order = byClass.get(m.classId) ?? [];
      if (m.shopClass.remind === "first" && order[0] !== m.id) continue;
      const title = order.length > 1 ? `${m.shopClass.title} (meeting ${order.indexOf(m.id) + 1} of ${order.length})` : m.shopClass.title;
      for (const e of enrollments) {
        if (e.classId !== m.classId || !e.customerId) continue;
        items.push({
          base: `remind:m:${m.id}:${e.id}:${m.startsAt.getTime()}`,
          customerId: e.customerId,
          refType: "meeting",
          refId: m.id,
          startsAt: m.startsAt,
          madeAt: e.createdAt,
          vars: {
            what: e.attendee ? `${title} for ${e.attendee}` : title,
            when: fmtWhen(m.startsAt, tz),
            location_line: m.shopClass.location ? ` At ${m.shopClass.location}.` : "",
            supplies_line: m.shopClass.supplies ? `\n\nBring: ${m.shopClass.supplies}` : "",
          },
        });
      }
    }
  }

  const appointments = await db.appointment.findMany({
    where: { shopId: shop.id, status: "BOOKED", blocked: false, customerId: { not: null }, startsAt: { gte: from, lt: to } },
    include: { type: { select: { location: true } } },
    orderBy: { startsAt: "asc" },
  });
  for (const a of appointments) {
    if (!a.customerId) continue;
    items.push({
      base: `remind:a:${a.id}:${a.startsAt.getTime()}`,
      customerId: a.customerId,
      refType: "appointment",
      refId: a.id,
      startsAt: a.startsAt,
      madeAt: a.createdAt,
      vars: { what: a.title, when: fmtWhen(a.startsAt, tz), location_line: a.type?.location ? ` At ${a.type.location}.` : "", supplies_line: "" },
    });
  }

  // Staff just told someone who signed up or booked less than a day before the start (and the confirmation went out).
  const due = items.filter((i) => i.madeAt.getTime() <= i.startsAt.getTime() - DAY);
  if (!due.length) return;
  const [done, names] = await Promise.all([doneKeys(shop.id, due.map((i) => i.base)), customerNames(shop.id, due.map((i) => i.customerId))]);
  for (const i of due) {
    if (run.left <= 0) return;
    if (done.has(i.base)) continue;
    const sendAfter = ymdOf(i.startsAt, tz) === tomorrow ? tomorrowAt : now;
    const vars = { ...common(shop, names.get(i.customerId)), ...i.vars };
    const r = await queueToCustomer(db, {
      shopId: shop.id,
      customerId: i.customerId,
      kind: "reminder",
      channels: "preferred",
      dedupeKey: i.base,
      refType: i.refType,
      refId: i.refId,
      sendAfter,
      notAfter: new Date(i.startsAt.getTime() - 2 * HOUR),
      ms,
      content: (ch) => renderKind(ms, "reminder", ch, vars),
    });
    run.left -= r.queued.length;
  }
}

// ---------- 2. uncollected-machine notices ----------

/**
 * Every machine on the pickup shelf, every 5 minutes: the stages are arithmetic on the ready date, so nothing is
 * queried per machine until a stage is due, and the rows that already exist are fetched in one query. Only the few
 * machines with a stage due and no row yet are loaded in full (abandonTarget) and queued.
 */
async function uncollected(run: Run) {
  const { now, tz, shop, ms } = run;
  const [tickets, jobs] = await Promise.all([
    db.ticket.findMany({
      where: { shopId: shop.id, status: "READY_FOR_PICKUP", pickupReadyAt: { not: null }, customerId: { not: null }, viaAccountId: null, jobType: "BENCH" },
      select: { id: true, pickupReadyAt: true },
    }),
    db.repairJob.findMany({ where: { shopId: shop.id, side: "retail", customerId: { not: null }, pickedUpAt: null, backAt: { not: null } }, select: { id: true, backAt: true, linkId: true } }),
  ]);
  const links = jobs.length ? await db.partnerLink.findMany({ where: { shopId: shop.id, id: { in: [...new Set(jobs.map((j) => j.linkId))] } }, select: { id: true, terms: true } }) : [];
  const jobDays = new Map(links.map((l) => [l.id, termDays(l.terms, shop.abandonedAfterDays)]));
  type Cand = { ref: { ticketId?: string; jobId?: string }; start: Date; days: number };
  const cands: Cand[] = [
    ...tickets.flatMap((t) => (t.pickupReadyAt ? [{ ref: { ticketId: t.id }, start: t.pickupReadyAt, days: shop.abandonedAfterDays }] : [])),
    ...jobs.flatMap((j) => (j.backAt ? [{ ref: { jobId: j.id }, start: j.backAt, days: jobDays.get(j.linkId) ?? shop.abandonedAfterDays }] : [])),
  ];
  const due = cands.flatMap((c) => {
    const s = sendable(abandonStages(c.start, ms.abandonDays, c.days, ms.finalNoticeDays, ms.reminderHour, tz), now, abandonDate(c.start, c.days, tz));
    return s ? [{ ...c, key: stageKey(c.start, s) }] : [];
  });
  if (!due.length) return;
  const have = await db.outMessage.findMany({
    where: { shopId: shop.id, kind: "abandon", refType: "stage", refId: { in: [...new Set(due.map((d) => d.key))] } },
    select: { refId: true, ticketId: true, repairJobId: true },
  });
  const done = new Set(have.map((h) => `${h.ticketId ?? h.repairJobId}:${h.refId}`)); // sent, waiting, or recorded by hand
  for (const d of due) {
    if (run.left <= 0) return;
    if (done.has(`${d.ref.ticketId ?? d.ref.jobId}:${d.key}`)) continue;
    const target = await abandonTarget(db, shop.id, d.ref);
    if (!target) continue; // not direct (a partner's repair), SITE, or moved on meanwhile
    const s = sendable(abandonStages(target.start, ms.abandonDays, target.abandonedAfterDays, ms.finalNoticeDays, ms.reminderHour, tz), now, abandonDate(target.start, target.abandonedAfterDays, tz));
    if (!s || stageKey(target.start, s) !== d.key) continue;
    const r = await queueAbandonNotice(db, { shopId: shop.id, target, stage: s, ms, dedupeKey: `abandon:${d.ref.ticketId ? `t:${d.ref.ticketId}` : `j:${d.ref.jobId}`}:${d.key}` });
    run.left -= r.queued.length;
  }
}

// ---------- 3. service due ----------

const joinNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

async function serviceDue(run: Run) {
  const { now, tz, today, shop, ms } = run;
  const since = new Date(Math.max(ms.serviceDueSince?.getTime() ?? 0, now.getTime() - 60 * DAY));
  const due = (await machinesDue(shop.id, ms.serviceDueMonths, now, { dueSince: since })).filter((m) => m.noticedFor?.getTime() !== m.lastServiceAt.getTime());
  const workable = new Map<string, boolean>();
  const machines = [];
  for (const m of due) {
    if (!workable.has(m.equipment)) workable.set(m.equipment, await canWorkOn(shop.id, m.equipment));
    if (workable.get(m.equipment)) machines.push(m);
  }
  const byCustomer = new Map<string, typeof machines>();
  for (const m of machines) byCustomer.set(m.customerId, [...(byCustomer.get(m.customerId) ?? []), m]);

  // At most 50 customers a day; the rest are still due tomorrow.
  const sentToday = await db.outMessage.count({ where: { shopId: shop.id, kind: "service_due", status: { in: ["QUEUED", "SENDING", "SENT"] }, createdAt: { gte: dayStart(today, tz) } } });
  let room = SERVICE_DAILY_CAP - sentToday;
  const names = await customerNames(shop.id, [...byCustomer.keys()]);
  for (const [customerId, list] of byCustomer) {
    if (room <= 0 || run.left <= 0) break;
    const latest = list.reduce((a, b) => (b.lastServiceAt > a.lastServiceAt ? b : a));
    const vars = {
      ...common(shop, names.get(customerId)),
      machine: joinNames(list.map((m) => `${m.brand} ${m.model}`.replace(/\s+/g, " ").trim())),
      months: String(monthsBetween(latest.lastServiceAt, now, tz)),
    };
    await db.$transaction(async (tx) => {
      const r = await queueToCustomer(tx, {
        shopId: shop.id,
        customerId,
        kind: "service_due",
        channels: run.marketingEmailOk ? "one" : ["sms"],
        dedupeKey: `svc:${customerId}:${today}`,
        refType: "machine",
        refId: list[0].machineId,
        sendAfter: now,
        ms,
        content: (ch) => renderKind(ms, "service_due", ch, vars),
      });
      // One row per customer and service date, not one a day, while the shop's email settings are incomplete.
      if (!r.queued.length && !r.duplicate.length) await recordEmailSkip(tx, run, { customerId, email: names.get(customerId)?.email ?? null, kind: "service_due", dedupeKey: `svc:${customerId}:${latest.lastServiceAt.getTime()}`, refType: "machine", refId: list[0].machineId, content: renderKind(ms, "service_due", "email", vars) });
      // Marked even when every channel was skipped (no consent), so the customer isn't looked at again every day. Not
      // marked when mail couldn't be used because of the shop's own settings: that is fixed, not a customer's choice.
      if (r.queued.length || r.duplicate.length || run.marketingEmailOk) {
        for (const m of list) await tx.machine.updateMany({ where: { id: m.machineId, shopId: shop.id }, data: { serviceNoticeFor: m.lastServiceAt } });
      }
      room -= 1;
      run.left -= r.queued.length;
    });
  }
  await db.messagingSettings.updateMany({ where: { shopId: shop.id }, data: { serviceDueDay: today } });
}

// ---------- 4. review requests ----------

/**
 * Software subscriptions renewing in the next 30 days (shop-features-round-2-design.md 2.5): one friendly reminder per
 * renewal date (Shop's Marketing on; consent rules as any marketing message), never twice for the same date.
 */
async function softwareRenewals(run: Run) {
  const { now, shop, ms, tz } = run;
  const due = await db.softwareLicense.findMany({
    where: { shopId: shop.id, status: "ACTIVE", kind: "SUBSCRIPTION", customerId: { not: null }, renewsOn: { gte: now, lte: new Date(now.getTime() + 30 * DAY) } },
    select: { id: true, description: true, customerId: true, renewsOn: true, renewNoticeFor: true },
    take: 200,
  });
  const todo = due.filter((l) => l.renewsOn && (!l.renewNoticeFor || l.renewNoticeFor.getTime() !== l.renewsOn.getTime()));
  if (!todo.length) return;
  const names = await customerNames(shop.id, todo.map((l) => l.customerId!));
  for (const l of todo) {
    if (run.left <= 0) return;
    const c = names.get(l.customerId!);
    const day = ymdOf(l.renewsOn!, tz);
    const when = fmtWhen(l.renewsOn!, tz).replace(/ at .*$/, "");
    const hello = `Hi ${firstName(c?.name ?? "")}`.trim();
    const body = `${hello}, your ${l.description} subscription from ${shop.name} renews on ${when}. Stop by${shop.phone ? ` or call ${shop.phone}` : ""} to renew it.`;
    const key = `software_renew:${l.id}:${day}`;
    await db.$transaction(async (tx) => {
      const r = await queueToCustomer(tx, {
        shopId: shop.id,
        customerId: l.customerId!,
        kind: "software_renew",
        channels: run.marketingEmailOk ? "one" : ["sms"],
        dedupeKey: key,
        sendAfter: now,
        ms,
        refType: "software",
        refId: l.id,
        content: (ch) => (ch === "email" ? { subject: `Your ${l.description} renews on ${when}`, body } : { body }),
      });
      if (r.queued.length || r.duplicate.length) {
        await tx.softwareLicense.updateMany({ where: { id: l.id, shopId: shop.id }, data: { renewNoticeFor: l.renewsOn } });
        run.left -= r.queued.length;
      }
    });
  }
}

async function reviews(run: Run) {
  const { now, today, shop, ms } = run;
  const newest = new Date(now.getTime() - ms.reviewDelayHours * HOUR);
  const oldest = new Date(newest.getTime() - 48 * HOUR);
  const window = { gte: oldest, lte: newest };
  const [tickets, jobs, sales] = await Promise.all([
    db.ticket.findMany({ where: { shopId: shop.id, status: "COLLECTED", jobType: "BENCH", closedAt: window, customerId: { not: null }, viaAccountId: null }, select: { id: true, customerId: true } }),
    db.repairJob.findMany({ where: { shopId: shop.id, side: "retail", status: "COLLECTED", pickedUpAt: window, customerId: { not: null } }, select: { customerId: true } }),
    ms.reviewAfterSales ? db.sale.findMany({ where: { shopId: shop.id, status: "COMPLETED", totalCents: { gt: 0 }, createdAt: window, customerId: { not: null } }, select: { customerId: true } }) : Promise.resolve([]),
  ]);
  // A bench ticket for a partner's repair (a repair shop's own side) isn't the shop's customer's visit.
  const partner = tickets.length ? await db.repairJob.findMany({ where: { shopId: shop.id, ticketId: { in: tickets.map((t) => t.id) } }, select: { ticketId: true } }) : [];
  const skipTickets = new Set(partner.map((p) => p.ticketId));
  const ids = new Set<string>();
  for (const t of tickets) if (t.customerId && !skipTickets.has(t.id)) ids.add(t.customerId);
  for (const j of jobs) if (j.customerId) ids.add(j.customerId);
  for (const s of sales) if (s.customerId) ids.add(s.customerId);
  if (!ids.size) return;
  const asked = new Date(now.getTime() - ms.reviewEveryDays * DAY);
  const customers = await db.customer.findMany({ where: { shopId: shop.id, id: { in: [...ids] }, OR: [{ lastReviewAskAt: null }, { lastReviewAskAt: { lte: asked } }] }, select: { id: true, name: true, email: true } });
  for (const c of customers) {
    if (run.left <= 0) return;
    const vars = { ...common(shop, c), review_link: ms.reviewUrl ?? "" };
    await db.$transaction(async (tx) => {
      const r = await queueToCustomer(tx, {
        shopId: shop.id,
        customerId: c.id,
        kind: "review",
        channels: run.marketingEmailOk ? "one" : ["sms"],
        dedupeKey: `review:${c.id}:${today}`,
        sendAfter: now,
        ms,
        content: (ch) => renderKind(ms, "review", ch, vars),
      });
      if (r.queued.length) {
        await tx.customer.updateMany({ where: { id: c.id, shopId: shop.id }, data: { lastReviewAskAt: now } });
        run.left -= r.queued.length;
      } else if (!r.duplicate.length) await recordEmailSkip(tx, run, { customerId: c.id, email: c.email, kind: "review", dedupeKey: `review:${c.id}:${today}`, content: renderKind(ms, "review", "email", vars) });
    });
  }
}
