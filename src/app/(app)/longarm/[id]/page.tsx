// One quilting work order (fabric-smarts-design.md section 4a, package F7): its status, what it costs, collecting it
// (billed as a register sale), photos, and the details while it is still open.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { orderView } from "@/lib/longarm";
import { DESIGN_LABEL, OPEN_LONGARM, STATUS_LABEL, rateText, squareInches } from "@/lib/longarm-math";
import { Empty, PageHeader, Section } from "@/components/ui";
import { CollectForm, EditOrderForm, PhotoAdd, PhotoDelete, StatusButtons } from "@/components/longarm-forms";

const TONE = { RECEIVED: "tone-wait", ON_FRAME: "tone-work", READY: "tone-ready", COLLECTED: "tone-done", CANCELLED: "tone-neutral" } as const;

export default async function LongarmOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const { id } = await params;
  const o = await orderView(user.shopId, id);
  if (!o) notFound();
  const tz = o.timeZone;
  const open = OPEN_LONGARM.includes(o.status);
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/longarm", label: "Longarm quilting" }}
        title={`Quilt #${o.number}: ${o.name}`}
        sub={`${o.widthIn} x ${o.lengthIn} in (${squareInches(o.widthIn, o.lengthIn).toLocaleString()} square inches), ${DESIGN_LABEL[o.design].toLowerCase()}${o.designName ? `, ${o.designName}` : ""}.`}
        actions={<span className={`pill ${TONE[o.status]}`}>{STATUS_LABEL[o.status]}</span>}
      />
      <div className="card card-pad space-y-3">
        <StatusButtons id={o.id} status={o.status} />
        {o.status === "READY" && <CollectForm id={o.id} totalLabel={money(o.totalCents)} />}
        {o.status === "COLLECTED" && (
          <p className="text-sm">
            Collected {o.collectedAt ? fmtDate(o.collectedAt, tz) : ""}
            {o.sale ? (
              <>
                {" "}
                and billed on{" "}
                <Link href={`/register/sales/${o.sale.id}`} className="link">
                  sale #{o.sale.number}
                </Link>
                {o.sale.status === "VOIDED" ? " (voided)" : ""}.
              </>
            ) : (
              ". No charge."
            )}
          </p>
        )}
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="label">Customer</dt>
            <dd>
              {o.customerId ? (
                <Link href={`/customers/${o.customerId}`} className="link">
                  {o.name}
                </Link>
              ) : (
                o.name
              )}
            </dd>
          </div>
          <div>
            <dt className="label">Due</dt>
            <dd>{o.dueText ?? "No date"}</dd>
          </div>
          <div>
            <dt className="label">Taken in</dt>
            <dd>{fmtDate(o.receivedAt, tz)}</dd>
          </div>
          <div>
            <dt className="label">Quilting</dt>
            <dd className="num">
              {money(o.quiltCents)}
              <span className="muted"> {o.pricing === "FLAT" ? "flat" : `at ${rateText(o.rateTenthCents)} cents a square inch`}</span>
            </dd>
          </div>
          <div>
            <dt className="label">Thread</dt>
            <dd>
              {o.thread ?? <span className="muted">-</span>}
              {o.threadCents > 0 && <span className="num"> {money(o.threadCents)}</span>}
            </dd>
          </div>
          <div>
            <dt className="label">Batting</dt>
            <dd>
              {o.batting ?? <span className="muted">-</span>}
              {o.battingCents > 0 && <span className="num"> {money(o.battingCents)}</span>}
            </dd>
          </div>
          {o.extraCents > 0 && (
            <div>
              <dt className="label">Extras</dt>
              <dd>
                {o.extraNote ?? "Extras"} <span className="num">{money(o.extraCents)}</span>
              </dd>
            </div>
          )}
          <div>
            <dt className="label">Total before tax</dt>
            <dd className="num font-semibold">{money(o.totalCents)}</dd>
          </div>
        </dl>
        {o.note && <p className="text-sm">{o.note}</p>}
      </div>
      <Section title={`Photos (${o.photos.length})`} actions={<PhotoAdd orderId={o.id} />}>
        {o.photos.length === 0 ? (
          <Empty>No photos yet. Photograph the quilt when it comes in, and the finished work.</Empty>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {o.photos.map((p) => (
              <li key={p.id}>
                <a href={`/api/longarm-photos/${p.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated route, not a static asset */}
                  <img src={`/api/longarm-photos/${p.id}`} alt={p.caption ?? "Quilt photo"} className="aspect-square w-full object-cover" loading="lazy" />
                </a>
                <div className="mt-1 flex items-center justify-between gap-1">
                  <span className="muted text-xs">{fmtDate(p.createdAt, tz)}</span>
                  <PhotoDelete orderId={o.id} photoId={p.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {open && (
        <Section title="Change the details">
          <EditOrderForm
            id={o.id}
            init={{
              widthIn: o.widthIn,
              lengthIn: o.lengthIn,
              pricing: o.pricing,
              rate: o.rateTenthCents ? rateText(o.rateTenthCents) : "",
              flat: o.flatCents ? (o.flatCents / 100).toFixed(2) : "",
              design: o.design,
              designName: o.designName ?? "",
              thread: o.thread ?? "",
              threadPrice: o.threadCents ? (o.threadCents / 100).toFixed(2) : "",
              batting: o.batting ?? "",
              battingPrice: o.battingCents ? (o.battingCents / 100).toFixed(2) : "",
              extra: o.extraCents ? (o.extraCents / 100).toFixed(2) : "",
              extraNote: o.extraNote ?? "",
              taxable: o.taxable,
              due: o.dueYmd ?? "",
              note: o.note ?? "",
            }}
          />
        </Section>
      )}
    </div>
  );
}
