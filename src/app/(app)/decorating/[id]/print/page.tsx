// A decorating order's production worksheet (docs/plans/decorators-proposal.md, package D4): for the bench, not the customer. What
// to hoop and sew: the garments with their sizes, each decoration with its design file, stitches, colours, size and machine
// time, boxes to tick as the work goes, and the order's notes. No prices.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { orderView } from "@/lib/decor";
import { METHOD_LABEL, decorStatusLabel, formatMinutes } from "@/lib/decor-math";
import { PrintButton } from "@/components/print-button";

export default async function DecorWorksheet({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [o, tz, shop] = await Promise.all([orderView(user.shopId, id), shopTimeZone(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true } })]);
  if (!o) notFound();
  return (
    <div className="max-w-3xl space-y-4 text-base">
      <div className="no-print">
        <PrintButton />
      </div>
      <header>
        <h1 className="h1">
          {shop.name}: order #{o.number}
        </h1>
        <p className="text-lg font-semibold">{o.title}</p>
        <p>
          For {o.name}
          {o.dueAt ? ` · wanted by ${fmtDate(o.dueAt, tz)}` : ""} · {decorStatusLabel(o.status).toLowerCase()} · {o.pieces} {o.pieces === 1 ? "piece" : "pieces"}
        </p>
      </header>

      <section>
        <h2 className="text-base font-semibold">Garments</h2>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              <th className="py-1 pr-2">How many</th>
              <th className="py-1 pr-2">Garment</th>
              <th className="py-1 pr-2">Colour</th>
              <th className="py-1 pr-2">Sizes</th>
              <th className="py-1">In</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.id} className="border-b border-line">
                <td className="py-1 pr-2 num">{l.qty}</td>
                <td className="py-1 pr-2">{l.description}</td>
                <td className="py-1 pr-2">{l.color ?? ""}</td>
                <td className="py-1 pr-2">{l.sizes ?? ""}</td>
                <td className="py-1">☐</td>
              </tr>
            ))}
          </tbody>
        </table>
        {o.lines.length === 0 && <p className="muted">No garments on the order yet.</p>}
        {o.lines.some((l) => l.garmentCents === 0) && <p className="muted text-sm">Garments with no price are the customer&apos;s own: check them in and count them.</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Decorations (every piece gets each one)</h2>
        {o.placements.map((p, i) => (
          <div key={p.id} className="break-inside-avoid rounded border border-line p-3">
            <p className="font-semibold">
              {i + 1}. {p.location} · {METHOD_LABEL[p.method]?.toLowerCase() ?? p.method}
            </p>
            {p.method === "SCREEN_PRINT" ? (
              <>
                <p>
                  {p.colors} {p.colors === 1 ? "colour" : "colours"}
                  {p.underbase ? " + white underbase" : ""} = {p.colorsWithUnderbase} {p.colorsWithUnderbase === 1 ? "screen" : "screens"}
                  {p.widthMm != null && p.heightMm != null ? ` · ${p.widthMm} × ${p.heightMm} mm` : ""} · about {formatMinutes(p.minutesTotal)} on the press for all {o.pieces}
                </p>
                <p className="text-sm">
                  Art: {p.fileName ? `${p.fileName} (${p.fileFormat ?? "file"})` : "none attached"}
                  {p.newDesign ? " · new screens: burn them first" : " · repeat: use the screens on the shelf"}
                </p>
              </>
            ) : (
              <>
                <p>
                  {p.stitches.toLocaleString("en-US")} stitches · {p.colors} {p.colors === 1 ? "colour" : "colours"}
                  {p.widthMm != null && p.heightMm != null ? ` · ${p.widthMm} × ${p.heightMm} mm` : ""} · {formatMinutes(p.runMinutesEach)} a piece, {formatMinutes(p.minutesTotal)} for all {o.pieces}
                </p>
                <p className="text-sm">
                  Design file: {p.fileName ? `${p.fileName} (${p.fileFormat ?? "file"})` : "none attached"}
                  {p.newDesign ? " · new design: digitize, then sew a test on scrap" : ""}
                </p>
              </>
            )}
            {p.note && <p className="text-sm">Note: {p.note}</p>}
            <p className="mt-1 text-sm">
              {p.method === "SCREEN_PRINT"
                ? `☐ screens ready  ☐ inks mixed  ☐ registered on the press  ☐ test print  ☐ printed on all ${o.pieces}  ☐ cured`
                : `☐ design loaded  ☐ test sewn  ☐ hooped and placed  ☐ done on all ${o.pieces}`}
            </p>
          </div>
        ))}
        {o.placements.length === 0 && <p className="muted">No decorations on the order yet.</p>}
        {o.runMinutesTotal > 0 && (
          <p className="font-semibold">
            {`Machine time for the whole order: about ${formatMinutes(o.runMinutesTotal)} at the speeds set in the shop's prices.`}
          </p>
        )}
      </section>

      {o.note && (
        <section>
          <h2 className="text-base font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap">{o.note}</p>
        </section>
      )}
      <section className="text-sm">
        <p>☐ garments counted and checked &nbsp; ☐ all pieces inspected &nbsp; ☐ bagged or boxed &nbsp; ☐ customer told</p>
      </section>
    </div>
  );
}
