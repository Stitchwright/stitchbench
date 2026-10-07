// A customer's page, phase 6 records (shop-features-round-2-design.md section 9): her machines on consignment and what
// the shop owes her for them. Shows only what applies. Server component.
import Link from "next/link";
import { db } from "@/lib/db";
import { owedToConsignor } from "@/lib/consign-machines";
import { Section } from "@/components/ui";
import { PayoutLine } from "@/components/paperwork/consign-parts";

export async function CustomerPaperwork({ shopId, customerId, admin }: { shopId: string; customerId: string; admin: boolean }) {
  const [owed, consigned] = await Promise.all([owedToConsignor(shopId, customerId), db.stockUnit.count({ where: { shopId, consignorId: customerId } })]);
  if (!owed.length && !consigned) return null;
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
