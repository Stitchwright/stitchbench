// Under a receipt's lines (shop-features-round-2-design.md 2.5): each software licence sold on the sale, with its code in
// full (the receipt is the customer's record), who and which machine it is for, the renewal date of a subscription, and
// the no-returns words. A code still to come says so.
import { db } from "@/lib/db";
import { licensesOfSale, NO_RETURN_DEFAULT } from "@/lib/software";

export async function SaleSoftwareNotes({ saleId, shopId }: { saleId: string; shopId: string }) {
  const lics = await licensesOfSale(shopId, saleId);
  if (!lics.length) return null;
  const partIds = await db.softwareLicense.findMany({ where: { shopId, saleId }, select: { id: true, part: { select: { noReturnText: true } } } });
  const words = new Map(partIds.map((p) => [p.id, p.part?.noReturnText?.trim() || NO_RETURN_DEFAULT]));
  return (
    <div className="mt-2 space-y-2 text-xs">
      {lics.map((l) => (
        <div key={l.id}>
          <div className="font-semibold">{l.description}</div>
          <div>Activation code: {l.code ? <span className="mono">{l.code}</span> : "to follow (we'll give it to you as soon as it comes)"}</div>
          {l.customerName && <div>Licensed to {l.customerName}{l.machineLabel ? `, for the ${l.machineLabel}` : ""}</div>}
          {l.kind === "SUBSCRIPTION" && l.renewsText && <div>Renews {l.renewsText}</div>}
          <div>{words.get(l.id)}</div>
        </div>
      ))}
    </div>
  );
}
