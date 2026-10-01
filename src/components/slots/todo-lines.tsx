// To-do lines for the Dashboard and the register (scheduling-messaging-design.md sections 7.3 and 9.5), styled like
// PartnerTodo; each line only when it applies. Server component.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { ABANDON_STAGE_LABEL } from "@/lib/constants";
import { ticketNo } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { messagingView } from "@/lib/messaging/settings";
import { fmtDay } from "@/lib/zoned";
import { READY_JOB_STATUSES } from "@/lib/notices/hooks";
import { scheduleFor } from "@/lib/notices/vars";
import { markBackAtCounter } from "@/actions/notices";
import { ActionButton } from "@/components/action-form";

const WEEK = 7 * 86_400_000;
const SHOWN = 5;

export async function TodoLinesSlot({ user }: { user: CurrentUser }) {
  const shopId = user.shopId;
  const now = new Date();
  const admin = user.role !== "TECH";
  const [gate, ms, shop] = await Promise.all([
    gateFor(shopId, "marketing"),
    messagingView(shopId),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { timeZone: true, abandonedAfterDays: true } }),
  ]);
  const on = gate === "on";
  const tz = shop.timeZone;
  const lines: { key: string; node: React.ReactNode }[] = [];

  // Marked ready by the repair shop: is it here?
  const back = await db.repairJob.findMany({
    where: { shopId, side: "retail", status: { in: READY_JOB_STATUSES }, backAt: null, pickedUpAt: null },
    orderBy: { updatedAt: "asc" },
    select: { id: true, tag: true, linkId: true },
  });
  if (back.length) {
    const links = await db.partnerLink.findMany({ where: { shopId, id: { in: [...new Set(back.map((j) => j.linkId))] } }, select: { id: true, partnerName: true } });
    const partner = new Map(links.map((l) => [l.id, l.partnerName]));
    for (const j of back.slice(0, SHOWN)) {
      lines.push({
        key: `back-${j.id}`,
        node: (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Link href={`/repairs/${j.id}`} className="link">
              Tag {j.tag}: {partner.get(j.linkId) ?? "the repair shop"} marked it ready. Is it here?
            </Link>
            <ActionButton action={markBackAtCounter.bind(null, j.id)} className="btn btn-sm" success="Recorded">
              {on ? "It's here: tell the customer" : "It's here"}
            </ActionButton>
          </span>
        ),
      });
    }
    if (back.length > SHOWN) {
      lines.push({
        key: "back-more",
        node: (
          <Link href="/repairs" className="link">
            and {back.length - SHOWN} more on Repairs
          </Link>
        ),
      });
    }
  }

  if (gate !== "hidden") {
    const [replies, failed] = await Promise.all([
      db.inboundText.count({ where: { shopId, keyword: null, handledAt: null } }),
      db.outMessage.count({ where: { shopId, status: "FAILED", createdAt: { gte: new Date(now.getTime() - WEEK) } } }),
    ]);
    if (replies) {
      lines.push({
        key: "replies",
        node: (
          <Link href="/messages/replies" className="link">
            {replies} new text {replies === 1 ? "reply" : "replies"}
          </Link>
        ),
      });
    }
    if (failed) {
      lines.push({
        key: "failed",
        node: (
          <Link href="/messages?status=FAILED" className="link">
            {failed} {failed === 1 ? "message" : "messages"} didn&apos;t go out this week
          </Link>
        ),
      });
    }
    if (admin) {
      if (ms.emailPausedAt) lines.push({ key: "email-paused", node: <Link href="/settings/messages" className="link">Email paused: {ms.emailError ?? "see Settings"}</Link> });
      if (ms.smsPausedAt) lines.push({ key: "sms-paused", node: <Link href="/settings/messages" className="link">Texts paused: {ms.smsError ?? "see Settings"}</Link> });
      if (ms.marketingHoldAt) {
        lines.push({
          key: "hold",
          node: (
            <Link href="/messages" className="link">
              Marketing is on hold since the backup was restored: check Opt-outs, then Resume
            </Link>
          ),
        });
      }
    }
  }

  // Uncollected-machine notices that nobody sent (skipped, failed, not delivered, past their window, or Messages is off).
  // A shop with Messages on and the switch off does these by hand by choice: the ticket page still shows the dates.
  if (!on || ms.abandonNotices) {
    const hand = await byHand(shopId, shop.abandonedAfterDays, tz, ms, now, on);
    if (hand.length) {
      lines.push({
        key: "hand",
        node: (
          <details className="inline-block align-top">
            <summary className="link cursor-pointer">
              {hand.length} uncollected-machine {hand.length === 1 ? "notice" : "notices"} to send by hand
            </summary>
            <ul className="mt-1 space-y-0.5">
              {hand.map((h) => (
                <li key={h.key}>
                  <Link href={h.href} className="link">
                    {h.what}
                  </Link>{" "}
                  <span className="muted">
                    {h.stage} was due {h.due}: {h.why}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ),
      });
    }
  }

  if (!lines.length) return null;
  return (
    <div className="card card-pad tone-wait space-y-1">
      {lines.map((l) => (
        <div key={l.key}>{l.node}</div>
      ))}
    </div>
  );
}

type Hand = { key: string; href: string; what: string; stage: string; due: string; why: string };

/** Direct tickets on the shelf and retail jobs back at the counter whose latest due stage nobody got to. */
async function byHand(shopId: string, abandonedAfterDays: number, tz: string, ms: Awaited<ReturnType<typeof messagingView>>, now: Date, marketing: boolean): Promise<Hand[]> {
  const [tickets, jobs] = await Promise.all([
    db.ticket.findMany({
      where: { shopId, status: "READY_FOR_PICKUP", pickupReadyAt: { not: null }, customerId: { not: null }, viaAccountId: null, jobType: "BENCH" },
      select: { id: true, number: true, pickupReadyAt: true, customer: { select: { name: true } }, machine: { select: { brand: true, model: true } } },
      take: 300,
    }),
    db.repairJob.findMany({
      where: { shopId, side: "retail", customerId: { not: null }, pickedUpAt: null, backAt: { not: null } },
      select: { id: true, tag: true, backAt: true, linkId: true, brand: true, model: true, customer: { select: { name: true } } },
      take: 300,
    }),
  ]);
  const partner = tickets.length ? await db.repairJob.findMany({ where: { shopId, ticketId: { in: tickets.map((t) => t.id) } }, select: { ticketId: true } }) : [];
  const skip = new Set(partner.map((p) => p.ticketId));
  const own = tickets.filter((t) => !skip.has(t.id));
  const links = jobs.length ? await db.partnerLink.findMany({ where: { shopId, id: { in: [...new Set(jobs.map((j) => j.linkId))] } }, select: { id: true, terms: true } }) : [];
  const terms = new Map(links.map((l) => [l.id, (l.terms as { abandonedAfterDays?: unknown } | null)?.abandonedAfterDays]));
  if (!own.length && !jobs.length) return [];
  const rows = await db.outMessage.findMany({
    where: { shopId, kind: "abandon", refType: "stage", OR: [{ ticketId: { in: own.map((t) => t.id) } }, { repairJobId: { in: jobs.map((j) => j.id) } }] },
    orderBy: { createdAt: "asc" },
  });
  const out: Hand[] = [];
  const consider = (key: string, href: string, what: string, start: Date, days: number, mine: typeof rows) => {
    const { stages } = scheduleFor(start, days, tz, ms, now, mine);
    const due = stages.filter((s) => s.stage.due.getTime() <= now.getTime());
    const latest = due.at(-1);
    if (!latest) return;
    let reason: string | null = null;
    if (latest.state === "past") reason = "past the notice window, decide by hand";
    else if (latest.state === "not_sent") reason = "it didn't go out";
    else if (latest.state === "undelivered") reason = "the text wasn't delivered";
    else if (latest.state === "due" && !marketing) reason = "Messages is off";
    if (!reason) return;
    out.push({ key, href, what, stage: ABANDON_STAGE_LABEL[latest.stage.key], due: fmtDay(latest.stage.due, tz), why: reason });
  };
  for (const t of own) {
    if (t.pickupReadyAt) consider(`t-${t.id}`, `/tickets/${t.id}`, `Ticket ${ticketNo(t.number)} · ${t.customer?.name ?? ""} · ${t.machine.brand} ${t.machine.model}`, t.pickupReadyAt, abandonedAfterDays, rows.filter((r) => r.ticketId === t.id));
  }
  for (const j of jobs) {
    const d = terms.get(j.linkId);
    if (j.backAt) consider(`j-${j.id}`, `/repairs/${j.id}`, `Tag ${j.tag} · ${j.customer?.name ?? ""} · ${j.brand} ${j.model}`, j.backAt, typeof d === "number" && Number.isInteger(d) && d > 0 ? d : abandonedAfterDays, rows.filter((r) => r.repairJobId === j.id));
  }
  return out;
}
