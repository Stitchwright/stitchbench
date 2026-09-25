// A company's own records as CSV (Settings -> Your data): customers, inventory, register sales, repairs sent out.
// Owner or admin only. This is what a shop takes with it if it moves to its own install or another system.
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { lineNet, type Tender } from "@/lib/register-math";

function csv(v: unknown): string {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

async function rows(shopId: string, what: string): Promise<unknown[][] | null> {
  switch (what) {
    case "customers": {
      const cs = await db.customer.findMany({ where: { shopId }, orderBy: { name: "asc" } });
      return [
        ["name", "kind", "phone", "email", "address", "code", "commission_pct", "notes", "created"],
        ...cs.map((c) => [c.name, c.kind, c.phone, c.email, c.address, c.code, c.commissionPct, c.notes, c.createdAt]),
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
      const out: unknown[][] = [["sale", "date", "status", "customer", "item_number", "description", "qty", "unit_price", "line_discount", "line_total", "taxable", "sale_tax", "sale_total", "paid_by"]];
      for (const s of sales) {
        const paid = (s.tenders as Tender[]).map((t) => `${t.method} ${dollars(t.amountCents)}`).join(" + ");
        for (const l of s.lines) {
          out.push([s.number, s.createdAt, s.status, s.customer?.name, l.partNumber, l.description, l.qty, dollars(l.unitPriceCents), dollars(l.discountCents), dollars(lineNet(l)), l.taxable ? "yes" : "no", dollars(s.taxCents), dollars(s.totalCents), paid]);
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
          j.createdAt,
          dollars(j.totalCents),
          dollars(j.commissionCents),
          dollars(j.paidCents),
          j.paidWhere,
          j.pickedUpAt,
        ]),
      ];
    }
    default:
      return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ what: string }> }) {
  const session = await auth();
  const shopId = session?.user?.shopId;
  if (!shopId) return new Response("Sign in first.", { status: 401 });
  if (session.user.role === "TECH") return new Response("Only the owner or an admin can download the shop's records.", { status: 403 });
  const { what } = await params;
  const data = await rows(shopId, what);
  if (!data) return new Response("Unknown export.", { status: 404 });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(data.map((r) => r.map(csv).join(",")).join("\n") + "\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${what}_${day}.csv"` },
  });
}
