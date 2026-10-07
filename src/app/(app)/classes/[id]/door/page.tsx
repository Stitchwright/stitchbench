// An event at the door (shop-features-round-2-design.md 4.5): the check-in list (one big button a person), "Sell a
// ticket" at the door price (signed up, checked in and paid in one go), and the door prize drawing: "Draw a name" from
// those checked in (or everyone signed up), the name big on the screen, and "She's not here: draw again".
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { eventView } from "@/lib/events";
import { checkIn, drawName, notPresent, sellDoorTicket } from "@/actions/events";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { ModuleOff } from "@/components/module-off";
import { Empty, PageHeader, Section } from "@/components/ui";

export default async function EventDoor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const gate = await gateFor(user.shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={user.shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const v = await eventView(user.shopId, id);
  if (!v) notFound();
  const on = gate === "on";
  const last = v.draws[v.draws.length - 1] ?? null;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={`${v.title}: at the door`} sub={`${v.totals.checkedIn} of ${v.people.length} here`} back={{ href: `/classes/${v.id}`, label: v.title }} />

      <Section title="Door prize drawing">
        {last && (
          <div className="mb-4 rounded border border-line p-4 text-center" role="status" aria-live="polite">
            <p className="muted text-base">{last.prize}</p>
            <p className="text-4xl font-semibold">{last.name}</p>
            {!last.present && <p className="muted text-base">Not present</p>}
            {on && last.present && (
              <ActionButton action={notPresent.bind(null, v.id, last.id)} className="btn mt-3 min-h-11 text-base">
                She&apos;s not here: draw again
              </ActionButton>
            )}
          </div>
        )}
        {on && (
          <ActionForm action={drawName.bind(null, v.id)} className="flex flex-wrap items-end gap-3">
            <div className="field">
              <label htmlFor="draw-prize" className="label">
                The prize
              </label>
              <input id="draw-prize" name="prize" className="input text-base" maxLength={120} placeholder="Door prize" defaultValue={last?.prize ?? ""} />
            </div>
            <Submit className="btn btn-primary min-h-11 px-6 text-lg">Draw a name</Submit>
          </ActionForm>
        )}
        {v.draws.length > 1 && (
          <ul className="muted mt-3 text-sm">
            {v.draws.map((d) => (
              <li key={d.id}>
                {d.prize}: {d.name}
                {d.present ? "" : " (not present)"}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Check in">
        {v.people.length === 0 ? (
          <Empty>Nobody is signed up yet. Sell a ticket below, or sign people up on the event&apos;s page.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {v.people.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-base">
                <span>
                  {p.attendee ?? p.name}
                  {p.owingCents > 0 && <span className="muted"> · owes {money(p.owingCents)}</span>}
                </span>
                {on &&
                  (p.checkedIn ? (
                    <ActionButton action={checkIn.bind(null, v.id, p.id, false)} className="btn min-h-11 text-base">
                      Here (tap to undo)
                    </ActionButton>
                  ) : (
                    <ActionButton action={checkIn.bind(null, v.id, p.id, true)} className="btn btn-primary min-h-11 text-base">
                      Check in
                    </ActionButton>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {on && v.doorCents != null && (
        <Section title={`Sell a ticket (${money(v.doorCents)})`}>
          <ActionForm action={sellDoorTicket.bind(null, v.id)} reset className="space-y-3">
            <CustomerPicker initial={null} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="field">
                <label htmlFor="door-name" className="label">
                  New customer name
                </label>
                <input id="door-name" name="customerName" className="input text-base" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="door-phone" className="label">
                  Phone
                </label>
                <input id="door-phone" name="customerPhone" type="tel" className="input text-base" />
              </div>
            </div>
            <div className="flex flex-wrap items-end justify-end gap-3">
              <label className="field text-sm">
                <span className="label">Paid by</span>
                <select name="method" className="select text-base" defaultValue="CASH">
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="CHECK">Check</option>
                  <option value="OTHER">Other</option>
                </select>
              </label>
              <Submit className="btn btn-primary min-h-11 text-base">Sell the ticket</Submit>
            </div>
          </ActionForm>
        </Section>
      )}
      {on && v.doorCents == null && (
        <p className="muted text-base">
          To sell tickets at the door, give the event a door price:{" "}
          <Link href={`/classes/${v.id}`} className="link">
            Edit the event
          </Link>
          , More choices.
        </p>
      )}
    </div>
  );
}
