// A company's own records as CSV (Settings -> Your data): customers, inventory, register sales, repair tickets with
// their lines, machines, repair payments, model notes and repairs sent out. Owner or admin only. This is what a shop
// takes with it if it moves to its own install or another system. Dates and times are the shop's own (Settings -> Shop
// time zone), as "YYYY-MM-DD HH:MM", which spreadsheets read as a date.
import { db } from "@/lib/db";
import { sessionUser } from "@/lib/session";
import { csvResponse } from "@/lib/csv";
import { lineNet, type Tender } from "@/lib/register-math";
import { lineTotal, ticketTotals } from "@/lib/ticket-math";
import { PAYMENT_LABEL, STATUS_LABEL } from "@/lib/constants";
import { dateIn, dateTimeIn, todayIn } from "@/lib/time-zone";
import { shopTimeZone } from "@/lib/shop-zone";

const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

async function rows(shopId: string, what: string, tz: string): Promise<unknown[][] | null> {
  const at = (d: Date | null | undefined) => dateTimeIn(d, tz);
  const day = (d: Date | null | undefined) => (d ? dateIn(d, tz) : "");
  switch (what) {
    case "customers": {
      const cs = await db.customer.findMany({ where: { shopId }, orderBy: { name: "asc" } });
      return [
        ["name", "kind", "phone", "email", "address", "code", "commission_pct", "notes", "created"],
        ...cs.map((c) => [c.name, c.kind, c.phone, c.email, c.address, c.code, c.commissionPct, c.notes, at(c.createdAt)]),
      ];
    }
    case "inventory": {
      const ps = await db.part.findMany({ where: { shopId }, orderBy: { partNumber: "asc" } });
      return [
        ["number", "other_numbers", "description", "kind", "brand", "unit", "on_hand", "reorder_at", "bin", "cost", "price", "partner_price", "supplier", "consigned"],
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
        ]),
      ];
    }
    case "register-sales": {
      const sales = await db.sale.findMany({ where: { shopId }, include: { lines: true, customer: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
      // One row per line; the sale-level columns (sale_discount = a "Discount on sale" on top of the line discounts, sale_tax,
      // sale_total, paid_by, change) repeat on each of its rows, so sum(line_total) - sale_discount + sale_tax = sale_total.
      const out: unknown[][] = [
        ["sale", "date", "status", "customer", "item_number", "description", "qty", "unit_price", "line_discount", "line_total", "taxable", "sale_discount", "sale_tax", "sale_total", "paid_by", "change", "voided_at"],
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
          ]);
        }
      }
      return out;
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
        },
        orderBy: { number: "asc" },
      });
      // One row per line; the ticket's own columns repeat on each (a ticket with no lines still gets one row).
      const out: unknown[][] = [
        ["ticket", "status", "taken_in", "ready", "closed", "warranty_until", "customer", "phone", "via_account", "brand", "model", "serial", "tech", "service_requested", "problem", "diagnosis", "work_done", "accessories", "upper_found_g", "upper_left_g", "bobbin_found_g", "bobbin_left_g", "readings", "notes", "line_kind", "line_description", "qty", "unit_price", "line_total", "taxable", "ticket_tax", "ticket_total", "ticket_paid"],
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
        const money = [dollars(tot.tax), dollars(tot.total), dollars(tot.paid)];
        if (!t.lines.length) out.push([...head, "", "", "", "", "", "", ...money]);
        for (const l of t.lines) {
          out.push([...head, l.kind, l.description, l.qty, dollars(l.unitPriceCents), dollars(lineTotal(l)), l.taxable ? "yes" : "no", ...money]);
        }
      }
      return out;
    }
    case "machines": {
      const ms = await db.machine.findMany({
        where: { shopId },
        include: { customer: true, tickets: { select: { number: true, intakeAt: true }, orderBy: { intakeAt: "asc" } } },
        orderBy: [{ brand: "asc" }, { model: "asc" }, { serial: "asc" }],
      });
      return [
        ["brand", "model", "serial", "type", "customer", "phone", "notes", "first_seen", "tickets", "last_in"],
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
  const day = todayIn(tz);
  return csvResponse(data, `${what}_${day}.csv`);
}
