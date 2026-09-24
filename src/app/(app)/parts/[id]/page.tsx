import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { PageHeader, Section, KV } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { PartFields } from "@/components/part-fields";
import { moveStock, updatePart } from "@/actions/parts";

const REASON: Record<string, string> = { RECEIVED: "Received", USED: "Used on ticket", RETURNED: "Returned to stock", ADJUSTED: "Count corrected" };

export default async function PartPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const p = await db.part.findFirst({
    where: { id, shopId: user.shopId },
    include: { moves: { orderBy: { createdAt: "desc" }, take: 100, include: { user: { select: { name: true } } } } },
  });
  if (!p) notFound();
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
        sub={`${p.qtyOnHand} on hand${p.location ? ` · bin ${p.location}` : ""}${p.qtyOnHand <= p.reorderAt ? " · time to reorder" : ""}`}
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
