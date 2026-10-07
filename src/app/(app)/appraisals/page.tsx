// Quilt appraisals (shop-features-round-2-design.md 9.8): the appraisals, "New appraisal", and for an owner or admin the
// usual fee and the appraiser printed on the certificates.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { appraisalSettings, appraisalsFor } from "@/lib/appraisals";
import { saveAppraisalSettings, startAppraisal } from "@/actions/appraisals";
import { ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { AppraisalFields } from "@/components/appraisal-fields";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function AppraisalsPage() {
  const user = await requireUser();
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true } });
  if (!shop.sellsRetail) notFound();
  const [rows, s, tz] = await Promise.all([appraisalsFor(user.shopId), appraisalSettings(user.shopId), shopTimeZone(user.shopId)]);
  const admin = user.role !== "TECH";
  const dollars = (c: number) => (c / 100).toFixed(2);
  return (
    <div className="space-y-4">
      <PageHeader title="Quilt appraisals" sub="A written value for a customer's quilt, with photos, on a numbered certificate. The fee is rung up when the certificate is issued." back={{ href: "/longarm", label: "Longarm" }} />
      <Section title="Appraisals">
        {rows.length ? (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-base">
                <span>
                  <Link href={`/appraisals/${r.id}`} className="link">
                    #{r.number} {r.title}
                  </Link>{" "}
                  <span className="muted text-sm">· {r.name}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="num">{money(r.valueCents)}</span>
                  <span className={`pill ${r.issuedAt ? "tone-done" : "tone-wait"}`}>{r.issuedAt ? `Issued ${fmtDate(r.issuedAt, tz)}` : "Draft"}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No appraisals yet. When a customer brings a quilt to be valued, start one below.</Empty>
        )}
      </Section>
      <Section title="New appraisal">
        <ActionForm action={startAppraisal} className="grid gap-3 sm:grid-cols-2">
          <CustomerPicker initial={null} />
          <div className="field">
            <label className="label" htmlFor="ap-cname">
              Or a new customer: name
            </label>
            <input id="ap-cname" name="customerName" className="input" />
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-cphone">
              Phone
            </label>
            <input id="ap-cphone" name="customerPhone" type="tel" className="input" />
          </div>
          <AppraisalFields
            p="ap-"
            lockFee={!admin}
            d={{ title: "", widthIn: "", lengthIn: "", maker: "", made: "", techniques: "", materials: "", condition: "", description: "", value: "", purpose: "insurance", appraiser: s.appraiserName ?? "", credential: s.appraiserCredential ?? "", fee: dollars(s.appraisalFeeCents) }}
          />
          <div className="sm:col-span-2">
            <Submit>Start the appraisal</Submit>
          </div>
        </ActionForm>
      </Section>
      {admin && (
        <Section title="Your appraiser and fee">
          <ActionForm action={saveAppraisalSettings} className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label className="label" htmlFor="as-name">
                Appraiser
              </label>
              <input id="as-name" name="appraiser" className="input" defaultValue={s.appraiserName ?? ""} />
            </div>
            <div className="field min-w-64 flex-1">
              <label className="label" htmlFor="as-cred">
                Her credential
              </label>
              <input id="as-cred" name="credential" className="input" defaultValue={s.appraiserCredential ?? ""} placeholder="AQS Certified Appraiser of Quilted Textiles" />
            </div>
            <div className="field">
              <label className="label" htmlFor="as-fee">
                Usual fee ($)
              </label>
              <input id="as-fee" name="fee" inputMode="decimal" className="input num w-28" defaultValue={dollars(s.appraisalFeeCents)} />
            </div>
            <Submit className="btn">Save</Submit>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}
