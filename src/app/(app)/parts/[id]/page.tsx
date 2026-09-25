import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { PageHeader, Section, KV } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { PartFields } from "@/components/part-fields";
import { addPartSource, moveStock, preferPartSource, removePartSource, updatePart } from "@/actions/parts";
import { addPartToCrossRef } from "@/actions/xref";
import { ActionButton } from "@/components/action-form";
import { ListingForm } from "@/components/listing-form";
import { hubJoined } from "@/lib/hub";
import { EVIDENCE_LABEL, KIND_LABEL, xrefForKeys, type XFit, type XNumber, type XSource } from "@/lib/parts";
import { ExternalLink, Trash2 } from "lucide-react";

const REASON: Record<string, string> = { RECEIVED: "Received", USED: "Used on ticket", RETURNED: "Returned to stock", ADJUSTED: "Count corrected" };

export default async function PartPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const p = await db.part.findFirst({
    where: { id, shopId: user.shopId },
    include: {
      moves: { orderBy: { createdAt: "desc" }, take: 100, include: { user: { select: { name: true } } } },
      sources: { orderBy: [{ preferred: "desc" }, { createdAt: "asc" }] },
    },
  });
  if (!p) notFound();
  const [joined, xrefs, myListings] = await Promise.all([
    hubJoined(),
    xrefForKeys(p.numberKeys),
    db.listing.findMany({ where: { mine: true, numberKey: { in: p.numberKeys } }, orderBy: { createdAt: "desc" } }),
  ]);
  const ticketIds = [...new Set(p.moves.map((m) => m.ticketId).filter(Boolean))] as string[];
  const tickets = await db.ticket.findMany({ where: { id: { in: ticketIds }, shopId: user.shopId }, select: { id: true, number: true } });
  const tno = new Map(tickets.map((t) => [t.id, t.number]));

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/parts", label: "Parts" }}
        title={
          <>
            <span className="mono">{p.partNumber}</span> {p.description}
          </>
        }
        sub={`${p.kind !== "PART" ? `${KIND_LABEL[p.kind]} · ` : ""}${p.qtyOnHand} on hand${p.location ? ` · bin ${p.location}` : ""}${p.qtyOnHand <= p.reorderAt ? " · time to reorder" : ""}`}
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Section title="Stock">
            <div className="mb-4 grid grid-cols-3 gap-3">
              <KV k="On hand" v={<span className="num text-xl font-semibold">{p.qtyOnHand}</span>} />
              <KV k="Cost" v={money(p.costCents)} />
              <KV k="Price" v={money(p.priceCents)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <ActionForm action={moveStock.bind(null, p.id)} reset success="Stock received" className="space-y-2 rounded border border-line p-3">
                <input type="hidden" name="mode" value="receive" />
                <div className="label">Receive stock</div>
                <div className="flex gap-2">
                  <input name="qty" aria-label="Quantity received" inputMode="numeric" className="input num w-20" placeholder="qty" required />
                  <input name="cost" aria-label="Cost each" inputMode="decimal" className="input num" placeholder="$ cost each (optional)" />
                </div>
                <input name="note" aria-label="Note" className="input" placeholder="PO / supplier invoice" />
                <Submit className="btn btn-sm">Receive</Submit>
              </ActionForm>
              <ActionForm action={moveStock.bind(null, p.id)} reset success="Count updated" className="space-y-2 rounded border border-line p-3">
                <input type="hidden" name="mode" value="count" />
                <div className="label">Shelf count</div>
                <input name="qty" aria-label="Counted quantity" inputMode="numeric" className="input num" placeholder="what's actually there" required />
                <input name="note" aria-label="Note" className="input" placeholder="reason (optional)" />
                <Submit className="btn btn-sm">Set count</Submit>
              </ActionForm>
            </div>
          </Section>
          <Section title="Where to buy">
            {p.sources.length === 0 && !xrefs.some((x) => (x.sources as XSource[]).length) ? (
              <p className="muted text-sm">No suppliers yet. Add where you buy it.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {p.sources.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer" className="link">
                          {s.vendor} <ExternalLink size={10} className="inline" aria-hidden />
                        </a>
                      ) : (
                        s.vendor
                      )}
                      {s.preferred && <span className="pill tone-ready ml-2">preferred</span>}
                      {s.note && <span className="muted text-xs"> · {s.note}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      {s.priceCents != null && <span className="num">{money(s.priceCents)}</span>}
                      {!s.preferred && (
                        <ActionButton action={preferPartSource.bind(null, p.id, s.id)} className="btn btn-sm">
                          Prefer
                        </ActionButton>
                      )}
                      <ActionButton action={removePartSource.bind(null, p.id, s.id)} className="btn btn-sm btn-danger" confirm="Remove?" title="Remove supplier">
                        <Trash2 size={12} aria-label="Remove" />
                      </ActionButton>
                    </span>
                  </li>
                ))}
                {xrefs.flatMap((x) =>
                  (x.sources as XSource[]).map((s, i) => (
                    <li key={`${x.id}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {s.url ? (
                          <a href={s.url} target="_blank" rel="noreferrer" className="link">
                            {s.vendor} <ExternalLink size={10} className="inline" aria-hidden />
                          </a>
                        ) : (
                          s.vendor
                        )}
                        <span className="muted text-xs"> · shared{s.byShop ? ` by ${s.byShop}` : ""}</span>
                      </span>
                      {s.priceCents != null && <span className="num">{money(s.priceCents)}</span>}
                    </li>
                  )),
                )}
              </ul>
            )}
            <details className="mt-3 border-t border-line pt-3">
              <summary className="link cursor-pointer text-sm">Add a supplier</summary>
              <ActionForm action={addPartSource.bind(null, p.id)} reset success="Supplier added" className="mt-2 grid gap-2 sm:grid-cols-2">
                <input name="vendor" aria-label="Supplier" required className="input" placeholder="Supplier, e.g. Sewing Parts Online" />
                <input name="url" aria-label="Link" type="url" className="input" placeholder="https:// link to the part" />
                <input name="price" aria-label="Price" inputMode="decimal" className="input num" placeholder="$ price" />
                <input name="note" aria-label="Note" className="input" placeholder="Note (optional)" />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="preferred" className="check" /> Preferred supplier
                </label>
                <Submit className="btn btn-sm">Add</Submit>
              </ActionForm>
            </details>
          </Section>

          <Section title="Cross-reference">
            {!joined ? (
              <p className="muted text-sm">
                Join the community hub (<Link href="/settings#hub" className="link">Settings</Link>) to see every number this part goes by and every
                machine it fits.
              </p>
            ) : xrefs.length === 0 ? (
              <div className="space-y-2 text-sm">
                <p className="muted">This part isn&apos;t in the community cross-reference yet.</p>
                <ActionButton action={addPartToCrossRef.bind(null, p.id)} className="btn btn-sm">
                  Add it to the cross-reference
                </ActionButton>
              </div>
            ) : (
              <ul className="space-y-3 text-sm">
                {xrefs.map((x) => {
                  const nums = x.numbers as XNumber[];
                  const fits = x.fits as XFit[];
                  const count = (ev: string) => fits.filter((f) => f.evidence === ev).length;
                  return (
                    <li key={x.id}>
                      <Link href={`/xref/${x.id}`} className="link font-semibold">
                        {x.name}
                      </Link>
                      <div className="mono mt-1 text-xs">{nums.map((n) => `${n.brand} ${n.number}`).join(" · ")}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs">
                        {["tested", "maker", "listed"].map((ev) =>
                          count(ev) ? (
                            <span key={ev} className="pill tone-neutral">
                              {count(ev)} · {EVIDENCE_LABEL[ev]}
                            </span>
                          ) : null,
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section title="Sell it on the marketplace">
            {!joined ? (
              <p className="muted text-sm">The marketplace is on the community hub. Join it in Settings to sell to other shops.</p>
            ) : (
              <>
                {myListings.length > 0 && (
                  <ul className="mb-3 divide-y divide-line text-sm">
                    {myListings.map((l) => (
                      <li key={l.id} className="flex justify-between gap-2 py-2">
                        <Link href={`/market/${l.id}`} className="link">
                          {l.title}
                        </Link>
                        <span className="num">
                          {l.qty} × {money(l.priceCents)} <span className="pill tone-neutral">{l.status.toLowerCase()}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="link cursor-pointer text-sm">List it for sale</summary>
                  <div className="mt-2">
                    <ListingForm
                      defaults={{
                        title: p.description,
                        partNumber: p.partNumber,
                        brand: p.brand,
                        fits: p.fits,
                        kind: p.kind,
                        priceCents: p.priceCents,
                        qty: Math.max(1, p.qtyOnHand),
                      }}
                    />
                  </div>
                </details>
              </>
            )}
          </Section>

          <Section title="History">
            <ul className="divide-y divide-line text-sm">
              {p.moves.map((m) => (
                <li key={m.id} className="flex justify-between gap-2 py-2">
                  <span>
                    {fmtDate(m.createdAt)} · {REASON[m.reason]}
                    {m.ticketId && tno.has(m.ticketId) && (
                      <>
                        {" "}
                        <Link href={`/tickets/${m.ticketId}`} className="link mono">
                          #{String(tno.get(m.ticketId)).padStart(4, "0")}
                        </Link>
                      </>
                    )}
                    {m.note && <span className="muted"> · {m.note}</span>}
                    {m.user && <span className="muted"> · {m.user.name}</span>}
                  </span>
                  <span className={`num font-semibold ${m.qty < 0 ? "text-thread" : ""}`}>{m.qty > 0 ? `+${m.qty}` : m.qty}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
        <Section title="Details">
          <ActionForm action={updatePart.bind(null, p.id)} success="Saved" className="grid-form">
            <PartFields part={p} />
            <div className="sm:col-span-2">
              <Submit>Save</Submit>
            </div>
          </ActionForm>
        </Section>
      </div>
    </div>
  );
}
