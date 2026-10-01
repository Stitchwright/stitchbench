// Estimate answers and unanswered estimates to follow up, on the Dashboard and the register (scheduling-messaging-design.md
// 10.5). Nothing when there is nothing to show.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { fmtDateTime, ticketNo } from "@/lib/format";
import { phoneText } from "@/lib/estimate-links";
import { shopTimeZone } from "@/lib/shop-zone";
import { Section } from "@/components/ui";

const DAY = 86_400_000;
const stamp = (d: Date, tz: string) => fmtDateTime(d, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ (AM|PM)$/, (m) => m.toLowerCase());
const dayOf = (d: Date, tz: string) => fmtDateTime(d, tz, { month: "short", day: "numeric" });

type Ref = { label: string; href: string; name: string | null; phone: string | null; waiting: boolean };

export async function EstimatesTodoSlot({ user }: { user: CurrentUser }) {
  const shopId = user.shopId;
  const now = new Date().getTime();
  const [answered, sent] = await Promise.all([
    db.estimateLink.findMany({ where: { shopId, answer: { not: null }, answeredAt: { gte: new Date(now - 3 * DAY) } }, orderBy: { answeredAt: "desc" }, take: 10 }),
    db.outMessage.findMany({
      where: { shopId, kind: "estimate", status: "SENT", createdAt: { gte: new Date(now - 30 * DAY) }, OR: [{ ticketId: { not: null } }, { repairJobId: { not: null } }] },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { ticketId: true, repairJobId: true, channel: true, createdAt: true, sentAt: true },
    }),
  ]);
  if (!answered.length && !sent.length) return null;

  // The tickets and jobs these are about (by id and shop), and which of them still wait for an answer.
  const ticketIds = [...new Set([...answered.map((a) => a.ticketId), ...sent.map((m) => m.ticketId)].filter((x): x is string => !!x))];
  const jobIds = [...new Set([...answered.map((a) => a.repairJobId), ...sent.map((m) => m.repairJobId)].filter((x): x is string => !!x))];
  const [tickets, jobs, tz] = await Promise.all([
    ticketIds.length ? db.ticket.findMany({ where: { shopId, id: { in: ticketIds } }, select: { id: true, number: true, status: true, customer: { select: { name: true, phone: true } } } }) : Promise.resolve([]),
    jobIds.length ? db.repairJob.findMany({ where: { shopId, id: { in: jobIds }, side: "retail" }, select: { id: true, tag: true, status: true, approval: true, customerName: true, customer: { select: { name: true, phone: true } } } }) : Promise.resolve([]),
    shopTimeZone(shopId),
  ]);
  const refs = new Map<string, Ref>();
  for (const t of tickets) refs.set(`t:${t.id}`, { label: `Ticket ${ticketNo(t.number)}`, href: `/tickets/${t.id}`, name: t.customer?.name ?? null, phone: t.customer?.phone ?? null, waiting: t.status === "WAITING_CUSTOMER_OK" });
  for (const j of jobs) refs.set(`j:${j.id}`, { label: `Tag ${j.tag}`, href: `/repairs/${j.id}`, name: j.customer?.name ?? j.customerName, phone: j.customer?.phone ?? null, waiting: j.status === "WAITING_CUSTOMER_OK" && !j.approval });

  const answeredRows = answered.flatMap((a) => {
    const r = refs.get(a.ticketId ? `t:${a.ticketId}` : `j:${a.repairJobId}`);
    return r ? [{ a, r }] : [];
  });

  // One line per ticket / job that still waits: the latest send (and the channels of that send).
  const latest = new Map<string, { at: Date; channels: Set<string> }>();
  for (const m of sent) {
    const k = m.ticketId ? `t:${m.ticketId}` : `j:${m.repairJobId}`;
    if (!refs.get(k)?.waiting) continue;
    const at = m.sentAt ?? m.createdAt;
    const cur = latest.get(k);
    if (!cur) latest.set(k, { at, channels: new Set([m.channel]) });
    else if (Math.abs(cur.at.getTime() - at.getTime()) < 60_000) cur.channels.add(m.channel);
  }
  const waitingRows = [...latest.entries()].map(([k, v]) => ({ k, r: refs.get(k)!, ...v })).slice(0, 20);
  if (!answeredRows.length && !waitingRows.length) return null;

  return (
    <Section title="Estimates">
      <div className="space-y-4 text-sm">
        {answeredRows.length > 0 && (
          <div>
            <div className="label mb-1">Answered by link</div>
            <ul className="space-y-1">
              {answeredRows.map(({ a, r }) => (
                <li key={a.id}>
                  <Link href={r.href} className="link">
                    {r.label}
                  </Link>
                  : {a.answer === "APPROVED" ? "approved" : "declined"} {a.answeredAt ? stamp(a.answeredAt, tz) : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {waitingRows.length > 0 && (
          <div>
            <div className="label mb-1">Waiting on an answer</div>
            <ul className="space-y-1">
              {waitingRows.map(({ k, r, at, channels }) => {
                const old = now - at.getTime() >= 2 * DAY;
                const how = channels.has("sms") && channels.has("email") ? "text and email" : channels.has("sms") ? "text" : "email";
                return (
                  <li key={k}>
                    <Link href={r.href} className="link">
                      {r.label}
                    </Link>
                    : {old ? `no answer in ${Math.floor((now - at.getTime()) / DAY)} days: call ${r.name ?? "the customer"}${r.phone ? ` at ${phoneText(r.phone)}` : ""}` : `estimate sent by ${how} ${dayOf(at, tz)}, no answer yet`}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
