import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PageHeader, Empty } from "@/components/ui";

// The shop's price sheet for the counter, quilt shops and customers, built from the service menu.
export default async function PriceList() {
  const user = await requireUser();
  const [shop, items] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId } }),
    db.serviceItem.findMany({ where: { shopId: user.shopId, active: true, priceCents: { gt: 0 } }, orderBy: { sortOrder: "asc" } }),
  ]);
  const groups: { name: string; items: typeof items }[] = [];
  for (const it of items) {
    const name = it.category?.trim() || "Services";
    const g = groups.find((x) => x.name === name) ?? groups[groups.push({ name, items: [] }) - 1];
    g.items.push(it);
  }

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title="Price list"
          sub="Built from the service menu. Only active services with a price are shown."
          actions={
            <>
              {user.role !== "TECH" && (
                <Link href="/settings" className="btn">
                  Edit prices
                </Link>
              )}
              <PrintButton />
            </>
          }
        />
      </div>
      <article className="card mx-auto max-w-3xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-black pb-4">
          <div>
            <div className="text-2xl font-bold">{shop.name}</div>
            {shop.address && <div className="text-sm whitespace-pre-line">{shop.address}</div>}
            <div className="text-sm">{[shop.phone, shop.email].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold">Service prices</div>
            <div className="text-sm">Effective {fmtDate(new Date())}</div>
          </div>
        </header>

        {groups.length === 0 ? (
          <div className="py-8">
            <Empty>No priced services yet. Add prices under Settings → Service menu.</Empty>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.name} className="mt-6 break-inside-avoid">
              <h2 className="border-b border-line pb-1 text-sm font-bold tracking-wide uppercase">{g.name}</h2>
              <ul>
                {g.items.map((it) => (
                  <li key={it.id} className="flex items-baseline gap-3 border-b border-dotted border-line py-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{it.name}</div>
                      {it.description && <div className="text-sm">{it.description}</div>}
                    </div>
                    <div className="num font-semibold whitespace-nowrap">{money(it.priceCents)}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        <footer className="mt-8 space-y-1 border-t border-line pt-4 text-sm">
          <p>Additional labor: {money(shop.laborRateCents)} per hour.</p>
          {shop.warrantyDays > 0 && <p>{shop.warrantyDays}-day warranty on our work.</p>}
          {shop.priceListNote && <p className="whitespace-pre-line">{shop.priceListNote}</p>}
        </footer>
      </article>
    </div>
  );
}
