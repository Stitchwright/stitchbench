import { HistoryLink } from "@/components/history-link";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money, moneyCost } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { PageHeader, Section, KV } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { ListingCard } from "@/components/shop/listing-card";
import { PartFields } from "@/components/part-fields";
import { addPartSource, moveStock, preferPartSource, removePartSource, updatePart } from "@/actions/parts";
import { addPartToCrossRef } from "@/actions/xref";
import { ActionButton } from "@/components/action-form";
import { OfferPartForm } from "@/components/offer-part-form";
import { withdrawOffer } from "@/actions/market";
import { PartSearchLinks } from "@/components/part-search-links";
import { hubJoined } from "@/lib/hub";
import { listingDefaultsFor, offersFor } from "@/lib/offer";
import { EVIDENCE_LABEL, KIND_LABEL, baseNumber, xrefForKeys, type XFit, type XNumber, type XSource } from "@/lib/parts";
import { partTags } from "@/lib/part-labels";
import { ExternalLink, Trash2 } from "lucide-react";
import { qtyText } from "@/lib/register-math";

const REASON: Record<string, string> = {
  RECEIVED: "Received",
  USED: "Used on ticket",
  RETURNED: "Returned to stock",
  ADJUSTED: "Count corrected",
  SOLD: "Sold",
  CONSIGNED: "Consignment",
};

export default async function PartPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ existing?: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const { existing } = await searchParams;
  const p = await db.part.findFirst({
    where: { id, shopId: user.shopId },
    include: {
      moves: { orderBy: { createdAt: "desc" }, take: 100, include: { user: { select: { name: true } } } },
      sources: { orderBy: [{ preferred: "desc" }, { createdAt: "asc" }] },
    },
  });
  if (!p) notFound();
  const [joined, xrefs, offers] = await Promise.all([hubJoined(), xrefForKeys(p.numberKeys), offersFor(user.shopId, p)]);
  const ticketIds = [...new Set(p.moves.map((m) => m.ticketId).filter(Boolean))] as string[];
  const tickets = await db.ticket.findMany({ where: { id: { in: ticketIds }, shopId: user.shopId }, select: { id: true, number: true } });
  const tno = new Map(tickets.map((t) => [t.id, t.number]));
  const consignedBy = p.consignLinkId ? await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id: p.consignLinkId } } }) : null;
  const shopFlags = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true, shopOn: true } });

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><HistoryLink role={user.role} type="Part" id={p.id} /></div>
      <PageHeader
        back={{ href: "/parts", label: "Parts" }}
        title={
          <>
            <span className="mono">{p.partNumber}</span> {p.description}
          </>
        }
        sub={
          <>
            {partTags(p).map((t) => (
              <span key={t} className="pill tone-wait mr-2">
                {t}
              </span>
            ))}
            {`${p.kind !== "PART" ? `${KIND_LABEL[p.kind]} · ` : ""}${qtyText(p.qtyOnHand, p.unit)} on hand${p.location ? ` · bin ${p.location}` : ""}${p.qtyOnHand <= p.reorderAt ? " · time to reorder" : ""}`}
          </>
        }
        actions={
          <>
            <a href={`/labels?id=${p.id}&format=thermal`} target="_blank" rel="noreferrer" className="btn">
              Print label
            </a>
            <Link href="/parts/scan" className="btn">
              Scan
            </Link>
          </>
        }
      />
      {existing && (
        <p className="card card-pad text-sm" role="status">
          This number was already in your inventory, so this is the item that was there: nothing you typed was saved. Change it under Details below.
        </p>
      )}
      {consignedBy && (
        <p className="card card-pad text-sm">
          On consignment from <strong>{consignedBy.partnerName}</strong>: it stays theirs until it sells. Each sale is reported to them and shows on your monthly statement.{" "}
          <Link href={`/partners/${consignedBy.id}`} className="link">
            Partnership
          </Link>
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Section title="Stock">
            <div className="mb-4 grid grid-cols-3 gap-3">
              <KV k="On hand" v={<span className="num text-xl font-semibold">{qtyText(p.qtyOnHand, p.unit)}</span>} />
              <KV k="Cost" v={moneyCost(p.costCents, p.costTenThou)} />
              <KV k="Price" v={money(p.priceCents)} />
            </div>
            {p.consignLinkId ? (
              <p className="muted text-sm">A partner&apos;s consigned stock: the partner places, counts and takes it back. Receive your own stock of it as a separate item.</p>
            ) : (
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
            )}
          </Section>
          {shopFlags.sellsRetail && <ListingCard part={p} admin={user.role !== "TECH"} shopOn={shopFlags.shopOn} />}
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
            <div className="mt-3">
              <PartSearchLinks numbers={p.ownNumber ? p.altNumbers : [baseNumber(p.partNumber), ...p.altNumbers]} />
            </div>
            <details className="mt-3 border-t border-line pt-3">
              <summary className="link cursor-pointer text-sm">Add a supplier</summary>
              <ActionForm action={addPartSource.bind(null, p.id)} reset success="Supplier added" className="mt-2 grid gap-2 sm:grid-cols-2">
                <input name="vendor" aria-label="Supplier" required className="input" placeholder="Supplier, e.g. Sewing Parts Online (or 3D print file)" />
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
                Join the community hub (
                <Link href="/settings#hub" className="link">
                  Settings
                </Link>
                ) to see every number this part goes by and every machine it fits.
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

          {/* Sharing is chosen per item (HANDOFF item 9): where this part is offered now, plainly, and one form to offer it. */}
          <Section title="Offer this part">
            {p.consignLinkId ? (
              <p className="muted text-sm">A partner&apos;s consigned stock is theirs to offer, not yours.</p>
            ) : (
              <>
                {!offers.partners.on && offers.listings.length === 0 && <p className="muted mb-3 text-sm">Not offered anywhere. Nothing about it leaves the shop until you offer it.</p>}
                {(offers.partners.on || offers.listings.length > 0) && (
                  <ul className="mb-3 divide-y divide-line text-sm">
                    {offers.partners.on && (
                      <li className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>
                          <span className="pill tone-ready mr-2">Offered to partner shops</span>
                          {offers.partners.wholesaleCents != null ? (
                            <span className="num">{money(offers.partners.wholesaleCents)} each</span>
                          ) : (
                            <span className="muted">no partner price yet, so their catalog leaves it out</span>
                          )}
                        </span>
                        {user.role !== "TECH" && (
                          <ActionButton action={withdrawOffer.bind(null, p.id, "partners", null)} className="btn btn-sm" confirm="Withdraw from partner shops?" success="Withdrawn from partner shops">
                            Withdraw
                          </ActionButton>
                        )}
                      </li>
                    )}
                    {offers.listings.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>
                          <span className="pill tone-ready mr-2">Listed on the marketplace</span>
                          <Link href={`/market/${l.id}`} className="link">
                            {l.title}
                          </Link>{" "}
                          <span className="num">
                            {l.qty} × {money(l.priceCents)}
                          </span>{" "}
                          <span className="pill tone-neutral">{l.status.toLowerCase()}</span>
                        </span>
                        <ActionButton action={withdrawOffer.bind(null, p.id, "market", l.id)} className="btn btn-sm" confirm="Take it off the marketplace?" success="Taken off the marketplace">
                          Withdraw
                        </ActionButton>
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="link cursor-pointer text-sm">Offer this part</summary>
                  <div className="mt-2">
                    <OfferPartForm partId={p.id} listing={listingDefaultsFor(p)} wholesaleCents={p.wholesaleCents} mayOfferToPartners={user.role !== "TECH"} hubJoined={joined} />
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
                    {fmtDate(m.createdAt, tz)} · {REASON[m.reason]}
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
            <PartFields part={p} lockMoney={user.role === "TECH"} />
            <div className="sm:col-span-2">
              <Submit>Save</Submit>
            </div>
          </ActionForm>
        </Section>
      </div>
    </div>
  );
}
