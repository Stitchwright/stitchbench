// The counter tablet's consent page (scheduling-messaging-design.md 8.3). Outside (app) on purpose: no nav, no search
// box, nothing a customer holding the tablet could wander into. Any signed-in user may open it for their own customer.
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { fmtPhone, toE164, usMarketingNumber } from "@/lib/phone";
import { consentWording, messagingView } from "@/lib/messaging/settings";
import { ConsentSign } from "@/components/consent-sign";

export default async function ConsentPage({ params }: { params: Promise<{ customerId: string }> }) {
  const user = await requireUser();
  const { customerId } = await params;
  const c = await db.customer.findFirst({ where: { id: customerId, shopId: user.shopId } });
  if (!c) notFound();
  const [shop, ms] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true, timeZone: true } }), messagingView(user.shopId)]);
  const number = toE164(c.phone);
  const stopped = number ? await db.suppression.findUnique({ where: { shopId_channel_address: { shopId: user.shopId, channel: "sms", address: number } }, select: { at: true } }) : null;

  let problem: string | null = null;
  if (c.kind !== "RETAIL") problem = "Trade accounts get no marketing texts.";
  else if (!number) problem = "There's no mobile number on file. Add one on the customer's page first.";
  else if (!usMarketingNumber(number)) problem = "Marketing texts go only to US mobile numbers.";
  else if (stopped) problem = "This number replied STOP. They must text START to the shop's number first.";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-10 text-lg">
      <header className="text-center">
        <div className="text-3xl font-bold">{shop.name}</div>
        {shop.phone && <div className="muted text-xl">{shop.phone}</div>}
      </header>
      <section className="space-y-2 text-center">
        <div className="text-2xl font-semibold">{c.name}</div>
        {number && <div className="mono text-2xl">{fmtPhone(number)}</div>}
      </section>
      {problem ? (
        <p className="card card-pad text-center text-xl" role="status">
          {problem}
        </p>
      ) : (
        <>
          <p className="card card-pad text-xl leading-relaxed">{consentWording(ms, shop.name)}</p>
          {c.smsConsentAt && c.smsConsentPhone === number && <p className="muted text-center">Already agreed on {fmtDate(c.smsConsentAt, shop.timeZone)}. Signing again is fine.</p>}
          <ConsentSign customerId={c.id} />
        </>
      )}
    </main>
  );
}
