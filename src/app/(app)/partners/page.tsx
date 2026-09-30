import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { acceptedBoth, normalizeTerms, type Accepted } from "@/lib/partner-terms";
import { PageHeader, Section, Empty } from "@/components/ui";
import { ActionForm, ActionButton, Submit } from "@/components/action-form";
import { PartnerCodeForm } from "@/components/partner-code-form";
import { TermsFields } from "@/components/terms-fields";
import { enterPartnerCode, resendPartnerMessage, setUpSewingShop, syncPartnersNow } from "@/actions/partners";
import { isPlatformAdmin } from "@/lib/shops";

/** Partner shops: the sewing / quilt shops that take machines in for this repair shop, or the repair shop this sewing shop uses. */
export default async function Partners({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const tz = await shopTimeZone(user.shopId);
  const { error } = await searchParams;
  const [shop, links, hub] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { doesRepair: true } }),
    db.partnerLink.findMany({ where: { shopId: user.shopId }, orderBy: [{ status: "asc" }, { partnerName: "asc" }] }),
    db.hubState.findUnique({ where: { id: 1 } }),
  ]);
  const counts = await db.repairJob.groupBy({
    by: ["linkId"],
    where: { shopId: user.shopId, status: { notIn: ["COLLECTED", "ABANDONED", "RETURNED_UNREPAIRED"] } },
    _count: true,
  });
  const openJobs = new Map(counts.map((c) => [c.linkId, c._count]));
  const orders = await db.partnerOrder.groupBy({ by: ["linkId"], where: { shopId: user.shopId, status: { in: ["PLACED", "ACCEPTED", "DELIVERED"] } }, _count: true });
  const openOrders = new Map(orders.map((c) => [c.linkId, c._count]));
  const admin = user.role !== "TECH";
  // What didn't get through, either way: shown so nothing is lost quietly.
  const [failures, stuck] = await Promise.all([
    db.partnerFailure.findMany({ where: { shopId: user.shopId }, orderBy: { at: "desc" }, take: 30 }),
    db.partnerOutbox.findMany({ where: { shopId: user.shopId, sentAt: null, OR: [{ deadAt: { not: null } }, { tries: { gte: 3 } }] }, orderBy: { createdAt: "asc" }, take: 30 }),
  ]);
  const nameOf = new Map(links.map((l) => [l.id, l.partnerName]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner shops"
        sub={
          shop.doesRepair
            ? "Sewing and quilt shops that take machines in for you, buy parts and notions from you and sell your stock on consignment."
            : "The repair shop you send machines to, order from, and whose stock you sell on consignment."
        }
        actions={<ActionButton action={syncPartnersNow} success="Synced with partners">Sync now</ActionButton>}
      />
      {error && (
        <p className="pill tone-bad" role="alert">
          {error}
        </p>
      )}
      {hub?.partnerError && <p className="pill tone-bad">Last partner sync failed: {hub.partnerError}</p>}
      {hub?.partnerSyncAt && <p className="muted text-xs">Last synced {fmtDateTime(hub.partnerSyncAt, tz)}</p>}

      <Section title="Partners">
        {links.length === 0 ? (
          <Empty>No partners yet. Make a code below for the other shop, or enter the code they gave you.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Shop</th>
                  <th>They are</th>
                  <th>Terms</th>
                  <th className="text-right">Machines in work</th>
                  <th className="text-right">Open orders</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => {
                  const t = normalizeTerms(l.terms);
                  const agreed = acceptedBoth((l.accepted as Accepted) ?? {}, l.termsVersion);
                  return (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/partners/${l.id}`} className="link font-semibold">
                          {l.partnerName}
                        </Link>
                        {l.status === "ENDED" && <span className="pill tone-bad ml-1">ended</span>}
                      </td>
                      <td>{l.side === "repair" ? "Sewing shop" : "Repair shop"}</td>
                      <td className="text-xs">
                        {t.repairCommissionPct}% on repairs · keeps {t.consignSharePct}% of consigned sales{" "}
                        {agreed ? <span className="pill tone-done">agreed</span> : <span className="pill tone-wait">not yet agreed</span>}
                      </td>
                      <td className="num text-right">{openJobs.get(l.id) ?? 0}</td>
                      <td className="num text-right">{openOrders.get(l.id) ?? 0}</td>
                      <td>{fmtDate(l.createdAt, tz)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {(failures.length > 0 || stuck.length > 0) && (
        <Section title="Messages that didn't get through">
          <ul className="space-y-2 text-sm">
            {stuck.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  To {nameOf.get(m.linkId) ?? "a partner"}: <span className="mono">{m.type}</span> from {fmtDate(m.createdAt, tz)} —{" "}
                  {m.deadAt ? "refused by the hub" : `still trying (${m.tries} tries)`}: {m.error}
                </span>
                {m.deadAt && admin && (
                  <ActionButton action={resendPartnerMessage.bind(null, m.id)} success="Queued again">
                    Send again
                  </ActionButton>
                )}
              </li>
            ))}
            {failures.map((f) => (
              <li key={f.key}>
                From {nameOf.get(f.linkId) ?? "a partner"}: <span className="mono">{f.type}</span> on {fmtDate(f.at, tz)} —{" "}
                {f.skipped ? "set aside, not applied" : `failing (${f.tries} tries)`}: {f.error}
              </li>
            ))}
          </ul>
          <p className="muted mt-2 text-xs">Set-aside messages came with data that couldn&apos;t be used. Ask the partner shop what they meant to send.</p>
        </Section>
      )}

      {admin && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Section title="Enter a partner code">
            <ActionForm action={enterPartnerCode} className="space-y-3">
              <p className="muted text-sm">
                The other shop made a code for you (like <span className="mono">7KQP-M2XH-9TRD</span>). Entering it connects the two shops.
                {!hub?.installKey && " This install isn't on a hub yet; the code connects it for partner shops only."}
              </p>
              <div className="field">
                <label htmlFor="code" className="label">
                  Partner code
                </label>
                <input id="code" name="code" required autoComplete="off" className="input mono text-lg" />
              </div>
              <Submit>Connect</Submit>
            </ActionForm>
          </Section>
          <Section title="Make a code for another shop">
            {hub?.installKey ? (
              <PartnerCodeForm defaultSide={shop.doesRepair ? "repair" : "retail"}>
                <TermsFields />
              </PartnerCodeForm>
            ) : (
              <p className="text-sm">
                Making codes needs the community hub. Join it in{" "}
                <Link href="/settings#hub" className="link">
                  Settings
                </Link>
                , or enter the code the other shop made for you.
              </p>
            )}
          </Section>
        </div>
      )}
      {admin && shop.doesRepair && isPlatformAdmin(user.email) && (
        <Section title="Set up StitchShop for a sewing shop">
          <p className="muted mb-3 text-sm">
            Offer a quilt or sewing shop the register, inventory and repair tracking at no charge, in return for sending you their repairs and giving
            your stock shelf space. This makes their company and owner login on this install, already partnered with you on the terms below. Give
            the owner the temporary password; they sign in at this same address and change it. (For them to reach it from their own counter, this
            install needs to be online: see INSTALL.md, &quot;Hosted&quot;. Or give them the Windows program and a partner code instead.)
          </p>
          <ActionForm action={setUpSewingShop} className="grid-form" success="Set up and partnered" reset>
            <div className="field">
              <label htmlFor="ss-shop" className="label">
                Sewing shop&apos;s name
              </label>
              <input id="ss-shop" name="shop" required className="input" />
            </div>
            <div className="field">
              <label htmlFor="ss-name" className="label">
                Owner&apos;s name
              </label>
              <input id="ss-name" name="name" required className="input" />
            </div>
            <div className="field">
              <label htmlFor="ss-email" className="label">
                Owner&apos;s email (their login)
              </label>
              <input id="ss-email" name="email" type="email" required className="input" />
            </div>
            <div className="field">
              <label htmlFor="ss-pw" className="label">
                Temporary password (8+ characters)
              </label>
              <input id="ss-pw" name="password" required minLength={8} className="input" autoComplete="new-password" />
            </div>
            <TermsFields idPrefix="ss-" />
            <div className="sm:col-span-2">
              <Submit>Set up their shop</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
      <p className="muted text-xs">
        Money between partners: each month&apos;s statement nets repairs, consigned sales and orders into one amount, settled with one payment.
      </p>
    </div>
  );
}
