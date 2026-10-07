// A customer's page, phase 6 records (shop-features-round-2-design.md section 9): her machines on consignment and what
// the shop owes her for them. Shows only what applies. Server component.
import Link from "next/link";
import { db } from "@/lib/db";
import { owedToConsignor } from "@/lib/consign-machines";
import { appraisalsFor } from "@/lib/appraisals";
import { money } from "@/lib/format";
import { Section } from "@/components/ui";
import { PayoutLine } from "@/components/paperwork/consign-parts";

export async function CustomerPaperwork({ shopId, customerId, admin }: { shopId: string; customerId: string; admin: boolean }) {
  const [owed, consigned, appraisals] = await Promise.all([owedToConsignor(shopId, customerId), db.stockUnit.count({ where: { shopId, consignorId: customerId } }), appraisalsFor(shopId, customerId)]);
  return (
    <>
      {(owed.length > 0 || consigned > 0) && <Consigned customerId={customerId} owed={owed} admin={admin} />}
      {appraisals.length > 0 && (
        <Section title="Quilt appraisals">
          <ul className="divide-y divide-line">
            {appraisals.map((a) => (
              <li key={a.id} className="flex justify-between gap-2 py-2 text-base">
                <Link href={`/appraisals/${a.id}`} className="link">
                  #{a.number} {a.title}
                </Link>
                <span className="num">{money(a.valueCents)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function Consigned({ customerId, owed, admin }: { customerId: string; owed: Awaited<ReturnType<typeof owedToConsignor>>; admin: boolean }) {
  return (
    <Section
      title="Her machines on consignment"
      actions={
        <Link href={`/paperwork/consign/${customerId}`} className="btn btn-sm">
          Statement
        </Link>
      }
    >
      {owed.length ? (
        <ul className="divide-y divide-line">
          {owed.map((p) => (
            <PayoutLine key={p.id} p={p} admin={admin} showWho={false} />
          ))}
        </ul>
      ) : (
        <p className="muted text-sm">Nothing owed to her now. The statement lists her machines and what was paid.</p>
      )}
    </Section>
  );
}
