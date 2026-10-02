// Under a receipt's lines (modules-design.md 10.c): "{vacuum}: warranty through {date} from {by}. Keep this receipt."
// for each vacuum sold on it, and "Trade-in credit: {x}" for each trade-in. Scoped with sale: { shopId }.
import { db } from "@/lib/db";
import { money } from "@/lib/format";
import { lineNet } from "@/lib/register-math";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong, unitDescription, warrantyThrough } from "@/lib/vac/units";

export async function SaleUnitNotes({ saleId, shopId }: { saleId: string; shopId: string }) {
  const lines = await db.saleLine.findMany({ where: { saleId, sale: { shopId }, OR: [{ stockUnitId: { not: null } }, { tradeInUnitId: { not: null } }] } });
  if (!lines.length) return null;
  const ids = lines.flatMap((l) => [l.stockUnitId, l.tradeInUnitId]).filter((x): x is string => !!x);
  const [units, tz] = await Promise.all([db.stockUnit.findMany({ where: { id: { in: ids }, shopId }, include: { machine: true } }), shopTimeZone(shopId)]);
  const byId = new Map(units.map((u) => [u.id, u]));
  const notes: string[] = [];
  for (const l of lines) {
    if (l.stockUnitId && l.qty > 0) {
      const u = byId.get(l.stockUnitId);
      if (!u) continue;
      // The warranty as it stands on the unit while this sale is the one that sold it; a later return or re-sale moves it.
      const through = u.soldLineId === l.id && u.warrantyUntil ? fmtYmdLong(warrantyThrough(u.warrantyUntil, tz)) : null;
      notes.push(`${unitDescription(u)}: ${through ? `warranty through ${through}${u.warrantyBy ? ` from ${u.warrantyBy}` : ""}` : "sold here"}. Keep this receipt.`);
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
