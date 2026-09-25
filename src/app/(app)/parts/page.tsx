import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { PartFields } from "@/components/part-fields";
import { BarcodeLookupButton } from "@/components/barcode-lookup-button";
import { createPart } from "@/actions/parts";
import { KIND_LABEL } from "@/lib/parts";
import { qtyText } from "@/lib/register-math";
import type { PartKind } from "@/generated/prisma/enums";

const KINDS = [
  { key: "", label: "All" },
  { key: "PART", label: "Parts" },
  { key: "ACCESSORY", label: "Accessories" },
  { key: "SUPPLY", label: "Supplies" },
  { key: "NOTION", label: "Notions", retail: true },
  { key: "FABRIC", label: "Fabric", retail: true },
  { key: "THREAD", label: "Thread", retail: true },
  { key: "PATTERN", label: "Patterns", retail: true },
] as const;

export default async function Parts({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    low?: string;
    kind?: string;
    new?: string;
  }>;
}) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true, doesRepair: true } });
  const tabs = KINDS.filter((x) => !("retail" in x) || shop.sellsRetail);
  const { q, low, kind: k, new: newCode } = await searchParams;
  const term = q?.trim();
  const kind = KINDS.some((x) => x.key && x.key === k)
    ? (k as PartKind)
    : undefined;
  let parts = await db.part.findMany({
    where: {
      shopId: user.shopId,
      ...(kind ? { kind } : {}),
      ...(term
        ? {
            OR: [
              { partNumber: { contains: term, mode: "insensitive" } },
              { description: { contains: term, mode: "insensitive" } },
              { fits: { contains: term, mode: "insensitive" } },
              { brand: { contains: term, mode: "insensitive" } },
              { altNumbers: { has: term } },
            ],
          }
        : {}),
    },
    orderBy: { partNumber: "asc" },
    take: 1000,
  });
  if (low === "1") parts = parts.filter((p) => p.qtyOnHand <= p.reorderAt);
  const value = parts.reduce(
    (s, p) => s + (p.costCents ?? 0) * Math.max(0, p.qtyOnHand),
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={shop.doesRepair ? "Parts and accessories" : "Inventory"}
        sub={`${parts.length} items · ${money(value)} on the shelf at cost`}
        actions={
          <>
            <Link href="/parts/import" className="btn">
              Import spreadsheet
            </Link>
            <Link href="/parts/most-used" className="btn">
              Most used
            </Link>
            <Link href="/xref" className="btn">
              Cross-reference
            </Link>
            <Link href="/market" className="btn">
              Marketplace
            </Link>
          </>
        }
      />
      <nav className="flex flex-wrap gap-2" aria-label="Type">
        {tabs.map((x) => (
          <Link
            key={x.key}
            href={`/parts?${new URLSearchParams({ ...(x.key ? { kind: x.key } : {}), ...(term ? { q: term } : {}) })}`}
            className={`btn btn-sm ${(kind ?? "") === x.key ? "btn-primary" : ""}`}
            aria-current={(kind ?? "") === x.key ? "page" : undefined}
          >
            {x.label}
          </Link>
        ))}
      </nav>
      <form className="flex flex-wrap gap-2">
        {kind && <input type="hidden" name="kind" value={kind} />}
        <label htmlFor="pq" className="sr-only">
          Search parts
        </label>
        <input
          id="pq"
          name="q"
          defaultValue={term}
          className="input max-w-md"
          placeholder="Part number, description, fits model"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="low"
            value="1"
            defaultChecked={low === "1"}
            className="check"
          />{" "}
          Low stock only
        </label>
        <button className="btn">Search</button>
      </form>
      <div className="card">
        {parts.length === 0 ? (
          <div className="card-pad">
            <Empty>
              No parts yet. Add the wear parts you keep on the shelf below.
            </Empty>
          </div>
        ) : (
          <form
            action="/labels"
            method="get"
            target="_blank"
            className="scroll-x"
          >
            <div className="card-pad flex flex-wrap items-center gap-2 border-b border-line py-2 text-sm">
              <span className="muted">
                Barcode labels for the ticked parts:
              </span>
              <label htmlFor="lbl-format" className="sr-only">
                Label type
              </label>
              <select
                id="lbl-format"
                name="format"
                className="select w-56"
                defaultValue="sheet"
              >
                <option value="sheet">Avery 5160 sheet (30 per page)</option>
                <option value="thermal">
                  Thermal label 2.25&quot; × 1.25&quot;
                </option>
              </select>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  name="price"
                  value="1"
                  className="check"
                />{" "}
                price
              </label>
              <button className="btn btn-sm">Print labels</button>
              <Link href="/parts/scan" className="btn btn-sm">
                Scan
              </Link>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th className="w-8">
                    <span className="sr-only">Label</span>
                  </th>
                  <th>Part #</th>
                  <th>Description</th>
                  <th>Fits</th>
                  <th>Bin</th>
                  <th className="text-right">On hand</th>
                  <th className="text-right">Price</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        name="id"
                        value={p.id}
                        aria-label={`Label for ${p.partNumber}`}
                        className="check"
                      />
                    </td>
                    <td className="mono">
                      <Link href={`/parts/${p.id}`} className="link">
                        {p.partNumber}
                      </Link>
                    </td>
                    <td>
                      {p.description}
                      <div className="muted text-xs">
                        {[
                          p.kind !== "PART" ? KIND_LABEL[p.kind] : null,
                          p.brand,
                          p.altNumbers.length
                            ? `also ${p.altNumbers.join(", ")}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </td>
                    <td className="max-w-56 text-xs">{p.fits}</td>
                    <td>{p.location}</td>
                    <td className="num text-right">
                      <span
                        className={
                          p.qtyOnHand <= p.reorderAt
                            ? `pill ${p.qtyOnHand <= 0 ? "tone-bad" : "tone-wait"}`
                            : ""
                        }
                      >
                        {qtyText(p.qtyOnHand, p.unit)}
                      </span>
                      {p.consignLinkId && <div className="muted text-xs">consigned</div>}
                    </td>
                    <td className="num text-right">
                      {money(p.priceCents)}
                      {p.unit === "yd" ? "/yd" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </form>
        )}
      </div>
      <div id="add">
        <Section title="Add a part or accessory">
          <ActionForm action={createPart} className="grid-form">
            <PartFields withQty defaultNumber={newCode} />
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Submit>Add part</Submit>
              <BarcodeLookupButton />
            </div>
          </ActionForm>
        </Section>
      </div>
    </div>
  );
}
