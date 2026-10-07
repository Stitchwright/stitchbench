// One quilt appraisal (shop-features-round-2-design.md 9.8): the photos, the one next step (issue the certificate and
// take the fee), the draft's details, and the certificate to print once issued.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { TENDER_LABEL, TENDER_METHODS } from "@/lib/register-math";
import { appraisalView } from "@/lib/appraisals";
import { PURPOSES, type Purpose } from "@/lib/appraisals-words";
import { issueAppraisal, removeAppraisalPhoto, saveAppraisal } from "@/actions/appraisals";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { AppraisalFields } from "@/components/appraisal-fields";
import { PageHeader, Section } from "@/components/ui";

export default async function AppraisalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const [a, tz] = await Promise.all([appraisalView(user.shopId, id), shopTimeZone(user.shopId)]);
  if (!a) notFound();
  const q = a.quilt;
  const n = (v: number | null) => (v == null ? "" : String(v));
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Appraisal #${a.number}: ${q.title}`}
        back={{ href: "/appraisals", label: "Quilt appraisals" }}
        sub={
          <>
            <span className={`pill ${a.issuedAt ? "tone-done" : "tone-wait"}`}>{a.issuedAt ? `Issued ${fmtDate(a.issuedAt, tz)}` : "Draft"}</span> for{" "}
            {a.customerId ? (
              <Link href={`/customers/${a.customerId}`} className="link">
                {a.name}
              </Link>
            ) : (
              a.name
            )}{" "}
            · {money(a.valueCents)} {PURPOSES[a.purpose as Purpose]?.toLowerCase() ?? ""}
            {a.sale && (
              <>
                {" "}
                · fee on{" "}
                <Link href={`/register/sales/${a.sale.id}`} className="link">
                  sale #{a.sale.number}
                </Link>
              </>
            )}
          </>
        }
        actions={
          a.issuedAt ? (
            <Link href={`/appraisals/${a.id}/certificate`} className="btn btn-primary" target="_blank">
              Print the certificate
            </Link>
          ) : undefined
        }
      />
      {!a.issuedAt && (
        <div className="card card-pad space-y-2">
          <h2 className="text-base font-semibold">Done? Issue the certificate{a.feeCents > 0 ? ` and take the ${money(a.feeCents)} fee` : ""}</h2>
          <ActionForm action={issueAppraisal.bind(null, a.id)} className="flex flex-wrap items-end gap-2">
            {a.feeCents > 0 && (
              <div className="field">
                <label className="label" htmlFor="ap-method">
                  Paid by
                </label>
                <select id="ap-method" name="method" className="select" defaultValue="CARD">
                  {TENDER_METHODS.filter((m) => m !== "GIFT" && m !== "CREDIT").map((m) => (
                    <option key={m} value={m}>
                      {TENDER_LABEL[m]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Submit>Issue the certificate</Submit>
          </ActionForm>
          <p className="muted text-sm">Once issued it can&apos;t be changed (voiding the fee&apos;s sale makes it a draft again).</p>
        </div>
      )}
      <Section title={`Photos (${a.photos.length})`}>
        {a.photos.length ? (
          <ul className="flex flex-wrap gap-3">
            {a.photos.map((p) => (
              <li key={p.id} className="space-y-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- the company's own upload, served by its route */}
                <img src={`/api/appraisal-photos/${p.id}`} alt={q.title} className="h-40 w-auto rounded border border-line" />
                {!a.issuedAt && (
                  <ActionButton action={removeAppraisalPhoto.bind(null, a.id, p.id)} className="link text-xs" confirm="Tap again to remove">
                    Remove
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm">No photos yet: the first one prints on the certificate.</p>
        )}
      </Section>
      {a.issuedAt ? (
        <Section title="The quilt">
          <dl className="grid gap-2 text-base sm:grid-cols-2">
            <div>Size: {q.widthIn && q.lengthIn ? `${q.widthIn}" x ${q.lengthIn}"` : "-"}</div>
            <div>Made by: {q.maker || "-"}</div>
            <div>Made: {q.made || "-"}</div>
            <div>Techniques: {q.techniques || "-"}</div>
            <div className="sm:col-span-2">Condition: {q.condition || "-"}</div>
          </dl>
        </Section>
      ) : (
        <Section title="Details">
          <ActionForm action={saveAppraisal.bind(null, a.id)} className="grid gap-3 sm:grid-cols-2">
            <AppraisalFields
              p="ed-"
              lockFee={user.role === "TECH"}
              d={{ title: q.title, widthIn: n(q.widthIn), lengthIn: n(q.lengthIn), maker: q.maker, made: q.made, techniques: q.techniques, materials: q.materials, condition: q.condition, description: q.description, value: (a.valueCents / 100).toFixed(2), purpose: a.purpose, appraiser: a.appraiser ?? "", credential: a.credential ?? "", fee: (a.feeCents / 100).toFixed(2) }}
            />
            <div className="sm:col-span-2">
              <Submit className="btn">Save</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}
