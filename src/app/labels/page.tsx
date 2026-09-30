import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { barcodeSvg } from "@/lib/barcode";
import { PrintButton } from "@/components/print-button";

// Barcode labels for parts: a sheet of Avery 5160 labels (30 per letter page) or one label per page for a thermal
// label printer (2.25" x 1.25": Dymo 30334, Zebra, Rollo). The barcode is the part number (Code 128).
type SP = { id?: string | string[]; format?: string; price?: string; copies?: string; skip?: string };

// Barcodes are drawn on the server and drawing blocks it, so one page is kept to a size a printer run needs.
const MAX_PARTS = 300;
const MAX_LABELS = 600;

export default async function Labels({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const asked = [...new Set([sp.id ?? []].flat().flatMap((s) => s.split(",")).filter(Boolean))];
  const ids = asked.slice(0, MAX_PARTS);
  const format = sp.format === "thermal" ? "thermal" : "sheet";
  const withPrice = sp.price === "1";
  const copies = Math.min(30, Math.max(1, Number(sp.copies) || 1));
  const skip = format === "sheet" ? Math.min(29, Math.max(0, Number(sp.skip) || 0)) : 0;
  const parts = await db.part.findMany({ where: { shopId: user.shopId, id: { in: ids } }, orderBy: { partNumber: "asc" } });
  const all = parts.flatMap((p) => Array.from({ length: copies }, () => p));
  const labels = all.slice(0, MAX_LABELS);
  // One barcode per part, shared by its copies.
  const svgs = new Map(parts.slice(0, Math.ceil(MAX_LABELS / copies)).map((p) => [p.id, barcodeSvg(p.partNumber)]));
  const qs = (o: Record<string, string>) =>
    `/labels?${new URLSearchParams({ id: ids.join(","), format, copies: String(copies), ...(withPrice ? { price: "1" } : {}), ...(skip ? { skip: String(skip) } : {}), ...o })}`;

  return (
    <div className={`labels-${format}`}>
      <style>{`
        body { background: #fff; }
        .label { box-sizing: border-box; overflow: hidden; color: #000; font-family: Arial, sans-serif; display: flex; flex-direction: column; justify-content: center; }
        .label svg { width: 100%; height: 0.42in; display: block; }
        .label .pn { font: 700 10pt/1.1 ui-monospace, Consolas, monospace; }
        .label .desc { font-size: 7.5pt; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .label .meta { font-size: 7pt; display: flex; justify-content: space-between; gap: 4px; }
        .labels-sheet .page { width: 8.5in; padding: 0.5in 0.1875in 0; display: grid; grid-template-columns: repeat(3, 2.625in); grid-auto-rows: 1in; column-gap: 0.125in; }
        .labels-sheet .label { padding: 0.06in 0.14in; }
        .labels-thermal .label { width: 2.25in; height: 1.25in; padding: 0.06in 0.1in; page-break-after: always; break-after: page; }
        @media screen { .label { outline: 1px dashed #bbb; } .labels-thermal .label { margin: 8px; } }
        @media print {
          .no-print { display: none !important; }
          ${format === "sheet" ? "@page { size: letter; margin: 0; }" : "@page { size: 2.25in 1.25in; margin: 0; }"}
          .labels-sheet .page { page-break-after: always; break-after: page; }
        }
      `}</style>
      <div className="no-print space-y-3 p-4" style={{ fontFamily: "system-ui", maxWidth: 820 }}>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/parts" className="btn btn-sm">
            ← Parts
          </Link>
          <PrintButton />
          <strong>
            {labels.length} label{labels.length === 1 ? "" : "s"}
          </strong>
        </div>
        {(asked.length > ids.length || all.length > labels.length) && (
          <p className="text-sm">
            Only the first {labels.length} labels are shown
            {asked.length > ids.length ? ` (${MAX_PARTS} items at a time; ${asked.length} were ticked)` : ` (${MAX_LABELS} at a time)`}. Print these, then
            the rest in another batch.
          </p>
        )}
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href={qs({ format: "sheet" })} className={`btn btn-sm ${format === "sheet" ? "btn-primary" : ""}`}>
            Avery 5160 sheet (30 per page)
          </Link>
          <Link href={qs({ format: "thermal" })} className={`btn btn-sm ${format === "thermal" ? "btn-primary" : ""}`}>
            Thermal label 2.25&quot; × 1.25&quot;
          </Link>
          <Link href={qs(withPrice ? { price: "" } : { price: "1" })} className="btn btn-sm">
            {withPrice ? "Hide price" : "Show price"}
          </Link>
          <Link href={qs({ copies: String(copies + 1) })} className="btn btn-sm">
            {copies} cop{copies === 1 ? "y" : "ies"} each (+1)
          </Link>
          {format === "sheet" && (
            <Link href={qs({ skip: String((skip + 1) % 30) })} className="btn btn-sm">
              Skip {skip} used label{skip === 1 ? "" : "s"} (+1)
            </Link>
          )}
        </div>
        <p className="muted text-xs">
          In the print dialog choose the label printer or letter paper, set margins to None and scale to 100% (not &quot;fit to page&quot;).
        </p>
      </div>
      {format === "sheet" ? (
        Array.from({ length: Math.ceil((labels.length + skip) / 30) || 1 }, (_, page) => (
          <div key={page} className="page">
            {Array.from({ length: 30 }, (_, i) => {
              const idx = page * 30 + i - skip;
              const p = idx >= 0 ? labels[idx] : undefined;
              return p ? <Label key={i} p={p} svg={svgs.get(p.id)} withPrice={withPrice} /> : <div key={i} />;
            })}
          </div>
        ))
      ) : (
        labels.map((p, i) => <Label key={i} p={p} svg={svgs.get(p.id)} withPrice={withPrice} />)
      )}
    </div>
  );
}

function Label({
  p,
  svg,
  withPrice,
}: {
  p: { partNumber: string; description: string; location: string | null; priceCents: number | null };
  svg: string | null | undefined;
  withPrice: boolean;
}) {
  return (
    <div className="label">
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : null}
      <div className="pn">{p.partNumber}</div>
      <div className="desc">{p.description}</div>
      <div className="meta">
        <span>{p.location ? `Bin ${p.location}` : ""}</span>
        <span>{withPrice && p.priceCents != null ? money(p.priceCents) : ""}</span>
      </div>
    </div>
  );
}
