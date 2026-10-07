// Maker Shop → Supplies due (shop-features-round-2-design.md 6.3): printer and cutter owners probably running low on
// filament, resin, mats, blades or laser stock, to call, snooze, stop, or (with Marketing) remind in one go. Never sent
// on its own. A lapsed module: read-only.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { suppliesDue } from "@/lib/supplies-due";
import { fmtYmdLong } from "@/lib/units/units";
import { markSuppliesCalled, sendSuppliesReminders, snoozeSupplies, stopSupplies } from "@/actions/maker-supplies";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty } from "@/components/ui";
import { MakerFrame, makerPageState } from "@/components/maker/maker-page";

export default async function SuppliesDuePage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const [rows, s, tz, marketing] = await Promise.all([suppliesDue(shopId), makerPageState(user), shopTimeZone(shopId), gateFor(shopId, "marketing")]);
  const write = s.gate === "write";
  const dueNow = rows.filter((r) => r.overdue).length;
  return (
    <MakerFrame
      title="Supplies due"
      tab="supplies"
      what="The supplies-due list"
      sub={`Customers who bought a printer or cutter here and are probably running low: by their own pace when they have one, else six weeks after their last supplies. A week ahead.${marketing === "on" ? "" : " This is your call list; with the Marketing module the reminders can go by email or text."}`}
      actions={
        marketing === "on" && write && s.admin && dueNow > 0 ? (
          <ActionButton action={sendSuppliesReminders} className="btn btn-primary" confirm={`Send a reminder to the ${dueNow} due now (consent and addresses permitting)?`}>
            Remind the {dueNow} due now
          </ActionButton>
        ) : undefined
      }
      {...s}
    >
      {rows.length === 0 ? (
        <Empty>Nobody is running low in the next week. A customer shows up here a few weeks after buying a printer or cutter, or their filament, mats or blades.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.machineId} className="card card-pad space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-base">
                  <Link href={`/customers/${r.customerId}`} className="link font-semibold">
                    {r.customer.name}
                  </Link>{" "}
                  {r.customer.phone && <span className="whitespace-nowrap">{r.customer.phone}</span>}
                </span>
                <span>
                  <span className={`pill ${r.overdue ? "tone-bad" : "tone-wait"}`}>{r.overdue ? "Probably out now" : "Running low soon"}</span> {fmtYmdLong(r.dueOn)}
                </span>
              </div>
              <div className="text-sm">
                {r.word} for the{" "}
                <Link href={`/machines/${r.machineId}`} className="link">
                  {r.brand} {r.model}
                </Link>{" "}
                · {r.lastBoughtAt ? `last bought ${fmtDate(r.lastBoughtAt, tz)}` : "none bought here yet"} · worked out from {r.from}
                {r.offer ? ` · on the shelf: ${r.offer}` : ""}
                {r.care?.calledAt && (
                  <span className="muted">
                    {" "}
                    · last contact {fmtDate(r.care.calledAt, tz)} ({r.care.calledBy ?? "?"})
                  </span>
                )}
              </div>
              {write && (
                <div className="flex flex-wrap items-end gap-2">
                  <ActionForm action={markSuppliesCalled.bind(null, r.machineId)} success="Marked called" className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col text-sm">
                      <span className="muted">Note (optional)</span>
                      <input name="note" className="input w-48" />
                    </label>
                    <Submit className="btn">Called</Submit>
                  </ActionForm>
                  <ActionButton action={snoozeSupplies.bind(null, r.machineId)} className="btn" success="Snoozed 30 days">
                    Not yet: 30 days
                  </ActionButton>
                  <ActionButton action={stopSupplies.bind(null, r.machineId, true)} className="btn" confirm="Tap again: no more reminders for this machine">
                    Stop reminders
                  </ActionButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </MakerFrame>
  );
}
