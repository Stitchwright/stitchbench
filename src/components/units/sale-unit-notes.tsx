// Under a receipt's lines (modules-design.md 10.c; tax-machine-sales-layaway-design.md section 3): for each machine
// sold on it, "{machine}: warranty through {date} from {by}. Keep this receipt.", the maker's terms as the shop typed
// them, what comes with it, the owner's classes and the plan included; for each plan sold, what it covers and until
// when; "Trade-in credit: {x}" for each trade-in. Scoped with sale: { shopId }.
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { lineNet } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { bundleItems, fmtYmdLong, makerTermsFor, termsOf, termsText, unitDescription, warrantyThrough } from "@/lib/units/units";

export async function SaleUnitNotes({ saleId, shopId }: { saleId: string; shopId: string }) {
  const lines = await db.saleLine.findMany({ where: { saleId, sale: { shopId }, OR: [{ stockUnitId: { not: null } }, { tradeInUnitId: { not: null } }, { machinePlanId: { not: null } }] } });
  if (!lines.length) return null;
  const ids = lines.flatMap((l) => [l.stockUnitId, l.tradeInUnitId]).filter((x): x is string => !!x);
  const [units, tz, plans] = await Promise.all([
    db.stockUnit.findMany({ where: { id: { in: ids }, shopId }, include: { machine: true } }),
    shopTimeZone(shopId),
    db.machinePlan.findMany({ where: { shopId, saleLineId: { in: lines.map((l) => l.id) } } }),
  ]);
  const byId = new Map(units.map((u) => [u.id, u]));
  const terms = await makerTermsFor(
    shopId,
    units.map((u) => u.machine.brand),
  );
  const notes: string[] = [];
  const planNote = (p: { name: string; visits: number | null; endsAt: Date; voidedAt: Date | null }) =>
    p.voidedAt ? `${p.name}: ended.` : `${p.name}: ${p.visits != null ? `${p.visits} covered visit${p.visits === 1 ? "" : "s"}` : "covered"} through ${fmtYmdLong(warrantyThrough(p.endsAt, tz))}.`;
  for (const l of lines) {
    if (l.stockUnitId && l.qty > 0) {
      const u = byId.get(l.stockUnitId);
      if (!u) continue;
      // The warranty as it stands on the unit while this sale is the one that sold it; a later return or re-sale moves it.
      const mine = u.soldLineId === l.id;
      const through = mine && u.warrantyUntil ? fmtYmdLong(warrantyThrough(u.warrantyUntil, tz)) : null;
      notes.push(`${unitDescription(u)}: ${through ? `warranty through ${through}${u.warrantyBy ? ` from ${u.warrantyBy}` : ""}` : "sold here"}. Keep this receipt.`);
      if (!mine) continue;
      // A trial purchase (shop-features-round-2-design.md 1.8).
      if (u.trialUntil) notes.push(`Try it until ${fmtYmdLong(warrantyThrough(u.trialUntil, tz))}: bring it back by then for a full refund.`);
      const maker = termsOf(terms, u.machine.brand);
      if (maker && termsText(maker)) notes.push(`${maker.brand} warranty: ${termsText(maker)}.`);
      const items = bundleItems(u.bundle);
      if (items.length) notes.push(`Comes with: ${items.join(", ")}.`);
      if (u.classCredits > 0) notes.push(`Includes ${u.classCredits} owner's class${u.classCredits === 1 ? "" : "es"}. Call us to book.`);
      for (const p of plans.filter((x) => x.saleLineId === l.id)) notes.push(`Service plan included: ${planNote(p)}`);
    } else if (l.machinePlanId) {
      const p = plans.find((x) => x.id === l.machinePlanId);
      if (p) notes.push(`Service plan: ${planNote(p)}`);
    } else if (l.tradeInUnitId) {
      notes.push(`Trade-in credit: ${money(Math.abs(lineNet(l)))}`);
    } else if (l.stockUnitId && l.qty < 0) {
      const u = byId.get(l.stockUnitId);
      notes.push(`Returned: ${u ? unitDescription(u) : l.description}`);
    }
  }
  if (!notes.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {notes.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  );
}
