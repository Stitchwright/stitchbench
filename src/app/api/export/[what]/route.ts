// A company's own records as CSV (Settings -> Your data): customers, inventory, register sales, repair tickets with
// their lines, machines, repair payments, model notes and repairs sent out. Owner or admin only. This is what a shop
// takes with it if it moves to its own install or another system. Dates and times are the shop's own (Settings -> Shop
// time zone), as "YYYY-MM-DD HH:MM", which spreadsheets read as a date.
import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { csvResponse } from "@/lib/csv";
import { lineNet, type Tender } from "@/lib/register-math";
import { lineTotal, ticketTotals } from "@/lib/ticket-math";
import { CONDITION_NAME, ORIGIN_NAME } from "@/lib/part-labels";
import { PAYMENT_LABEL, STATUS_LABEL, UNIT_CONDITION_LABEL, UNIT_STATUS_LABEL } from "@/lib/constants";
import { dateIn, dateTimeIn, todayIn } from "@/lib/time-zone";
import { shopTimeZone } from "@/lib/shop-zone";
import { actorOf, audit } from "@/lib/audit";
import { auditLabel } from "@/lib/audit-list";

/** The shop's users by id, for "by" columns. */
async function userNames(shopId: string) {
  return new Map((await db.user.findMany({ where: { shopId }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
/** A JSON column (check-in answers, readings) as text; an empty object is an empty cell. */
const json = (v: unknown) => (v && typeof v === "object" && Object.keys(v).length ? JSON.stringify(v) : "");

async function rows(shopId: string, what: string, tz: string): Promise<unknown[][] | null> {
  const at = (d: Date | null | undefined) => dateTimeIn(d, tz);
  const day = (d: Date | null | undefined) => (d ? dateIn(d, tz) : "");
  switch (what) {
    case "customers": {
      const cs = await db.customer.findMany({ where: { shopId }, orderBy: { name: "asc" } });
      return [
        ["name", "kind", "phone", "email", "address", "code", "commission_pct", "notes", "created", "notify_by", "text_consent_at", "text_consent_phone", "text_consent_source"],
        ...cs.map((c) => [c.name, c.kind, c.phone, c.email, c.address, c.code, c.commissionPct, c.notes, at(c.createdAt), c.notifyBy, at(c.smsConsentAt), c.smsConsentPhone, c.smsConsentSource]),
      ];
    }
    case "audit": {
      const es = await db.auditEntry.findMany({ where: { shopId }, orderBy: [{ at: "asc" }, { id: "asc" }] });
      return [
        ["when", "who", "role", "actor", "category", "action", "what", "subject_type", "subject", "amount", "changes", "reason", "address"],
        ...es.map((e) => [at(e.at), e.userName, e.role, e.actor, e.category, e.action, auditLabel(e.action), e.subjectType, e.subjectLabel, dollars(e.amountCents), json(e.changes), e.reason, e.ip]),
      ];
    }
    case "inventory": {
      const ps = await db.part.findMany({ where: { shopId }, orderBy: { partNumber: "asc" } });
      return [
        ["number", "other_numbers", "description", "kind", "brand", "unit", "on_hand", "reorder_at", "bin", "cost", "price", "partner_price", "supplier", "consigned", "condition", "made_by", "shop_number"],
        ...ps.map((p) => [
          p.partNumber,
          p.altNumbers.join(" "),
          p.description,
          p.kind,
          p.brand,
          p.unit ?? "each",
          p.qtyOnHand,
          p.reorderAt,
          p.location,
          dollars(p.costCents),
          dollars(p.priceCents),
          dollars(p.wholesaleCents),
          p.supplier,
          p.consignLinkId ? "yes" : "",
          CONDITION_NAME[p.condition],
          ORIGIN_NAME[p.origin],
          // The number the shop gave an item the maker gave none (it is also in "number").
          p.ownNumber ? p.partNumber : "",
        ]),
      ];
    }
    case "register-sales": {
      const sales = await db.sale.findMany({ where: { shopId }, include: { lines: true, customer: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
      // for_machine: the customer's vacuum a bag, belt or filter was bought for (Vac Shop), in one query for every line.
      const machineIds = [...new Set(sales.flatMap((s) => s.lines.map((l) => l.machineId)).filter((id): id is string => !!id))];
      const forMachine = new Map(
        (machineIds.length ? await db.machine.findMany({ where: { id: { in: machineIds }, shopId }, select: { id: true, brand: true, model: true } }) : []).map((m) => [m.id, `${m.brand} ${m.model}`]),
      );
      // One row per line; the sale-level columns (sale_discount = a "Discount on sale" on top of the line discounts, sale_tax,
      // sale_total, paid_by, change) repeat on each of its rows, so sum(line_total) - sale_discount + sale_tax = sale_total.
      // for: what a line paid for besides goods: a class seat, an appointment or a partner repair (plain ids).
      const out: unknown[][] = [
        ["sale", "date", "status", "customer", "item_number", "description", "qty", "unit_price", "line_discount", "line_total", "taxable", "sale_discount", "sale_tax", "sale_total", "paid_by", "change", "voided_at", "for_machine", "for"],
      ];
      for (const s of sales) {
        const paid = (s.tenders as Tender[]).map((t) => `${t.method} ${dollars(t.amountCents)}`).join(" + ");
        for (const l of s.lines) {
          out.push([
            s.number,
            at(s.createdAt),
            s.status,
            s.customer?.name,
            l.partNumber,
            l.description,
            l.qty,
            dollars(l.unitPriceCents),
            dollars(l.discountCents),
            dollars(lineNet(l)),
            l.taxable ? "yes" : "no",
            dollars(s.discountCents),
            dollars(s.taxCents),
            dollars(s.totalCents),
            paid,
            dollars(s.changeCents),
            at(s.voidedAt),
            l.machineId ? (forMachine.get(l.machineId) ?? "") : "",
            l.enrollmentId ? `class:${l.enrollmentId}` : l.appointmentId ? `appointment:${l.appointmentId}` : l.repairJobId ? `repair:${l.repairJobId}` : "",
          ]);
        }
      }
      return out;
    }
    case "messages": {
      // Every email and text (latest 20 000): the proof a notice went out, with the words as stored (estimate links masked).
      const [ms, users] = await Promise.all([
        db.outMessage.findMany({ where: { shopId }, include: { customer: { select: { name: true } }, campaign: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 20_000 }),
        userNames(shopId),
      ]);
      return [
        ["created", "kind", "purpose", "channel", "to", "customer", "status", "sent", "delivery", "subject", "body", "error", "provider_id", "by", "cancelled_by", "ticket", "repair_job", "campaign"],
        ...ms.map((m) => [
          at(m.createdAt),
          m.kind,
          m.purpose,
          m.channel,
          m.address,
          m.customer?.name,
          m.status,
          at(m.sentAt),
          m.deliveryStatus,
          m.subject,
          m.body,
          m.error,
          m.providerId,
          m.byUserId ? (users.get(m.byUserId) ?? m.byUserId) : "",
          m.cancelledById ? (users.get(m.cancelledById) ?? m.cancelledById) : "",
          m.ticketId,
          m.repairJobId,
          m.campaign?.name,
        ]),
      ];
    }
    case "consent": {
      // The consent record (every event, oldest first), a blank row, then who is opted out now.
      const [events, sups, users] = await Promise.all([
        db.consentEvent.findMany({ where: { shopId }, include: { customer: { select: { name: true } } }, orderBy: { at: "asc" } }),
        db.suppression.findMany({ where: { shopId }, orderBy: { at: "asc" } }),
        userNames(shopId),
      ]);
      return [
        ["at", "customer", "channel", "event", "address", "source", "detail", "by"],
        ...events.map((e) => [at(e.at), e.customer?.name, e.channel, e.event, e.address, e.source, e.detail, e.byUserId ? (users.get(e.byUserId) ?? e.byUserId) : ""]),
        [],
        ["suppression: channel", "address", "scope", "source", "at"],
        ...sups.map((s) => [s.channel, s.address, s.scope, s.source, at(s.at)]),
      ];
    }
    case "campaigns": {
      const cs = await db.campaign.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } });
      const counts = cs.length ? await db.outMessage.groupBy({ by: ["campaignId", "status"], where: { shopId, campaignId: { in: cs.map((c) => c.id) } }, _count: { _all: true } }) : [];
      const count = (id: string, status: string) => counts.find((r) => r.campaignId === id && r.status === status)?._count._all ?? 0;
      const skipped = (v: unknown) => (v && typeof v === "object" ? Object.entries(v as Record<string, number>).map(([r, n]) => `${r} ${n}`).join("; ") : "");
      return [
        ["created", "name", "channel", "status", "queued_at", "recipients", "sent", "failed", "skipped"],
        ...cs.map((c) => [at(c.createdAt), c.name, c.channel, c.status, at(c.queuedAt), c.recipients, count(c.id, "SENT"), count(c.id, "FAILED"), skipped(c.skipped)]),
      ];
    }
    case "classes": {
      // One row per sign-up (the roster), with the class's first meeting.
      const es = await db.enrollment.findMany({
        where: { shopId },
        include: { shopClass: { select: { title: true, firstAt: true } }, customer: { select: { name: true, phone: true, email: true } } },
        orderBy: [{ shopClass: { firstAt: "asc" } }, { createdAt: "asc" }],
      });
      return [
        ["class", "first_meeting", "customer", "attendee", "phone", "email", "status", "fee", "paid", "paid_at", "refunded"],
        ...es.map((e) => [e.shopClass.title, at(e.shopClass.firstAt), e.customer?.name ?? e.name, e.attendee, e.customer?.phone, e.customer?.email, e.status, dollars(e.feeCents), dollars(e.paidCents), at(e.paidAt), dollars(e.refundedCents)]),
      ];
    }
    case "appointments": {
      const as = await db.appointment.findMany({
        where: { shopId },
        include: { type: { select: { name: true } }, customer: { select: { name: true, phone: true } }, staff: { select: { name: true } } },
        orderBy: { startsAt: "asc" },
      });
      return [
        ["starts", "ends", "type", "resource", "customer", "phone", "status", "staff", "fee", "paid", "paid_at", "blocked"],
        ...as.map((a) => [at(a.startsAt), at(a.endsAt), a.type?.name ?? a.title, a.resource, a.customer?.name ?? a.name, a.customer?.phone, a.status, a.staff?.name, dollars(a.feeCents), dollars(a.paidCents), at(a.paidAt), a.blocked ? "yes" : ""]),
      ];
    }
    case "shifts": {
      const ss = await db.shift.findMany({ where: { shopId }, orderBy: { startsAt: "asc" } });
      const clock = (d: Date) => at(d).slice(11);
      return [["date", "start", "end", "person", "role", "note"], ...ss.map((s) => [day(s.startsAt), clock(s.startsAt), clock(s.endsAt), s.name, s.role, s.note])];
    }
    case "repairs": {
      const jobs = await db.repairJob.findMany({ where: { shopId }, include: { customer: true }, orderBy: { createdAt: "asc" } });
      return [
        ["tag", "side", "status", "customer", "phone", "brand", "model", "serial", "problem", "taken_in", "bill", "commission", "paid", "paid_where", "picked_up"],
        ...jobs.map((j) => [
          j.tag,
          j.side,
          j.status,
          j.customer?.name ?? j.customerName,
          j.customer?.phone,
          j.brand,
          j.model,
          j.serial,
          j.problem,
          at(j.createdAt),
          dollars(j.totalCents),
          dollars(j.commissionCents),
          dollars(j.paidCents),
          j.paidWhere,
          at(j.pickedUpAt),
        ]),
      ];
    }
    case "tickets": {
      const ts = await db.ticket.findMany({
        where: { shopId },
        include: {
          lines: { orderBy: { createdAt: "asc" } },
          payments: true,
          machine: true,
          customer: true,
          viaAccount: true,
          tech: { select: { name: true } },
          site: true,
          waits: { orderBy: { orderedAt: "asc" } },
        },
        orderBy: { number: "asc" },
      });
      // One row per line; the ticket's own columns repeat on each (a ticket with no lines still gets one row). The
      // module columns come last so older spreadsheets keep working: job_type (BENCH or a SITE install), kind, the
      // install's address, and the kind's check-in answers (the unit's and this visit's) and readings as JSON text.
      const out: unknown[][] = [
        ["ticket", "status", "taken_in", "ready", "closed", "warranty_until", "customer", "phone", "via_account", "brand", "model", "serial", "tech", "service_requested", "problem", "diagnosis", "work_done", "accessories", "upper_found_g", "upper_left_g", "bobbin_found_g", "bobbin_left_g", "readings", "notes", "line_kind", "line_description", "qty", "unit_price", "line_total", "taxable", "ticket_tax", "ticket_total", "ticket_paid", "job_type", "kind", "site_address", "details", "intake", "kind_readings", "parts_waiting", "parts_received"],
      ];
      for (const t of ts) {
        const tot = ticketTotals(t.lines, t.payments, t.taxRatePct);
        const head = [
          t.number,
          STATUS_LABEL[t.status],
          at(t.intakeAt),
          at(t.readyAt),
          at(t.closedAt),
          day(t.warrantyUntil),
          t.customer?.name,
          t.customer?.phone,
          t.viaAccount?.code ?? t.viaAccount?.name,
          t.machine.brand,
          t.machine.model,
          t.machine.serial,
          t.tech?.name,
          t.serviceRequested,
          t.problem,
          t.diagnosis,
          t.workDone,
          t.accessories.join("; "),
          t.upperFoundG,
          t.upperLeftG,
          t.bobbinFoundG,
          t.bobbinLeftG,
          Object.keys((t.measurements as object) ?? {}).length ? JSON.stringify(t.measurements) : "",
          t.notes,
        ];
        // Parts on order for it ("description x qty (supplier)"), and the ones that came in.
        const waitWords = (w: { description: string; qty: number; supplier: string | null }) => `${w.description}${w.qty !== 1 ? ` x ${w.qty}` : ""}${w.supplier ? ` (${w.supplier})` : ""}`;
        const money = [
          dollars(tot.tax),
          dollars(tot.total),
          dollars(tot.paid),
          t.jobType,
          t.machine.kind,
          t.site?.address ?? "",
          json(t.machine.details),
          json(t.intake),
          json(t.readings),
          t.waits.filter((w) => !w.receivedAt && !w.cancelledAt).map(waitWords).join("; "),
          t.waits.filter((w) => w.receivedAt).map(waitWords).join("; "),
        ];
        if (!t.lines.length) out.push([...head, "", "", "", "", "", "", ...money]);
        for (const l of t.lines) {
          out.push([...head, l.kind, l.description, l.qty, dollars(l.unitPriceCents), dollars(lineTotal(l)), l.taxable ? "yes" : "no", ...money]);
        }
      }
      return out;
    }
    case "part-waits": {
      // Every part a ticket waited for: on order, received or cancelled, with its dates and who was told.
      const ws = await db.partWait.findMany({ where: { shopId }, include: { ticket: { select: { number: true, customer: { select: { name: true } } } }, part: { select: { partNumber: true } } }, orderBy: { orderedAt: "asc" } });
      return [
        ["ticket", "customer", "part_number", "description", "qty", "supplier", "ordered", "expected", "received", "received_by", "customer_told", "cancelled", "note"],
        ...ws.map((w) => [w.ticket.number, w.ticket.customer?.name, w.part?.partNumber, w.description, w.qty, w.supplier, at(w.orderedAt), w.expectedOn, at(w.receivedAt), w.receivedBy, at(w.noticedAt), at(w.cancelledAt), w.note]),
      ];
    }
    case "web-orders": {
      // Every online order, oldest first: the customer as the order took it, the items as sold ("description (number)
      // x qty"), the money, the dates of each step and the sale it was written in the books as.
      const os = await db.webOrder.findMany({ where: { shopId }, orderBy: [{ createdAt: "asc" }, { number: "asc" }] });
      const saleIds = [...new Set(os.map((o) => o.saleId).filter((id): id is string => !!id))];
      const saleNo = new Map((saleIds.length ? await db.sale.findMany({ where: { id: { in: saleIds }, shopId }, select: { id: true, number: true } }) : []).map((s) => [s.id, s.number]));
      type Item = { partNumber: string | null; description: string; qty: number };
      const itemWords = (items: unknown) => (Array.isArray(items) ? (items as Item[]).map((i) => `${i.description}${i.partNumber ? ` (${i.partNumber})` : ""} x ${i.qty}`).join("; ") : "");
      return [
        ["number", "status", "customer", "phone", "email", "fulfil", "address", "items", "subtotal", "shipping", "tax", "total", "refunded", "pay_via", "tax_via", "created", "paid", "ready", "done", "cancelled", "tracking", "sale_number", "note", "staff_note"],
        ...os.map((o) => [
          o.number,
          o.status,
          o.name,
          o.phone,
          o.email,
          o.fulfil,
          o.address,
          itemWords(o.items),
          dollars(o.subtotalCents),
          dollars(o.shipCents),
          dollars(o.taxCents),
          dollars(o.totalCents),
          dollars(o.refundedCents),
          o.payVia,
          o.taxVia,
          at(o.createdAt),
          at(o.paidAt),
          at(o.readyAt),
          at(o.doneAt),
          at(o.cancelledAt),
          o.tracking,
          o.saleId ? (saleNo.get(o.saleId) ?? "") : "",
          o.note,
          o.staffNote,
        ]),
      ];
    }
    case "machines": {
      const ms = await db.machine.findMany({
        where: { shopId },
        include: { customer: true, tickets: { select: { number: true, intakeAt: true }, orderBy: { intakeAt: "asc" } } },
        orderBy: [{ brand: "asc" }, { model: "asc" }, { serial: "asc" }],
      });
      return [
        ["brand", "model", "serial", "type", "customer", "phone", "notes", "first_seen", "tickets", "last_in", "kind", "equipment", "details"],
        ...ms.map((m) => [
          m.brand,
          m.model,
          m.serial,
          m.machineType,
          m.customer?.name,
          m.customer?.phone,
          m.notes,
          at(m.createdAt),
          m.tickets.map((t) => t.number).join(" "),
          at(m.tickets.at(-1)?.intakeAt),
          m.kind,
          m.equipment,
          json(m.details),
        ]),
      ];
    }
    case "vac-units": {
      // Vacuums for sale (Vac Shop): one row per unit, with the sale that sold it and the one that took it in trade.
      const units = await db.stockUnit.findMany({
        where: { shopId },
        include: { machine: { select: { brand: true, model: true, serial: true, customer: { select: { name: true } } } } },
        orderBy: { createdAt: "asc" },
      });
      const lineIds = [...new Set(units.flatMap((u) => [u.soldLineId, u.tradeInLineId]).filter((id): id is string => !!id))];
      const saleNo = new Map(
        (lineIds.length ? await db.saleLine.findMany({ where: { id: { in: lineIds }, sale: { shopId } }, select: { id: true, sale: { select: { number: true } } } }) : []).map((l) => [l.id, l.sale.number]),
      );
      return [
        ["status", "condition", "brand", "model", "serial", "cost", "price", "sold_net", "warranty_months", "warranty_by", "sold", "sale_number", "buyer", "warranty_until", "registered", "registration_ref", "traded_in_on_sale"],
        ...units.map((u) => [
          UNIT_STATUS_LABEL[u.status] ?? u.status,
          UNIT_CONDITION_LABEL[u.condition] ?? u.condition,
          u.machine.brand,
          u.machine.model,
          u.machine.serial,
          dollars(u.costCents),
          dollars(u.priceCents),
          dollars(u.soldNetCents),
          u.warrantyMonths,
          u.warrantyBy,
          at(u.soldAt),
          u.soldLineId ? (saleNo.get(u.soldLineId) ?? "") : "",
          u.soldAt ? u.machine.customer?.name : "",
          day(u.warrantyUntil),
          at(u.registeredAt),
          u.registrationRef,
          u.tradeInLineId ? (saleNo.get(u.tradeInLineId) ?? "") : "",
        ]),
      ];
    }
    case "payments": {
      // Every repair payment, all dates (the sales log's CSV is one date range), bills put on account included.
      const ps = await db.payment.findMany({
        where: { ticket: { shopId } },
        include: { ticket: { include: { customer: true, viaAccount: true, machine: true } } },
        orderBy: { paidAt: "asc" },
      });
      return [
        ["date", "ticket", "customer", "via_account", "brand", "model", "serial", "method", "amount", "note"],
        ...ps.map((p) => [
          at(p.paidAt),
          p.ticket.number,
          p.ticket.customer?.name,
          p.ticket.viaAccount?.code ?? p.ticket.viaAccount?.name,
          p.ticket.machine.brand,
          p.ticket.machine.model,
          p.ticket.machine.serial,
          PAYMENT_LABEL[p.method],
          dollars(p.amountCents),
          p.note,
        ]),
      ];
    }
    case "model-notes": {
      const ns = await db.modelNote.findMany({ where: { shopId }, include: { author: { select: { name: true } } }, orderBy: [{ brand: "asc" }, { modelLabel: "asc" }, { createdAt: "asc" }] });
      return [
        ["brand", "model", "kind", "pinned", "note", "by", "created"],
        ...ns.map((n) => [n.brand, n.modelLabel, n.kind, n.pinned ? "yes" : "", n.body, n.author?.name, at(n.createdAt)]),
      ];
    }
    default:
      return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ what: string }> }) {
  const user = await sessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const shopId = user.shopId;
  if (user.role === "TECH") return new Response("Only the owner or an admin can download the shop's records.", { status: 403 });
  const { what } = await params;
  const tz = await shopTimeZone(shopId);
  const data = await rows(shopId, what, tz);
  if (!data) return new Response("Unknown export.", { status: 404 });
  await audit(db, actorOf(user), { action: "export.download", subjectType: "Export", subjectLabel: what });
  const day = todayIn(tz);
  return csvResponse(data, `${what}_${day}.csv`);
}
