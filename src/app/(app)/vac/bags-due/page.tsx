// "Bags due" (modules-design.md 10.c′): the call list (customer, vacuum, bag type, last bags, due, the bag to offer)
// with Called / Snooze / Stop per row, the days-between-bags setting for admins, and with Marketing on the one-off
// "Send reminders to the n due now". Lapsed Vac Shop: read-only.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { BAG_DAYS_MAX, BAG_DAYS_MIN, bagsDue } from "@/lib/vac/bags-due";
import { fmtYmdLong } from "@/lib/units/units";
import { markCalled, saveBagDays, sendBagReminders, snoozeBags, stopBags } from "@/actions/vac-bags-due";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, Section } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";

export default async function BagsDuePage() {
  const user = await requireUser();
  const shopId = user.shopId;
  const [rows, s, tz, marketing, shop] = await Promise.all([bagsDue(shopId), vacPageState(user), shopTimeZone(shopId), gateFor(shopId, "marketing"), db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { bagReminderDays: true } })]);
  const write = s.gate === "write";
  const dueNow = rows.filter((r) => r.overdue).length;
  return (
    <VacFrame title="Bags due" tab="bags-due" what="The bags-due list" {...s}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="muted">
          Customers whose bagged vacuum is due for bags ({shop.bagReminderDays} days after the last ones), two weeks ahead.
          {marketing === "on" ? "" : " This is your call list. With the Marketing module, these can go out by email or text."}
        </span>
        {marketing === "on" && write && s.admin && dueNow > 0 && (
          <ActionButton action={sendBagReminders} className="btn btn-primary btn-sm" confirm={`Send a bags reminder to the ${dueNow} due now (consent and addresses permitting)?`}>
            Send reminders to the {dueNow} due now
          </ActionButton>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty>Nobody is due for bags in the next two weeks.</Empty>
      ) : (
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Vacuum</th>
                <th>Bag type</th>
                <th>Last bags</th>
                <th>Due</th>
                <th>Bag to offer</th>
                {write && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.machineId}>
                  <td>
                    <Link href={`/customers/${r.customerId}`} className="link">
                      {r.customer.name}
                    </Link>
                    {r.care?.contactedAt && <div className="muted text-xs">last contact {fmtDate(r.care.contactedAt, tz)} ({r.care.contactedBy ?? "?"})</div>}
                  </td>
                  <td className="whitespace-nowrap">{r.customer.phone ?? ""}</td>
                  <td>
                    <Link href={`/machines/${r.machineId}`} className="link">
                      {r.brand} {r.model}
                    </Link>
                  </td>
                  <td>{r.bagType ?? ""}</td>
                  <td className="whitespace-nowrap">{fmtDate(r.lastBagsAt, tz)}</td>
                  <td className="whitespace-nowrap">
                    {fmtYmdLong(r.dueOn)} <span className={`pill ${r.overdue ? "tone-bad" : "tone-wait"}`}>{r.overdue ? "overdue" : "due soon"}</span>
                  </td>
                  <td>{r.offer ?? <span className="muted">not stocked</span>}</td>
                  {write && (
                    <td>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <ActionForm action={markCalled.bind(null, r.machineId)} success="Marked called" className="flex items-center gap-1">
                          <label htmlFor={`note-${r.machineId}`} className="sr-only">
                            Note
                          </label>
                          <input id={`note-${r.machineId}`} name="note" className="input w-32" placeholder="note" />
                          <Submit className="btn btn-sm">Called</Submit>
                        </ActionForm>
                        <ActionButton action={snoozeBags.bind(null, r.machineId)} className="btn btn-sm" success="Snoozed 30 days">
                          Snooze 30 days
                        </ActionButton>
                        <ActionButton action={stopBags.bind(null, r.machineId)} className="btn btn-sm" confirm="Stop bag reminders for this vacuum?" success="Reminders stopped">
                          Stop reminders
                        </ActionButton>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.admin && write && (
        <Section title="Settings">
          <ActionForm action={saveBagDays} success="Saved" className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label htmlFor="bag-days" className="label">
                Days between bags
              </label>
              <input id="bag-days" name="bagReminderDays" type="number" min={BAG_DAYS_MIN} max={BAG_DAYS_MAX} defaultValue={shop.bagReminderDays} className="input w-28 num" />
            </div>
            <Submit className="btn">Save</Submit>
            <span className="muted text-sm">
              {BAG_DAYS_MIN} to {BAG_DAYS_MAX}. A typical household goes through a pack in about six months.
            </span>
          </ActionForm>
        </Section>
      )}
    </VacFrame>
  );
}
