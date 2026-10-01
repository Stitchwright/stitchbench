// The paper consent form for marketing texts (scheduling-messaging-design.md 8.3): print it, have the customer sign
// it, then record it on their page with the code at the bottom (the code names the exact wording they signed).
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { consentCode, consentWording, messagingView } from "@/lib/messaging/settings";
import { PageHeader } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

export default async function ConsentFormPage() {
  const user = await requireUser();
  const [shop, ms] = await Promise.all([db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, address: true, phone: true, email: true } }), messagingView(user.shopId)]);
  const wording = consentWording(ms, shop.name);
  const code = consentCode(wording);

  return (
    <div>
      <div className="no-print">
        <PageHeader back={{ href: "/customers", label: "Customers" }} title="Text sign-up form" sub="Print it for customers who'd rather sign on paper." actions={<PrintButton />} />
      </div>
      <article className="card mx-auto max-w-3xl bg-white p-8 text-black print:border-0 print:p-0">
        <header className="border-b border-line pb-4">
          <div className="text-xl font-bold">{shop.name}</div>
          {shop.address && <div className="text-sm whitespace-pre-line">{shop.address}</div>}
          <div className="text-sm">{[shop.phone, shop.email].filter(Boolean).join(" · ")}</div>
        </header>
        <h2 className="mt-6 text-lg font-semibold">Text messages from {shop.name}</h2>
        <p className="mt-3 text-base leading-relaxed">{wording}</p>
        <div className="mt-10 space-y-8 text-sm">
          <div>
            <div className="border-b border-black pb-1">&nbsp;</div>
            <div className="mt-1">Name</div>
          </div>
          <div>
            <div className="border-b border-black pb-1">&nbsp;</div>
            <div className="mt-1">Mobile number</div>
          </div>
          <div className="grid gap-8 sm:grid-cols-2">
            <div>
              <div className="border-b border-black pb-1">&nbsp;</div>
              <div className="mt-1">Signature</div>
            </div>
            <div>
              <div className="border-b border-black pb-1">&nbsp;</div>
              <div className="mt-1">Date</div>
            </div>
          </div>
        </div>
        <footer className="mt-10 flex items-end justify-between gap-4 border-t border-line pt-3 text-xs">
          <span className="no-print muted">Keep the signed form. Record it on the customer&apos;s page with this code.</span>
          <span className="mono ml-auto">Form {code}</span>
        </footer>
      </article>
    </div>
  );
}
