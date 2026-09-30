import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime, money } from "@/lib/format";
import { barcodeSvg } from "@/lib/barcode";
import { lineNet, qtyText, TENDER_LABEL, type Tender } from "@/lib/register-math";
import { PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { ActionForm, Submit } from "@/components/action-form";
import { voidSale } from "@/actions/register";

/** A register receipt, narrow enough for an 80 mm receipt printer and fine on letter paper. */
export default async function Receipt({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sale = await db.sale.findFirst({
    where: { id, shopId: user.shopId },
    include: { lines: true, customer: { select: { name: true } }, user: { select: { name: true } }, shop: true },
  });
  if (!sale) notFound();
  const shop = sale.shop;
  const svg = barcodeSvg(`S${sale.number}`, 7);
  const tenders = sale.tenders as Tender[];
  // Clock times in the shop's zone: a hosted install's server runs on UTC, which would put an evening sale on tomorrow's date.
  const when = (d: Date, opts?: Intl.DateTimeFormatOptions) => fmtDateTime(d, shop.timeZone, opts);

  return (
    <div className="space-y-4">
      <PageHeader back={{ href: "/register/sales", label: "Sales" }} title={`Sale #${sale.number}`} actions={<PrintButton />} />
      {sale.status === "VOIDED" && (
        <p className="pill tone-bad" role="status">
          Void{sale.voidedAt ? ` since ${when(sale.voidedAt)}` : ""}
        </p>
      )}
      <div className="receipt card card-pad mx-auto max-w-sm font-mono text-sm">
        <div className="text-center">
          <div className="text-base font-bold">{shop.name}</div>
          {shop.address && <div>{shop.address}</div>}
          {shop.phone && <div>{shop.phone}</div>}
        </div>
        <div className="my-2 border-t border-dashed border-line" />
        <div className="flex justify-between">
          <span>Sale #{sale.number}</span>
          <span>{when(sale.createdAt, { month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" })}</span>
        </div>
        {sale.customer && <div>Customer: {sale.customer.name}</div>}
        {sale.user && <div>Served by: {sale.user.name}</div>}
        <div className="my-2 border-t border-dashed border-line" />
        <ul className="space-y-1">
          {sale.lines.map((l) => (
            <li key={l.id}>
              <div>{l.description}</div>
              <div className="flex justify-between">
                <span>
                  {qtyText(l.qty, l.unit)} @ {money(l.unitPriceCents)}
                  {l.discountCents ? ` less ${money(l.discountCents)}` : ""}
                  {l.taxable ? "" : " (no tax)"}
                </span>
                <span>{money(lineNet(l))}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="my-2 border-t border-dashed border-line" />
        <Line k="Subtotal" v={money(sale.subtotalCents)} />
        {sale.discountCents > 0 && <Line k="Discount" v={`-${money(sale.discountCents)}`} />}
        <Line k={`Tax ${sale.taxRatePct}%`} v={money(sale.taxCents)} />
        <div className="flex justify-between text-base font-bold">
          <span>{sale.totalCents < 0 ? "REFUND" : "TOTAL"}</span>
          <span>{money(Math.abs(sale.totalCents))}</span>
        </div>
        {tenders.map((t, i) => (
          <Line key={i} k={TENDER_LABEL[t.method] ?? t.method} v={money(t.amountCents)} />
        ))}
        {sale.changeCents > 0 && <Line k="Change" v={money(sale.changeCents)} />}
        {svg && <div className="mx-auto mt-3 w-48" dangerouslySetInnerHTML={{ __html: svg }} />}
        {shop.receiptNote && <p className="mt-2 text-center text-xs whitespace-pre-line">{shop.receiptNote}</p>}
        <p className="mt-2 text-center text-xs">Thank you!</p>
      </div>
      {sale.status !== "VOIDED" && user.role !== "TECH" && (
        <ActionForm action={voidSale.bind(null, sale.id)} className="no-print mx-auto flex max-w-sm flex-wrap items-end gap-2" success="Sale voided">
          <div className="field flex-1">
            <label htmlFor="reason" className="label">
              Void this sale (rung up by mistake)
            </label>
            <input id="reason" name="reason" className="input" placeholder="Reason" />
          </div>
          <Submit className="btn btn-danger btn-sm">Void sale</Submit>
        </ActionForm>
      )}
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}
