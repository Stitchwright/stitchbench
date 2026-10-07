import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Trash2 } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { money } from "@/lib/format";
import { EVIDENCE_LABEL, KIND_LABEL, type XFit, type XNumber, type XSource } from "@/lib/parts";
import { PageHeader, Section, Empty, modelHref } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { XrefForm } from "@/components/xref-form";
import { XrefHistory } from "./history";
import { PartSearchLinks } from "@/components/part-search-links";
import { mergeCrossRef, removeCrossRef } from "@/actions/xref";

const ORDER = ["tested", "maker", "listed"];
const TONE: Record<string, string> = { tested: "tone-ready", maker: "tone-work", listed: "tone-neutral" };

export default async function CrossRefEntry({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const { id } = await params;
  const x = await db.xPart.findUnique({ where: { id } });
  if (!x) notFound();
  const numbers = x.numbers as XNumber[];
  const fits = x.fits as XFit[];
  const sources = x.sources as XSource[];
  const [stock, listings] = await Promise.all([
    db.part.findMany({ where: { shopId: user.shopId, numberKeys: { hasSome: x.numberKeys } }, select: { id: true, partNumber: true, description: true, qtyOnHand: true, location: true } }),
    db.listing.findMany({ where: { status: "ACTIVE", OR: [{ xpartId: x.id }, { numberKey: { in: x.numberKeys } }] }, orderBy: { priceCents: "asc" }, take: 20 }),
  ]);
  const groups = ORDER.map((ev) => ({ ev, fits: fits.filter((f) => f.evidence === ev) })).filter((g) => g.fits.length);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/xref", label: "Other part numbers" }}
        title={x.name}
        sub={[KIND_LABEL[x.kind] ?? x.kind, x.category, x.specs].filter(Boolean).join(" · ")}
      />
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-3">
          <Section title={`Part numbers (${numbers.length})`}>
            <ul className="divide-y divide-line text-sm">
              {numbers.map((n) => (
                <li key={n.brand + n.number} className="flex justify-between gap-2 py-2">
                  <span>
                    {n.brand} <span className="mono font-semibold">{n.number}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title={`Fits (${fits.length})`}>
            {fits.length === 0 ? (
              <Empty>No machines recorded yet. Add the ones you&apos;ve fitted it to (Fix this part).</Empty>
            ) : (
              <div className="space-y-4">
                {groups.map((g) => (
                  <div key={g.ev}>
                    <h3 className="label mb-2">
                      <span className={`pill ${TONE[g.ev]}`}>{EVIDENCE_LABEL[g.ev] ?? g.ev}</span> {g.fits.length}
                    </h3>
                    <ul className="flex flex-wrap gap-2 text-sm">
                      {g.fits.map((f) => (
                        <li key={f.brand + f.modelKey}>
                          <Link href={modelHref(f.brand, f.model)} className="btn btn-sm" title={f.source ?? undefined}>
                            {f.brand} {f.model}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {groups.some((g) => g.ev === "listed") && (
                  <p className="muted text-xs">
                    &ldquo;In that model&apos;s parts list&rdquo; means the number is listed for that machine. It shows a shared parts bin, not that
                    the part was tried; mark it fitted once you&apos;ve done it.
                  </p>
                )}
              </div>
            )}
          </Section>

          <Section title="Fix this part" actions={<XrefHistory id={x.id} admin={admin} />}>
            <XrefForm x={x} />
            {admin && (
            <div className="mt-6 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
              <ActionForm action={mergeCrossRef.bind(null, x.id)} className="space-y-2">
                <label htmlFor="merge-into" className="label">
                  Same part as another entry? Merge into it
                </label>
                <input id="merge-into" name="into" className="input mono" placeholder="a part number from the other entry" required />
                <Submit className="btn btn-sm">Merge</Submit>
              </ActionForm>
              <div className="space-y-2">
                <div className="label">Not a real part?</div>
                <ActionButton action={removeCrossRef.bind(null, x.id)} className="btn btn-sm btn-danger" confirm="Remove for everyone?" title="Remove">
                  <Trash2 size={12} aria-hidden /> Remove
                </ActionButton>
              </div>
            </div>
            )}
          </Section>
        </div>

        <div className="space-y-6 xl:col-span-2">
          <Section title="In your stock">
            {stock.length === 0 ? (
              <Empty>Not in your parts.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {stock.map((p) => (
                  <li key={p.id} className="flex justify-between gap-2 py-2">
                    <Link href={`/parts/${p.id}`} className="link">
                      <span className="mono">{p.partNumber}</span> {p.description}
                    </Link>
                    <span className="num">
                      {p.qtyOnHand}
                      {p.location && <span className="muted text-xs"> · {p.location}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Where to buy (${sources.length})`}>
            {sources.length === 0 ? (
              <Empty>No sources yet. Add where you buy it (Fix this part).</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {sources.map((s, i) => (
                  <li key={s.id ?? i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer" className="link">
                          {s.vendor} <ExternalLink size={10} className="inline" aria-hidden />
                        </a>
                      ) : (
                        s.vendor
                      )}
                      {s.byShop && <span className="muted text-xs"> · from {s.byShop}</span>}
                    </span>
                    {s.priceCents != null && <span className="num">{money(s.priceCents)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Search suppliers">
            <PartSearchLinks numbers={numbers.map((n) => n.number)} />
          </Section>

          <Section title={`On the marketplace (${listings.length})`}>
            {listings.length === 0 ? (
              <Empty>No shop is selling it right now.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {listings.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2 py-2">
                    <Link href={`/market/${l.id}`} className="link">
                      {l.title}
                    </Link>
                    <span className="num">
                      {money(l.priceCents)} <span className="muted text-xs">· {l.shopName}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
