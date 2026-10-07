// The appraisal certificate (shop-features-round-2-design.md 9.8): its number and date, the shop, the owner, the quilt
// with its first photo, the value and what it is for, and the appraiser with her credential. Printed from the browser.
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { appraisalSettings, appraisalView } from "@/lib/appraisals";
import { PURPOSES, type Purpose } from "@/lib/appraisals-words";
import { PrintButton } from "@/components/print-button";

export default async function AppraisalCertificate({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [a, shop, tz] = await Promise.all([appraisalView(user.shopId, id), appraisalSettings(user.shopId), shopTimeZone(user.shopId)]);
  if (!a || !a.issuedAt) notFound();
  const q = a.quilt;
  const row = (k: string, v: string | null | undefined) =>
    v ? (
      <div className="grid grid-cols-3 gap-2 border-b border-line py-1">
        <dt className="muted">{k}</dt>
        <dd className="col-span-2">{v}</dd>
      </div>
    ) : null;
  return (
    <div className="mx-auto max-w-2xl space-y-4 bg-white p-6 text-base text-black">
      <div className="no-print flex justify-end">
        <PrintButton />
      </div>
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-bold">Quilt Appraisal Certificate</h1>
        <p>
          No. {a.number} · {fmtDate(a.issuedAt, tz)}
        </p>
        <p className="text-sm">
          {shop.name}
          {shop.address ? ` · ${shop.address}` : ""}
          {shop.phone ? ` · ${shop.phone}` : ""}
        </p>
      </header>
      {a.photos[0] && (
        // eslint-disable-next-line @next/next/no-img-element -- the company's own upload, served by its route
        <img src={`/api/appraisal-photos/${a.photos[0].id}`} alt={q.title} className="mx-auto max-h-80 w-auto rounded border" />
      )}
      <dl>
        {row("Quilt", q.title)}
        {row("Owner", a.name)}
        {row("Size", q.widthIn && q.lengthIn ? `${q.widthIn} x ${q.lengthIn} inches` : null)}
        {row("Made by", q.maker)}
        {row("Made", q.made)}
        {row("Techniques", q.techniques)}
        {row("Materials", q.materials)}
        {row("Condition", q.condition)}
        {row("Description", q.description)}
      </dl>
      <p className="text-center text-xl font-semibold">
        {PURPOSES[a.purpose as Purpose] ?? "Value"}: {money(a.valueCents)}
      </p>
      <footer className="pt-10">
        <div className="w-72 border-t border-black pt-1">
          {a.appraiser}
          {a.credential ? <div className="text-sm">{a.credential}</div> : null}
        </div>
      </footer>
    </div>
  );
}
