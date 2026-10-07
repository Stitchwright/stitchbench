import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime, money } from "@/lib/format";
import { barcodeSvg } from "@/lib/barcode";
import { lineNet, qtyText, TENDER_LABEL, type Tender } from "@/lib/register-math";
import { HistoryLink } from "@/components/history-link";
import { PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { ActionForm, Submit } from "@/components/action-form";
import { SaleUnitNotes } from "@/components/units/sale-unit-notes";
import { SaleSoftwareNotes } from "@/components/sale-software-notes";
import { voidSale } from "@/actions/register";
import { lastFour } from "@/lib/gift-card-number";
import { holidayNames } from "@/lib/tax-holidays";
import { listLenders } from "@/lib/financing";
import { promotionNames } from "@/lib/promotions";
import { includedTax } from "@/lib/promo-math";

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
  // Cards this sale sold, loaded or gave as store credit: their numbers print on the receipt (the gift slip).
  const cardEntries = await db.giftCardEntry.findMany({
    where: { shopId: user.shopId, saleId: sale.id, reason: { in: ["SOLD", "LOADED", "REFUNDED_TO"] } },
    include: { card: true },
    orderBy: { at: "asc" },
  });
  const svg = barcodeSvg(`S${sale.number}`, 7);
  // A machine sold here: the shop's lenders' "apply now" pages print under the payments (financing, section 5).
  const apply = sale.lines.some((l) => l.stockUnitId && l.qty > 0) ? (await listLenders(user.shopId, true)).filter((l) => l.applyUrl) : [];
  // A promotion's name under the line it priced.
  const promos = await promotionNames(
    user.shopId,
    sale.lines.map((l) => l.promotionId),
  );
  // Lines sold on a sales tax holiday print its name.
  const holidays = await holidayNames(
    user.shopId,
    sale.lines.map((l) => l.taxNote),
  );
  const tenders = sale.tenders as Tender[];
  // Clock times in the shop's zone: a hosted install's server runs on UTC, which would put an evening sale on tomorrow's date.
  const when = (d: Date, opts?: Intl.DateTimeFormatOptions) => fmtDateTime(d, shop.timeZone, opts);

  return (
    <div className="space-y-4">
      <PageHeader back={{ href: "/register/sales", label: "Sales" }} title={`Sale #${sale.number}`} actions={
          <>
            <HistoryLink role={user.role} type="Sale" id={sale.id} />
            <PrintButton />
          </>
        } />
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
              {l.promotionId && promos.get(l.promotionId) && <div className="text-xs">{promos.get(l.promotionId)}</div>}
              {l.taxNote === "included" && <div className="text-xs">Price includes {money(includedTax(lineNet(l), sale.taxRatePct))} sales tax</div>}
              <div className="flex justify-between">
                <span>
                  {qtyText(l.qty, l.unit)} @ {money(l.unitPriceCents)}
                  {l.discountCents ? ` less ${money(l.discountCents)}` : ""}
                  {l.taxable ? "" : l.taxNote?.startsWith("holiday:") ? " (tax holiday)" : " (no tax)"}
                </span>
                <span>{money(lineNet(l))}</span>
              </div>
            </li>
          ))}
        </ul>
        <SaleUnitNotes saleId={sale.id} shopId={user.shopId} />
        <SaleSoftwareNotes saleId={sale.id} shopId={user.shopId} />
        <div className="my-2 border-t border-dashed border-line" />
        <Line k="Subtotal" v={money(sale.subtotalCents)} />
        {sale.discountCents > 0 && <Line k="Discount" v={`-${money(sale.discountCents)}`} />}
        <Line k={sale.taxExemptId ? `Tax exempt (certificate ${sale.taxExemptId})` : `Tax ${sale.taxRatePct}%`} v={money(sale.taxCents)} />
        {[...holidays.values()].map((name) => (
          <div key={name} className="text-xs">
            No sales tax on the items marked: {name}.
          </div>
        ))}
        <div className="flex justify-between text-base font-bold">
          <span>{sale.totalCents < 0 ? "REFUND" : "TOTAL"}</span>
          <span>{money(Math.abs(sale.totalCents))}</span>
        </div>
        {tenders.map((t, i) => (
          <div key={i}>
            <Line k={`${TENDER_LABEL[t.method] ?? t.method}${t.lender ? ` by ${t.lender}` : ""}${t.method === "FINANCED" && t.note ? `, approval ${t.note}` : ""}${t.last4 ? ` ending ${t.last4}` : ""}`} v={money(t.amountCents)} />
            {t.leftCents != null && <div className="text-right text-xs">{t.amountCents < 0 ? "Now holds" : "Left on it"} {money(t.leftCents)}</div>}
          </div>
        ))}
        {sale.changeCents > 0 && <Line k="Change" v={money(sale.changeCents)} />}
        {apply.length > 0 && (
          <div className="mt-2 text-xs">
            Financing available:{" "}
            {apply.map((l) => `${l.name} ${l.applyUrl}`).join("; ")}
          </div>
        )}
        {cardEntries.map((e) => {
          const credit = e.card.kind === "credit";
          // A slip with no customer behind it carries its whole number; a customer's credit and a loaded card show the end.
          const showNumber = e.reason === "SOLD" || (credit && !e.card.customerId);
          const bars = showNumber ? barcodeSvg(e.card.number, 7) : null;
          return (
            <div key={e.id} className="mt-3 border-t border-dashed border-line pt-2 text-center">
              <div className="font-bold">
                {credit ? "Store credit" : "Gift card"} {e.reason === "LOADED" ? "loaded" : e.reason === "SOLD" ? "" : "given"} {money(e.amountCents)}
              </div>
              {showNumber ? <div className="mono font-bold">{e.card.number}</div> : <div>ending {lastFour(e.card.number)}</div>}
              {bars && <div className="mx-auto mt-1 w-48" dangerouslySetInnerHTML={{ __html: bars }} />}
              {e.reason !== "SOLD" && <div className="text-xs">Balance now {money(e.card.balanceCents)}</div>}
              <div className="text-xs">Never expires. No fees.</div>
            </div>
          );
        })}
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
