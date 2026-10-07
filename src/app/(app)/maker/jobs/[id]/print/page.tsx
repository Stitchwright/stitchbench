// A print or cut job's slip (shop-features-round-2-design.md 6.5): for the customer and the bench, with the shop's rule
// "We decide what we'll print or cut".
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { jobView } from "@/lib/make-jobs";
import { MAKE_KIND_LABEL, statusLabel, type MakeKind } from "@/lib/make-jobs-math";
import { PrintButton } from "@/components/print-button";

export default async function MakeJobSlip({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [j, tz, shop] = await Promise.all([jobView(user.shopId, id), shopTimeZone(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } })])
  if (!j) notFound();
  const kind = j.kind as MakeKind;
  return (
    <div className="max-w-xl space-y-3 text-base">
      <div className="no-print">
        <PrintButton />
      </div>
      <h1 className="h1">
        {shop.name}: job #{j.number}
      </h1>
      <p>
        {j.title} · {MAKE_KIND_LABEL[kind] ?? j.kind} · for {j.name}
        {j.dueAt ? ` · wanted by ${fmtDate(j.dueAt, tz)}` : ""}
      </p>
      <p>
        Price: <strong>{money(j.quoteCents)}</strong> before tax ({Math.floor(j.machineMinutes / 60)} h {j.machineMinutes % 60} min machine time
        {j.materialName ? `, ${j.materialQty || ""} ${j.materialUnit ?? ""} ${j.materialName}` : ""}, set-up {money(j.setupCents)}). Now: {statusLabel(j.status, kind).toLowerCase()}.
      </p>
      {j.fileName && <p>File: {j.fileName} (kept until 30 days after pickup, then deleted).</p>}
      <p className="font-semibold">We decide what we&apos;ll print or cut: we may turn down copied logos, weapons or unsafe materials.</p>
      {shop.phone && <p>Questions? Call {shop.phone}.</p>}
    </div>
  );
}
