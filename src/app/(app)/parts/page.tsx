import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fineCost, money } from "@/lib/format";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { PartFields } from "@/components/part-fields";
import { BarcodeLookupButton } from "@/components/barcode-lookup-button";
import { createPart } from "@/actions/parts";
import { entryFor } from "@/lib/assistant/ui";
import { BoltLabelButton } from "@/components/assistant/label-button";
import { KIND_LABEL } from "@/lib/parts";
import { CONDITIONS, CONDITION_NAME, ORIGINS, ORIGIN_NAME, partTags } from "@/lib/part-labels";
import { qtyText } from "@/lib/register-math";
import { FIRST_PHOTO } from "@/lib/register-item";
import type { PartCondition, PartKind, PartOrigin } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

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
    condition?: string;
    origin?: string;
    new?: string;
  }>;
}) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true, doesRepair: true } });
  const labelEntry = shop.sellsRetail ? await entryFor(user.shopId, "fabric") : null;
  const tabs = KINDS.filter((x) => !("retail" in x) || shop.sellsRetail);
  const { q, low, kind: k, condition: cond, origin: made, new: newCode } = await searchParams;
  const term = q?.trim();
  const kind = KINDS.some((x) => x.key && x.key === k)
    ? (k as PartKind)
    : undefined;
  const condition = CONDITIONS.find((c) => c === cond) as PartCondition | undefined;
  const origin = ORIGINS.find((o) => o === made) as PartOrigin | undefined;
  const where: Prisma.PartWhereInput = {
    shopId: user.shopId,
    ...(kind ? { kind } : {}),
    ...(condition ? { condition } : {}),
    ...(origin ? { origin } : {}),
    // Low stock is filtered in the database, so it isn't limited to the first rows of the list.
    ...(low === "1" ? { qtyOnHand: { lte: db.part.fields.reorderAt } } : {}),
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
  };
  const SHOWN = 1000;
  // The count and the shelf value cover every matching item, not only the ones listed.
  const [parts, all] = await Promise.all([
    db.part.findMany({ where, orderBy: { partNumber: "asc" }, take: SHOWN, include: FIRST_PHOTO }),
    db.part.findMany({ where, select: { costCents: true, costTenThou: true, qtyOnHand: true } }),
  ]);
  // At the fine cost (ten-thousandths), rounded once for the whole shelf, not per unit.
  const value = Math.round(all.reduce((s, p) => s + (fineCost(p.costCents, p.costTenThou) ?? 0) * Math.max(0, p.qtyOnHand), 0) / 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title={shop.doesRepair ? "Parts and accessories" : "Inventory"}
        sub={`${all.length} items${all.length > parts.length ? ` (the first ${parts.length} listed: search to narrow it down)` : ""} · ${money(value)} on the shelf at cost`}
        actions={
          <>
            <Link href="/parts/import" className="btn">
              Import spreadsheet
            </Link>
            <Link href="/parts/most-used" className="btn">
              Most used
            </Link>
            <Link href="/parts/on-order" className="btn">
              On order
            </Link>
            <Link href="/xref" className="btn">
              Other part numbers
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
            href={`/parts?${new URLSearchParams({ ...(x.key ? { kind: x.key } : {}), ...(term ? { q: term } : {}), ...(condition ? { condition } : {}), ...(origin ? { origin } : {}) })}`}
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
        <label htmlFor="pcond" className="sr-only">
          Condition
        </label>
        <select id="pcond" name="condition" defaultValue={condition ?? ""} className="select w-40">
          <option value="">Any condition</option>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {CONDITION_NAME[c]}
            </option>
          ))}
        </select>
        <label htmlFor="porigin" className="sr-only">
          Made by
        </label>
        <select id="porigin" name="origin" defaultValue={origin ?? ""} className="select w-40">
          <option value="">Made by anyone</option>
          {ORIGINS.map((o) => (
            <option key={o} value={o}>
              {ORIGIN_NAME[o]}
            </option>
          ))}
        </select>
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
                  {shop.sellsRetail && (
                    <th className="w-14">
                      <span className="sr-only">Picture</span>
                    </th>
                  )}
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
                    {shop.sellsRetail && (
                      <td>
                        {p.photos[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset
                          <img src={`/api/parts/photo/${p.photos[0].id}`} alt={`${p.partNumber} swatch`} className="h-10 w-10 rounded border border-line object-cover" loading="lazy" />
                        ) : null}
                      </td>
                    )}
                    <td className="mono">
                      <Link href={`/parts/${p.id}`} className="link">
                        {p.partNumber}
                      </Link>
                    </td>
                    <td>
                      {p.description}
                      {partTags(p).map((t) => (
                        <span key={t} className="pill tone-wait ml-1">
                          {t}
                        </span>
                      ))}
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
            {labelEntry?.show && <BoltLabelButton mode="fabric" unavailable={labelEntry.unavailable} />}
            <PartFields withQty defaultNumber={newCode} fabric={shop.sellsRetail} />
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
