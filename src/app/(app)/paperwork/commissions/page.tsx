// Paperwork → Commissions (shop-features-round-2-design.md 9.7): each person's sales in a month (machines and
// everything, returns taken off, voids left out), the commission by their rule, and the rules. Owners and admins.
import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { addMonths, dayStart, ymdOf } from "@/lib/zoned";
import { commissionReport } from "@/lib/commissions";
import { saveCommission } from "@/actions/commissions";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";

export default async function CommissionsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requireAdmin();
  const { month } = await searchParams;
  const tz = await shopTimeZone(user.shopId);
  const thisMonth = ymdOf(new Date(), tz).slice(0, 7);
  const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : thisMonth;
  const first = `${m}-01`;
  const next = addMonths(first, 1)!;
  const prev = addMonths(first, -1)!.slice(0, 7);
  const rows = await commissionReport(user.shopId, dayStart(first, tz), dayStart(next, tz));
  const label = new Date(`${first}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
  return (
    <PaperFrame title="Commissions" tab="commissions" admin sub="Who sold what, and what each person earns by their rule. Pick who sold it at the register (it starts as the person signed in).">
      <Section
        title={label}
        actions={
          <nav className="flex gap-2" aria-label="Month">
            <Link href={`/paperwork/commissions?month=${prev}`} className="btn btn-sm">
              Month before
            </Link>
            {m !== thisMonth && (
              <Link href="/paperwork/commissions" className="btn btn-sm">
                This month
              </Link>
            )}
          </nav>
        }
      >
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th className="text-right">Machines sold</th>
                <th className="text-right">Everything sold</th>
                <th>Rule</th>
                <th className="text-right">Commission</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td>{r.name}</td>
                  <td className="num text-right">{money(r.machinesCents)}</td>
                  <td className="num text-right">{money(r.allCents)}</td>
                  <td>{r.rule ? `${r.rule.pct}% of ${r.rule.on === "all" ? "everything" : "machines"}` : <span className="muted">none</span>}</td>
                  <td className="num text-right font-semibold">{money(r.commissionCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted mt-2 text-sm">Before tax, after each line&apos;s own discount. Gift cards, layaway payments and partner repair bills don&apos;t count.</p>
      </Section>
      <Section title="Each person's rule">
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.userId} className="py-2">
              <ActionForm action={saveCommission.bind(null, r.userId)} className="flex flex-wrap items-end gap-2">
                <span className="min-w-40 text-base font-semibold">{r.name}</span>
                <div className="field">
                  <label className="label" htmlFor={`cm-pct-${r.userId}`}>
                    Percent
                  </label>
                  <input id={`cm-pct-${r.userId}`} name="pct" inputMode="decimal" className="input num w-24" defaultValue={r.rule ? String(r.rule.pct) : ""} placeholder="none" />
                </div>
                <div className="field">
                  <label className="label" htmlFor={`cm-on-${r.userId}`}>
                    Of
                  </label>
                  <select id={`cm-on-${r.userId}`} name="on" className="select" defaultValue={r.rule?.on ?? "machines"}>
                    <option value="machines">Machine sales</option>
                    <option value="all">Everything sold</option>
                  </select>
                </div>
                <Submit className="btn">Save</Submit>
              </ActionForm>
            </li>
          ))}
        </ul>
      </Section>
    </PaperFrame>
  );
}
