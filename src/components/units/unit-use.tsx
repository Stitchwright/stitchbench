// What a machine is for (shop-features-round-2-design.md 1.7 and 1.8): for sale, loaner, demo or rental, with its
// loans; "Sell this one" puts a loaner, demo or rental back on sale (a demo as open box, the others used).
import Link from "next/link";
import { db } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtYmdLong } from "@/lib/units/units";
import { LOAN_KIND_LABEL, loansFor, USE_LABEL, USES, isUse } from "@/lib/loans";
import { setUnitUse } from "@/actions/loans";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function UnitUse({ shopId, unitId, admin }: { shopId: string; unitId: string; admin: boolean }) {
  const u = await db.stockUnit.findFirst({ where: { id: unitId, shopId }, select: { use: true, status: true } });
  if (!u) return null;
  const [loans, tz] = await Promise.all([loansFor(shopId, { unitId, take: 10 }), shopTimeZone(shopId)]);
  const use = isUse(u.use) ? u.use : "SALE";
  return (
    <Section title="What it's for">
      <p className="text-base">
        <span className="pill tone-neutral mr-1">{USE_LABEL[use]}</span>
        {use === "SALE" ? "Shows in the register's machine search." : "Doesn't show in the register's machine search."}{" "}
        {use !== "SALE" && (
          <Link href="/units/loans" className="link">
            Loaners and demos
          </Link>
        )}
      </p>
      {admin && u.status === "IN_STOCK" && (
        <ActionForm action={setUnitUse.bind(null, unitId)} success="Saved" className="mt-3 flex flex-wrap items-end gap-3 text-base">
          <div className="field">
            <label htmlFor="unit-use" className="label">
              Use it as
            </label>
            <select id="unit-use" name="use" className="select" defaultValue={use}>
              {USES.map((x) => (
                <option key={x} value={x}>
                  {x === "SALE" && use !== "SALE" ? "For sale (sell this one)" : USE_LABEL[x]}
                </option>
              ))}
            </select>
          </div>
          {use !== "SALE" && (
            <div className="field">
              <label htmlFor="unit-cond" className="label">
                If for sale again, its condition
              </label>
              <select id="unit-cond" name="condition" className="select" defaultValue={use === "DEMO" ? "OPEN_BOX" : "USED"}>
                <option value="OPEN_BOX">Open box</option>
                <option value="USED">Used</option>
                <option value="REFURB">Refurbished</option>
              </select>
            </div>
          )}
          <Submit className="btn min-h-11">Save</Submit>
        </ActionForm>
      )}
      {loans.length > 0 && (
        <ul className="mt-3 divide-y divide-line text-sm">
          {loans.map((l) => (
            <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2">
              <Link href={`/units/loans/${l.id}`} className="link">
                {LOAN_KIND_LABEL[l.kind]}
                {l.customer ? ` to ${l.customer.name}` : ""}, {fmtDate(l.outAt, tz)}
              </Link>
              <span>{l.backAt ? `back ${fmtDate(l.backAt, tz)}` : l.dueOn ? `out, due ${fmtYmdLong(l.dueOn)}` : "out"}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
