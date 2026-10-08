// A customer's page, phase 6 records (shop-features-round-2-design.md section 9): her wish lists, her machines on
// consignment and what the shop owes her for them, her quilt appraisals. Shows only what applies. Server component.
import Link from "next/link";
import { db } from "@/lib/db";
import { owedToConsignor } from "@/lib/consign-machines";
import { appraisalsFor } from "@/lib/appraisals";
import { money } from "@/lib/format";
import { registriesFor } from "@/lib/gift-registry";
import { startGiftList } from "@/actions/gift-registry";
import { ActionForm, Submit } from "@/components/action-form";
import { accountOf } from "@/lib/house-accounts";
import { AccountTerms } from "@/components/paperwork/account-terms";
import { Section } from "@/components/ui";
import { PayoutLine } from "@/components/paperwork/consign-parts";

export async function CustomerPaperwork({ shopId, customerId, admin, retail = true }: { shopId: string; customerId: string; admin: boolean; retail?: boolean }) {
  const [owed, consigned, appraisals, lists, shop] = await Promise.all([
    owedToConsignor(shopId, customerId),
    db.stockUnit.count({ where: { shopId, consignorId: customerId } }),
    appraisalsFor(shopId, customerId),
    registriesFor(shopId, customerId),
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { sellsRetail: true, houseAccountsOn: true } }),
  ]);
  const account = await accountOf(shopId, customerId);
  return (
    <>
      {account ? (
        <Section
          title="House account"
          actions={
            <Link href={`/paperwork/accounts/${account.id}`} className="btn btn-sm">
              Open the account
            </Link>
          }
        >
          <p className="text-base">
            Owes {money(account.balanceCents)}
            {account.aging.d30 + account.aging.d60 + account.aging.d90 > 0 ? `, ${money(account.aging.d30 + account.aging.d60 + account.aging.d90)} of it past 30 days` : ""}. {account.limitCents ? `Limit ${money(account.limitCents)}.` : "No limit."} {account.termsDays} days to pay.
            {account.status === "CLOSED" ? " Closed to new charges." : ""}
          </p>
        </Section>
      ) : (
        shop.houseAccountsOn &&
        admin && (
          <Section title="House account">
            <details>
              <summary className="link cursor-pointer text-sm">Let her buy now and pay from a monthly statement</summary>
              <div className="mt-2">
                <AccountTerms customerId={customerId} limitCents={0} termsDays={30} status="OPEN" opening />
              </div>
            </details>
          </Section>
        )
      )}
      {retail && shop.sellsRetail && (
        <Section title="Wish lists">
          {lists.length > 0 && (
            <ul className="mb-3 divide-y divide-line">
              {lists.map((l) => (
                <li key={l.id} className="flex justify-between gap-2 py-2 text-base">
                  <Link href={`/gift-lists/${l.id}`} className="link">
                    {l.title}
                  </Link>
                  <span className="muted text-sm">{l.closedAt ? "not shared" : l.eventDate ? `for ${l.eventDate}` : "shared"}</span>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary className="link cursor-pointer text-sm">{lists.length ? "Start another list" : "Start a wish list or gift registry she can share with family"}</summary>
            <ActionForm action={startGiftList.bind(null, customerId)} className="mt-2 flex flex-wrap items-end gap-2">
              <div className="field">
                <label className="label" htmlFor={`gl-title-${customerId}`}>
                  Name of the list
                </label>
                <input id={`gl-title-${customerId}`} name="title" className="input" maxLength={80} placeholder="Birthday wishes" />
              </div>
              <div className="field">
                <label className="label" htmlFor={`gl-day-${customerId}`}>
                  For the day (optional)
                </label>
                <input id={`gl-day-${customerId}`} name="eventDate" type="date" className="input" />
              </div>
              <Submit>Start the list</Submit>
            </ActionForm>
          </details>
        </Section>
      )}
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
