// Paperwork → Warranty claims (shop-features-round-2-design.md 9.1): what each maker owes (sent and waiting), paid, short
// and refused, then the claims themselves. A claim starts on a ticket: "Claim it from the maker" on a line.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { CLAIM_LABEL, CLAIM_STATUSES, CLAIM_TONE, claimsFor, makerSummary } from "@/lib/warranty-claims";
import { Empty, Section } from "@/components/ui";
import { PaperFrame } from "@/components/paperwork/frame";

export default async function WarrantyClaimsPage({ searchParams }: { searchParams: Promise<{ status?: string; maker?: string }> }) {
  const user = await requireUser();
  const q = await searchParams;
  const [makers, claims, tz] = await Promise.all([makerSummary(user.shopId), claimsFor(user.shopId, { status: q.status, maker: q.maker }), shopTimeZone(user.shopId)]);
  const filtered = !!(q.status || q.maker);
  return (
    <PaperFrame title="Warranty claims" tab="warranty" admin={user.role !== "TECH"} sub="Work the maker pays for. Send each claim through the maker's own website, then record what came in here.">
      <Section title="By maker">
        {makers.length ? (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Maker</th>
                  <th className="text-right">Not sent</th>
                  <th className="text-right">Waiting</th>
                  <th className="text-right">Owed to you</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Short</th>
                  <th className="text-right">Refused</th>
                </tr>
              </thead>
              <tbody>
                {makers.map((m) => (
                  <tr key={m.maker}>
                    <td>
                      <Link href={`/paperwork/warranty?maker=${encodeURIComponent(m.maker)}`} className="link">
                        {m.maker}
                      </Link>
                    </td>
                    <td className="num text-right">{m.open || ""}</td>
                    <td className="num text-right">{m.waiting || ""}</td>
                    <td className="num text-right font-semibold">{m.owedCents ? money(m.owedCents) : ""}</td>
                    <td className="num text-right">{m.paid + m.short ? `${m.paid + m.short} · ${money(m.paidCents)}` : ""}</td>
                    <td className="num text-right">{m.short ? `${m.short} · ${money(m.shortCents)}` : ""}</td>
                    <td className="num text-right">{m.refused ? `${m.refused} · ${money(m.refusedCents)}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No warranty claims yet. On a repair ticket, tap &quot;Claim it from the maker&quot; on a line the maker pays for: the customer isn&apos;t charged and the claim starts here.</Empty>
        )}
      </Section>
      {(claims.length > 0 || filtered) && (
        <Section
          title={q.maker ? `Claims to ${q.maker}` : "Claims"}
          actions={
            <nav className="flex flex-wrap gap-1 text-sm" aria-label="Show">
              <Link href="/paperwork/warranty" className={`btn btn-sm ${!q.status ? "btn-primary" : ""}`}>
                All
              </Link>
              {CLAIM_STATUSES.map((s) => (
                <Link key={s} href={`/paperwork/warranty?status=${s}${q.maker ? `&maker=${encodeURIComponent(q.maker)}` : ""}`} className={`btn btn-sm ${q.status === s ? "btn-primary" : ""}`}>
                  {CLAIM_LABEL[s]}
                </Link>
              ))}
            </nav>
          }
        >
          {claims.length ? (
            <ul className="divide-y divide-line">
              {claims.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-base">
                    <Link href={`/paperwork/warranty/${c.id}`} className="link">
                      Claim #{c.number} to {c.maker}
                    </Link>
                    {c.claimNumber && <span className="muted text-sm"> · their number {c.claimNumber}</span>}
                    {c.filedAt && <span className="muted text-sm"> · sent {fmtDate(c.filedAt, tz)}</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-base">
                    <span className="num">{money(c.expectedCents)}</span>
                    {(c.status === "PAID" || c.status === "SHORT") && <span className="num muted text-sm">came in {money(c.receivedCents)}</span>}
                    <span className={`pill ${CLAIM_TONE[c.status] ?? ""}`}>{CLAIM_LABEL[c.status] ?? c.status}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No claims here.</Empty>
          )}
        </Section>
      )}
    </PaperFrame>
  );
}
