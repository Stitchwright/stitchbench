import "server-only";
// Who a campaign goes to (scheduling-messaging-design.md 11.1): the audience kinds, their members (RETAIL customers of
// this shop only, never a trade account or another company's), and the check a campaign page shows before it is sent.
import type { Campaign } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/action";
import { money } from "@/lib/format";
import { fmtWhen } from "@/lib/zoned";
import { allowed, consentState } from "@/lib/messaging/consent";
import { finalize, unsubscribeParts } from "@/lib/messaging/queue";
import { nextTextTime } from "@/lib/messaging/quiet";
import { messagingView, type MessagingView } from "@/lib/messaging/settings";
import { machinesDue } from "@/lib/messaging/service-due";
import { cleanSubject, render, SAMPLE_VARS, smsParts } from "@/lib/messaging/templates";
import type { Channel, SkipReason } from "@/lib/messaging/types";

const DAY = 86_400_000;

export type Audience =
  | { kind: "all" } // every retail customer
  | { kind: "bought"; days: number } // bought at the register in the last N days (1-730)
  | { kind: "repairs"; days: number } // a repair finished in the last N days (direct tickets COLLECTED, retail jobs COLLECTED)
  | { kind: "service_due"; months: number } // machines last serviced more than N months ago (3-60)
  | { kind: "class"; classId: string } // signed up (or waiting) for this class
  | { kind: "classes"; days: number }; // came to any class in the last N days

export const AUDIENCE_KINDS: { kind: Audience["kind"]; label: string; needs: "retail" | "repair" | null }[] = [
  { kind: "all", label: "Everyone", needs: null },
  { kind: "bought", label: "Bought something in the last N days", needs: "retail" },
  { kind: "repairs", label: "Had a repair finished in the last N days", needs: "repair" },
  { kind: "service_due", label: "Machine last serviced more than N months ago", needs: "repair" },
  { kind: "class", label: "Signed up for a class", needs: "retail" },
  { kind: "classes", label: "Came to a class in the last N days", needs: "retail" },
];

/** A whole number from the form within [min, max]. */
function num(fd: FormData, name: string, min: number, max: number, what: string): number {
  const raw = fd.get(name);
  const n = Number(typeof raw === "string" ? raw.trim() : "");
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** The audience a campaign form describes (`audience` = the kind; `days` / `months` / `classId` with it). */
export function parseAudience(fd: FormData): Audience {
  const kind = fd.get("audience");
  switch (kind) {
    case "all":
      return { kind: "all" };
    case "bought":
      return { kind: "bought", days: num(fd, "days", 1, 730, "Days") };
    case "repairs":
      return { kind: "repairs", days: num(fd, "days", 1, 730, "Days") };
    case "service_due":
      return { kind: "service_due", months: num(fd, "months", 3, 60, "Months") };
    case "class": {
      const classId = fd.get("classId");
      if (typeof classId !== "string" || !/^[a-z0-9]{10,40}$/i.test(classId.trim())) throw new UserError("Pick the class.");
      return { kind: "class", classId: classId.trim() };
    }
    case "classes":
      return { kind: "classes", days: num(fd, "days", 1, 730, "Days") };
    default:
      throw new UserError("Pick who gets it.");
  }
}

/** A stored audience (JSON) read back; anything odd is "everyone" so an old campaign still has a description. */
export function audienceOf(json: unknown): Audience {
  const a = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const n = (k: string) => (typeof a[k] === "number" && Number.isInteger(a[k]) ? (a[k] as number) : null);
  switch (a.kind) {
    case "bought":
      return { kind: "bought", days: n("days") ?? 90 };
    case "repairs":
      return { kind: "repairs", days: n("days") ?? 90 };
    case "service_due":
      return { kind: "service_due", months: n("months") ?? 12 };
    case "class":
      return { kind: "class", classId: String(a.classId ?? "") };
    case "classes":
      return { kind: "classes", days: n("days") ?? 365 };
    default:
      return { kind: "all" };
  }
}

/** "Everyone who bought something in the last 90 days" */
export function describeAudience(a: Audience, names?: { className?: string }): string {
  switch (a.kind) {
    case "all":
      return "Everyone";
    case "bought":
      return `Everyone who bought something in the last ${a.days} day${a.days === 1 ? "" : "s"}`;
    case "repairs":
      return `Everyone with a repair finished in the last ${a.days} day${a.days === 1 ? "" : "s"}`;
    case "service_due":
      return `Everyone whose machine was last serviced more than ${a.months} months ago`;
    case "class":
      return `Everyone signed up for ${names?.className ?? "the class"}`;
    case "classes":
      return `Everyone who came to a class in the last ${a.days} day${a.days === 1 ? "" : "s"}`;
  }
}

export type Member = { customerId: string; machine?: string };

/** Only this shop's RETAIL customers, each once, in the order given. */
async function retailOnly(shopId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.customer.findMany({ where: { shopId, kind: "RETAIL", id: { in: [...new Set(ids)] } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

const joinNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** The customers an audience names right now, de-duplicated; service_due carries the machine names for {machine}. */
export async function audienceMembers(shopId: string, a: Audience, now: Date): Promise<Member[]> {
  let ids: string[] = [];
  let machine: Map<string, string> | null = null;
  switch (a.kind) {
    case "all": {
      const rows = await db.customer.findMany({ where: { shopId, kind: "RETAIL" }, select: { id: true }, orderBy: { name: "asc" } });
      return rows.map((r) => ({ customerId: r.id }));
    }
    case "bought": {
      const since = new Date(now.getTime() - a.days * DAY);
      const rows = await db.sale.findMany({ where: { shopId, status: "COMPLETED", createdAt: { gte: since }, customerId: { not: null } }, select: { customerId: true }, distinct: ["customerId"] });
      ids = rows.map((r) => r.customerId!).filter(Boolean);
      break;
    }
    case "repairs": {
      const since = new Date(now.getTime() - a.days * DAY);
      const [tickets, jobs] = await Promise.all([
        db.ticket.findMany({ where: { shopId, status: "COLLECTED", jobType: "BENCH", closedAt: { gte: since }, customerId: { not: null }, viaAccountId: null }, select: { id: true, customerId: true } }),
        db.repairJob.findMany({ where: { shopId, side: "retail", status: "COLLECTED", pickedUpAt: { gte: since }, customerId: { not: null } }, select: { customerId: true } }),
      ]);
      // A bench ticket that is a partner shop's repair (our repair side) is their customer's visit, not ours.
      const partner = tickets.length ? await db.repairJob.findMany({ where: { shopId, side: "repair", ticketId: { in: tickets.map((t) => t.id) } }, select: { ticketId: true } }) : [];
      const skip = new Set(partner.map((p) => p.ticketId));
      ids = [...tickets.filter((t) => !skip.has(t.id)).map((t) => t.customerId!), ...jobs.map((j) => j.customerId!)];
      break;
    }
    case "service_due": {
      const due = await machinesDue(shopId, a.months, now);
      machine = new Map();
      for (const m of due) {
        const name = `${m.brand} ${m.model}`.replace(/\s+/g, " ").trim();
        const cur = machine.get(m.customerId);
        machine.set(m.customerId, cur ? `${cur}\u0000${name}` : name);
      }
      ids = [...machine.keys()];
      break;
    }
    case "class": {
      const rows = await db.enrollment.findMany({ where: { shopId, classId: a.classId, status: { in: ["ENROLLED", "WAITLIST"] }, customerId: { not: null } }, select: { customerId: true } });
      ids = rows.map((r) => r.customerId!);
      break;
    }
    case "classes": {
      // "Came to a class": signed up (not waiting, not cancelled) for a class that met in the window (a meeting that
      // wasn't cancelled). There is no per-person attendance record; the roster is on paper.
      const since = new Date(now.getTime() - a.days * DAY);
      const met = await db.classMeeting.findMany({ where: { shopId, cancelled: false, startsAt: { gte: since, lte: now } }, select: { classId: true }, distinct: ["classId"] });
      if (!met.length) return [];
      const rows = await db.enrollment.findMany({ where: { shopId, classId: { in: met.map((m) => m.classId) }, status: "ENROLLED", customerId: { not: null } }, select: { customerId: true } });
      ids = rows.map((r) => r.customerId!);
      break;
    }
  }
  const keep = await retailOnly(shopId, ids);
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const id of ids) {
    if (!keep.has(id) || seen.has(id)) continue;
    seen.add(id);
    const m = machine?.get(id);
    out.push(m ? { customerId: id, machine: joinNames(m.split("\u0000")) } : { customerId: id });
  }
  return out;
}

/** "Beginning Quilting · Tue, Oct 7 at 6:00 pm · 3 seats left · $45.00", one line per OPEN class with seats left in the next 30 days; "" for shops without the counter. */
export async function upcomingClassesLine(shopId: string, now: Date, tz: string): Promise<string> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { sellsRetail: true } });
  if (!shop?.sellsRetail) return "";
  const classes = await db.shopClass.findMany({
    where: { shopId, status: "OPEN", firstAt: { gte: now, lte: new Date(now.getTime() + 30 * DAY) } },
    select: { id: true, title: true, seats: true, feeCents: true, firstAt: true, _count: { select: { enrollments: { where: { status: "ENROLLED" } } } } },
    orderBy: { firstAt: "asc" },
    take: 12,
  });
  return classes
    .filter((c) => c.seats - c._count.enrollments > 0 && c.firstAt)
    .map((c) => `${c.title.replace(/[\r\n\t]+/g, " ").trim()} · ${fmtWhen(c.firstAt!, tz)} · ${c.seats - c._count.enrollments} seat${c.seats - c._count.enrollments === 1 ? "" : "s"} left${c.feeCents > 0 ? ` · ${money(c.feeCents)}` : ""}`)
    .join("\n");
}

export type CampaignPreview = {
  members: number;
  allowed: number;
  skipped: Partial<Record<SkipReason | "same_address", number>>;
  parts?: number;
  days: number;
  startsAt: Date;
  sample: { subject?: string; body: string };
};

/** The shop's name, phone and postal line a finalized message carries. */
export async function campaignShop(shopId: string, ms: MessagingView): Promise<{ name: string; phone: string | null; postal: string | null; tz: string; replyTo: string | null }> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, phone: true, address: true, timeZone: true } });
  return { name: shop.name, phone: shop.phone, postal: ms.postalAddress ?? shop.address, tz: shop.timeZone, replyTo: ms.replyTo ?? ms.fromEmail };
}

/** The sample as a recipient will see it (SAMPLE_VARS, this shop's name and phone, the real footer). */
export function campaignSample(c: Pick<Campaign, "channel" | "subject" | "body">, shop: { name: string; phone: string | null; postal: string | null }, unsubscribeUrl: string | null): { subject?: string; body: string } {
  const vars = { ...SAMPLE_VARS, shop_name: shop.name, shop_phone: shop.phone ?? SAMPLE_VARS.shop_phone };
  const body = finalize(c.channel as Channel, "campaign", render(c.body, vars), { shopName: shop.name, shopPhone: shop.phone, postal: shop.postal, unsubscribeUrl, replyWord: true });
  return c.channel === "email" ? { subject: cleanSubject(render(c.subject ?? "", vars)), body } : { body };
}

/**
 * The check shown before a campaign goes: how many can get it and why the rest can't (addresses de-duplicated), how many
 * days it takes at the shop's daily cap, when the first text could go, and the sample.
 */
export async function previewCampaign(shopId: string, c: Pick<Campaign, "channel" | "subject" | "body" | "audience">, now: Date): Promise<CampaignPreview> {
  const channel = c.channel as Channel;
  const [ms, members] = await Promise.all([messagingView(shopId), audienceMembers(shopId, audienceOf(c.audience), now)]);
  const shop = await campaignShop(shopId, ms);
  const { customers, sup } = await consentState(db, shopId, members.map((m) => m.customerId));
  const skipped: Partial<Record<SkipReason | "same_address", number>> = {};
  const addresses = new Set<string>();
  let allowedCount = 0;
  for (const m of members) {
    const r = allowed(customers.get(m.customerId) ?? null, channel, "marketing", ms, sup);
    if (!r.ok) skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
    else if (addresses.has(r.address)) skipped.same_address = (skipped.same_address ?? 0) + 1;
    else {
      addresses.add(r.address);
      allowedCount += 1;
    }
  }
  const cap = Math.max(1, channel === "email" ? ms.emailDailyCap : ms.smsDailyCap);
  const unsub = channel === "email" ? unsubscribeParts(shopId, shop.replyTo ?? "").url : null;
  const sample = campaignSample(c, shop, unsub);
  return {
    members: members.length,
    allowed: allowedCount,
    skipped,
    ...(channel === "sms" ? { parts: smsParts(sample.body).parts } : {}),
    days: Math.ceil(allowedCount / cap),
    startsAt: channel === "sms" ? nextTextTime(now, shop.tz, ms, true, "+12025550100") : now,
    sample,
  };
}
