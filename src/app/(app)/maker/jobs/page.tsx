// Maker Shop → Print and cut jobs (shop-features-round-2-design.md 6.5): the open jobs (soonest due first), "Take a job",
// the latest finished ones, and for an owner or admin the job prices (rate, set-up fee, the laser's never-cut list).
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { jobsFor, makeSettings, materialsFor, type JobRow } from "@/lib/make-jobs";
import { MAKE_KIND_LABEL, STATUS_TONE, neverCutHit, statusLabel, type MakeKind } from "@/lib/make-jobs-math";
import { saveMakeSettings } from "@/actions/make-jobs";
import { ActionForm, Submit } from "@/components/action-form";
import { Empty, Section } from "@/components/ui";
import { JobForm } from "@/components/maker/job-form";
import { MakerFrame, makerPageState } from "@/components/maker/maker-page";

function Rows({ rows, tz }: { rows: JobRow[]; tz: string }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((j) => (
        <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="text-base">
            <Link href={`/maker/jobs/${j.id}`} className="link">
              #{j.number} {j.title}
            </Link>{" "}
            <span className="muted text-sm">
              · {j.name} · {MAKE_KIND_LABEL[j.kind as MakeKind] ?? j.kind}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-2 text-base">
            <span className="num">{money(j.quoteCents)}</span>
            {j.dueAt && <span className={j.overdue ? "pill tone-bad" : "muted text-sm"}>{j.overdue ? "late: " : "by "}{fmtDate(j.dueAt, tz)}</span>}
            <span className={`pill ${STATUS_TONE[j.status] ?? ""}`}>{statusLabel(j.status, j.kind)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function MakeJobsPage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const [s, open, done, settings, materials, tz] = await Promise.all([makerPageState(user), jobsFor(shopId), jobsFor(shopId, { closed: true, take: 30 }), makeSettings(shopId), materialsFor(shopId), shopTimeZone(shopId)]);
  const write = s.gate === "write";
  const dollars = (c: number) => (c / 100).toFixed(2);
  return (
    <MakerFrame title="Print and cut jobs" tab="jobs" what="Print and cut jobs" sub="A customer's file printed or cut on your machines: quote, approve, make, ready, collected and paid at the register. You decide what you'll print or cut." {...s}>
      <Section title={`Open (${open.length})`}>{open.length ? <Rows rows={open} tz={tz} /> : <Empty>No open jobs. When a customer brings or emails a file, take the job below.</Empty>}</Section>
      {write && (
        <Section title="Take a job">
          <JobForm
            id={null}
            materials={materials.map((m) => ({ id: m.id, label: `${m.description} (${m.qtyOnHand} on hand)`, itemType: m.itemType, unit: m.measure.unit, unitCents: m.measure.unitCents, neverCut: !!neverCutHit(settings.makeNeverCut, m) }))}
            lockPrices={user.role === "TECH"}
            init={{ title: "", kind: "PRINT", hours: "1", minutes: "0", materialPartId: "", materialName: "", materialQty: "", rate: dollars(settings.makeRateCents), setup: dollars(settings.makeSetupCents), due: "", note: "", taxable: true }}
          />
        </Section>
      )}
      {done.length > 0 && (
        <Section title="Finished lately">
          <Rows rows={done} tz={tz} />
        </Section>
      )}
      {s.admin && write && (
        <Section title="Job prices">
          <ActionForm action={saveMakeSettings} success="Saved" className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label className="label" htmlFor="mk-rate">
                Machine rate ($ an hour)
              </label>
              <input id="mk-rate" name="rate" inputMode="decimal" className="input num w-28" defaultValue={dollars(settings.makeRateCents)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="mk-setup">
                Set-up fee ($)
              </label>
              <input id="mk-setup" name="setup" inputMode="decimal" className="input num w-28" defaultValue={dollars(settings.makeSetupCents)} />
            </div>
            <div className="field min-w-64 flex-1">
              <label className="label" htmlFor="mk-never">
                The laser never cuts
              </label>
              <input id="mk-never" name="neverCut" className="input" defaultValue={settings.makeNeverCut} />
              <p className="muted text-sm">PVC and vinyl give off chlorine gas when laser cut. Separate with commas.</p>
            </div>
            <Submit className="btn">Save</Submit>
          </ActionForm>
        </Section>
      )}
    </MakerFrame>
  );
}
