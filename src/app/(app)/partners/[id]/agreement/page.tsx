import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { acceptedBoth, COMMISSION_ON_LABEL, CUSTOMERS_PAY_LABEL, normalizeTerms, type Accepted, type PartnerTerms } from "@/lib/partner-terms";
import { PageHeader, Section } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { ActionForm, Submit } from "@/components/action-form";
import { TermsFields } from "@/components/terms-fields";
import { acceptPartnerTerms, proposePartnerTerms } from "@/actions/partners";

export default async function Agreement({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { id } = await params;
  const link = await db.partnerLink.findUnique({ where: { shopId_id: { shopId: user.shopId, id } } });
  if (!link) notFound();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId } });
  const terms = normalizeTerms(link.terms);
  const accepted = (link.accepted as Accepted) ?? {};
  const repairName = link.side === "repair" ? shop.name : link.partnerName;
  const sewingName = link.side === "retail" ? shop.name : link.partnerName;
  const mine = accepted[link.side as "repair" | "retail"];
  const iAccepted = mine?.version === link.termsVersion;
  const proposal = link.proposedTerms as { version: number; terms: PartnerTerms; by: { name: string; at: string } } | null;
  const theirProposal = proposal && link.proposedBy !== link.side ? proposal : null;
  const admin = user.role !== "TECH";

  return (
    <div className="space-y-6">
      <PageHeader back={{ href: `/partners/${id}`, label: link.partnerName }} title="Partner agreement" sub={`Version ${link.termsVersion}`} actions={<PrintButton />} />
      <p className="no-print muted text-xs">
        This agreement is filled in from the terms both shops set in StitchBench. It&apos;s a plain-language starting point, not legal advice: have your own
        attorney look at it before you rely on it, especially the parts about unclaimed machines and consigned stock, which differ by state.
      </p>

      {theirProposal && (
        <Section title={`${link.partnerName} proposed new terms (version ${theirProposal.version})`}>
          <AgreementText repairName={repairName} sewingName={sewingName} terms={normalizeTerms(theirProposal.terms)} />
          {admin && <AcceptForm linkId={id} label="Accept the new terms" />}
        </Section>
      )}

      <article className="card card-pad agreement space-y-3 text-sm leading-relaxed">
        <AgreementText repairName={repairName} sewingName={sewingName} terms={terms} />
        <h3 className="h2 pt-2">Signed</h3>
        <div className="grid gap-6 sm:grid-cols-2">
          {(["repair", "retail"] as const).map((side) => {
            const a = accepted[side];
            const name = side === "repair" ? repairName : sewingName;
            return (
              <div key={side}>
                <div className="font-semibold">{name}</div>
                {a && a.version === link.termsVersion ? (
                  <div>
                    Accepted in StitchBench by <strong>{a.name}</strong> on {fmtDate(a.at, tz)}
                  </div>
                ) : (
                  <div className="muted">Not accepted yet</div>
                )}
                <div className="mt-6 border-b border-line" />
                <div className="muted text-xs">Signature, name and date (if signing on paper)</div>
              </div>
            );
          })}
        </div>
      </article>

      {admin && !iAccepted && !theirProposal && (
        <Section title="Accept these terms">
          <AcceptForm linkId={id} label="Accept" />
        </Section>
      )}
      {acceptedBoth(accepted, link.termsVersion) && <p className="pill tone-done no-print">Both shops accepted version {link.termsVersion}.</p>}

      {admin && link.status === "ACTIVE" && (
        <Section title="Propose a change">
          {proposal && link.proposedBy === link.side && (
            <p className="muted mb-3 text-sm">You proposed version {proposal.version}; waiting for {link.partnerName} to accept it. Proposing again replaces it.</p>
          )}
          <ActionForm action={proposePartnerTerms.bind(null, id)} className="grid-form" success="Sent to your partner">
            <TermsFields terms={terms} />
            <div className="sm:col-span-2">
              <Submit>Send the proposed terms</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}

function AcceptForm({ linkId, label }: { linkId: string; label: string }) {
  return (
    <ActionForm action={acceptPartnerTerms.bind(null, linkId)} className="no-print mt-3 flex flex-wrap items-end gap-3" success="Accepted">
      <div className="field">
        <label htmlFor="accept-name" className="label">
          Your name
        </label>
        <input id="accept-name" name="name" required className="input" />
      </div>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="agree" className="check" /> I&apos;ve read these terms and agree to them for my shop
      </label>
      <Submit>{label}</Submit>
    </ActionForm>
  );
}

function AgreementText({ repairName, sewingName, terms: t }: { repairName: string; sewingName: string; terms: PartnerTerms }) {
  return (
    <>
      <p>
        This agreement is between <strong>{repairName}</strong> (&quot;the repair shop&quot;) and <strong>{sewingName}</strong> (&quot;the sewing
        shop&quot;).
      </p>
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          <strong>Taking machines in.</strong> The sewing shop takes customers&apos; machines in for repair on the repair shop&apos;s behalf. For each
          machine it records the customer, the machine&apos;s make, model and serial number, the problem in the customer&apos;s words, the accessories that
          came with it and photos of its condition, and gives the customer a claim tag. It does not promise a diagnosis or a price beyond the repair
          shop&apos;s posted price list.
        </li>
        <li>
          <strong>Collection and return.</strong> The repair shop collects machines{t.pickupDay ? ` on ${t.pickupDay}` : " on its regular visits"} and
          returns them repaired{t.turnaroundDays ? `, usually within ${t.turnaroundDays} days` : ""}. Each shop is responsible for a machine while it is in
          that shop&apos;s care.
        </li>
        <li>
          <strong>Estimates.</strong> Work beyond the service the customer asked for, or beyond the amount the customer approved in advance, needs the
          customer&apos;s OK. The repair shop sends the estimate through StitchBench; the sewing shop asks the customer and passes on the answer.
        </li>
        <li>
          <strong>Payment for repairs and commission.</strong> Customers pay {CUSTOMERS_PAY_LABEL[t.customersPay]}. The sewing shop earns{" "}
          <strong>{t.repairCommissionPct}%</strong> of {COMMISSION_ON_LABEL[t.commissionOn]} for each machine it takes in. When the customer pays the
          sewing shop, it keeps its commission and owes the repair shop the rest; when the customer pays the repair shop, the repair shop owes the sewing
          shop its commission.
        </li>
        <li>
          <strong>Unclaimed machines.</strong> If a customer hasn&apos;t collected a finished machine {t.abandonedAfterDays} days after being told it is
          ready, the shop holding it notifies the customer in writing and then handles it as the law where that shop is located allows.
        </li>
        <li>
          <strong>Parts, notions and accessories.</strong> The sewing shop may order items from the repair shop at the partner prices in its StitchBench
          catalog. Delivered orders are added to the monthly statement.
        </li>
        <li>
          <strong>Consignment stock.</strong> Items the repair shop places on the sewing shop&apos;s shelf remain the repair shop&apos;s property until sold.
          The sewing shop sells them at the agreed shelf price, records each sale in StitchBench, and keeps <strong>{t.consignSharePct}%</strong> of
          what each item sells for; the rest is owed to the repair shop.{" "}
          {t.shopCoversLoss
            ? "The sewing shop pays the repair shop's share of the shelf price for consigned items lost, stolen or damaged while in its care."
            : "Consigned items lost, stolen or damaged at the sewing shop are the repair shop's loss unless the sewing shop was careless."}{" "}
          The shelf is counted when either shop asks, and unsold items go back to the repair shop on request.
        </li>
        <li>
          <strong>Statements.</strong> StitchBench prepares a statement for each calendar month netting repairs, consigned sales and orders into one
          amount. The shop that owes pays it within {t.payWithinDays} days of the end of the month.
        </li>
        {t.softwareByRepairShop && (
          <li>
            <strong>Shop software.</strong> In return for the repair work and shelf space above, the repair shop sets up StitchShop (register,
            inventory, repair tracking) for the sewing shop, shows its staff how to use it and keeps it running, at no charge while this agreement
            lasts. The sewing shop&apos;s sales and customer records are its own: the repair shop won&apos;t use them for anything else, and gives the
            sewing shop a copy of them when it asks or when the partnership ends.
          </li>
        )}
        <li>
          <strong>Customer information.</strong> Each shop keeps the other&apos;s customer information private and uses it only to complete the
          customer&apos;s repair. The sewing shop shares only what the repair needs (the customer&apos;s first name and last initial, and the tag number).
        </li>
        <li>
          <strong>Ending the partnership.</strong> Either shop can end this agreement with {t.noticeDays} days&apos; written notice (StitchBench counts).
          Machines already taken in are finished and returned, the consignment shelf is counted and unsold items returned, and the last statement is
          settled.
        </li>
        {t.otherTerms && (
          <li>
            <strong>Also agreed.</strong> <span className="whitespace-pre-line">{t.otherTerms}</span>
          </li>
        )}
      </ol>
    </>
  );
}
