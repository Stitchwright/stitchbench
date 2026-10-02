import "server-only";
// What the calendar shows (scheduling-messaging-design.md 12.2): appointments and blocks, class meetings, partner pickup
// runs, shifts when asked, and central-vac installs (the vac module adds those through siteJobsBetween).
import { db } from "@/lib/db";
import { ticketNo } from "@/lib/format";
import { siteJobsBetween } from "@/lib/vac/installs";

export type CalItem = {
  kind: "appointment" | "class" | "run" | "shift" | "install";
  id: string;
  start: Date;
  end: Date;
  title: string;
  sub: string | null;
  href: string;
  tone: "neutral" | "work" | "wait" | "ready" | "done" | "bad";
  typeId?: string | null;
  struck?: boolean;
};

const APPT_TONE: Record<string, CalItem["tone"]> = { BOOKED: "ready", DONE: "done", NO_SHOW: "bad", CANCELLED: "neutral" };

/** Everything in [from, to) for the shop, by start time. */
export async function calendarItems(shopId: string, from: Date, to: Date, o: { shifts: boolean }): Promise<CalItem[]> {
  const overlap = { startsAt: { lt: to }, endsAt: { gt: from } };
  const [appts, meetings, runs, shifts] = await Promise.all([
    db.appointment.findMany({ where: { shopId, status: { not: "CANCELLED" }, ...overlap }, orderBy: { startsAt: "asc" }, include: { staff: { select: { name: true } } } }),
    db.classMeeting.findMany({ where: { shopId, ...overlap }, orderBy: { startsAt: "asc" }, include: { shopClass: { select: { id: true, title: true, teacher: true, location: true, status: true } } } }),
    db.partnerRun.findMany({ where: { shopId, status: { not: "CANCELLED" }, startsAt: { lt: to }, OR: [{ endsAt: { gt: from } }, { endsAt: null, startsAt: { gte: new Date(from.getTime() - 3_600_000) } }] }, orderBy: { startsAt: "asc" } }),
    o.shifts ? db.shift.findMany({ where: { shopId, ...overlap }, orderBy: { startsAt: "asc" } }) : Promise.resolve([]),
  ]);
  const linkNames = runs.length ? new Map((await db.partnerLink.findMany({ where: { shopId, id: { in: [...new Set(runs.map((r) => r.linkId))] } }, select: { id: true, partnerName: true } })).map((l) => [l.id, l.partnerName])) : new Map<string, string>();
  const items: CalItem[] = [];
  for (const a of appts) {
    items.push({
      kind: "appointment",
      id: a.id,
      start: a.startsAt,
      end: a.endsAt,
      title: a.blocked ? `Blocked: ${a.title}` : a.title,
      sub: a.blocked ? null : [a.name, a.staff?.name ? `with ${a.staff.name}` : null].filter(Boolean).join(" · ") || null,
      href: `/calendar/appointments/${a.id}`,
      tone: a.blocked ? "neutral" : (APPT_TONE[a.status] ?? "neutral"),
      typeId: a.typeId,
    });
  }
  for (const m of meetings) {
    items.push({
      kind: "class",
      id: m.id,
      start: m.startsAt,
      end: m.endsAt,
      title: m.shopClass.title,
      sub: [m.shopClass.teacher, m.shopClass.location].filter(Boolean).join(" · ") || null,
      href: `/classes/${m.shopClass.id}`,
      tone: m.cancelled || m.shopClass.status === "CANCELLED" ? "neutral" : "work",
      struck: m.cancelled || m.shopClass.status === "CANCELLED",
    });
  }
  for (const r of runs) {
    items.push({
      kind: "run",
      id: r.id,
      start: r.startsAt,
      end: r.endsAt ?? new Date(r.startsAt.getTime() + 3_600_000),
      title: `Pickup run: ${linkNames.get(r.linkId) ?? "partner shop"}`,
      sub: `${r.collect.length} to collect · ${r.deliver.length} to deliver`,
      href: `/partners/${r.linkId}/runs/${r.id}`,
      tone: r.status === "DONE" ? "done" : "wait",
    });
  }
  for (const s of shifts) {
    items.push({ kind: "shift", id: s.id, start: s.startsAt, end: s.endsAt, title: s.name, sub: s.role, href: `/shifts?week=${s.startsAt.toISOString().slice(0, 10)}`, tone: "neutral" });
  }
  // Central-vac installs (the vac module's siteJobsBetween applies its own gate; a stub returns [] until it ships).
  for (const s of await siteJobsBetween(shopId, from, to)) {
    const start = s.startsAt ?? from;
    items.push({ kind: "install", id: s.ticketId, start, end: s.endsAt ?? new Date(start.getTime() + 2 * 3_600_000), title: `Install: ${s.customerName ?? `ticket ${ticketNo(s.number)}`}`, sub: s.address, href: `/tickets/${s.ticketId}`, tone: s.status === "COLLECTED" ? "done" : "work" });
  }
  return items.sort((a, b) => a.start.getTime() - b.start.getTime());
}
