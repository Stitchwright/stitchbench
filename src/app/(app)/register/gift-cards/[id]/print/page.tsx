import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDateTime, money } from "@/lib/format";
import { barcodeSvg } from "@/lib/barcode";
import { cardWithEntries } from "@/lib/gift-cards";
import { PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

/**
 * A gift slip for the receipt printer (shop, amount, number, barcode, "Never expires", the receipt note) and a card-sized
 * page (3.375 by 2.125 in) for card stock or labels.
 */
export default async function PrintGiftCard({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const card = await cardWithEntries(user.shopId, id);
  if (!card) notFound();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  const svg = barcodeSvg(card.number, 8);
  const what = card.kind === "credit" ? "Store credit" : "Gift card";
  const first = card.entries.at(-1);

  return (
    <div className="space-y-4">
      <PageHeader back={{ href: `/register/gift-cards/${card.id}`, label: "The card" }} title={`Print ${what.toLowerCase()}`} actions={<PrintButton />} />
      <div className="receipt card card-pad mx-auto max-w-sm text-center font-mono text-sm" aria-label="Slip">
        <div className="text-base font-bold">{shop.name}</div>
        {shop.address && <div>{shop.address}</div>}
        {shop.phone && <div>{shop.phone}</div>}
        <div className="my-2 border-t border-dashed border-line" />
        <div className="text-base font-bold">{what}</div>
        <div className="num text-2xl font-bold">{money(card.balanceCents)}</div>
        <div className="muted text-xs">{first ? `Issued ${fmtDateTime(first.at, shop.timeZone)}` : ""}</div>
        <div className="mono mt-2 text-base font-bold">{card.number}</div>
        {svg && <div className="mx-auto mt-2 w-48" dangerouslySetInnerHTML={{ __html: svg }} />}
        <p className="mt-2 text-xs">Never expires. No fees.</p>
        {shop.receiptNote && <p className="mt-1 text-xs whitespace-pre-line">{shop.receiptNote}</p>}
      </div>
      <div
        className="mx-auto flex flex-col items-center justify-between rounded border border-line bg-white p-3 text-center text-black"
        style={{ width: "3.375in", height: "2.125in" }}
        aria-label="Card"
      >
        <div className="text-sm font-bold">{shop.name}</div>
        <div className="text-xs">{what}</div>
        {svg && <div className="w-44" dangerouslySetInnerHTML={{ __html: svg }} />}
        <div className="mono text-xs font-bold">{card.number}</div>
        <div className="text-[10px]">Never expires. No fees.</div>
      </div>
    </div>
  );
}
