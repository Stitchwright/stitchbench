// One class (scheduling-messaging-design.md 12.1): sign someone up, the roster, the waiting list, the meetings, about.
// Everyone sees it and signs people up; admins shape it.
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { fmtDate, money } from "@/lib/format";
import { fmtPhone } from "@/lib/phone";
import { shopTimeZone } from "@/lib/shop-zone";
import { classCreditsFor } from "@/lib/units/units";
import { fmtRange, fmtWhen, hmOf, wall, ymdOf } from "@/lib/zoned";
import { CLASS_REMIND_LABEL, CLASS_STATUS_LABEL, CLASS_STATUS_TONE } from "@/lib/constants";
import { addMeetings, applyClassCredit, cancelEnrollment, cancelMeeting, deleteClass, deleteMeeting, enroll, messageClass, moveUp, saveClass, saveMeeting, setClassStatus, setEnrollmentFee } from "@/actions/classes";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { ClassForm, MeetingFields } from "@/components/class-form";
import { entryFor } from "@/lib/assistant/ui";
import { PostDraft } from "@/components/assistant/marketing-drafts";
import { CustomerPicker } from "@/components/customer-picker";
import { ModuleOff } from "@/components/module-off";
import { KV, PageHeader, Section } from "@/components/ui";

function Tell({ on, label = "Tell them" }: { on: boolean; label?: string }) {
  if (!on) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name="tell" className="check" defaultChecked /> {label}
    </label>
  );
}

export default async function ClassPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />;
  const c = await db.shopClass.findFirst({ where: { id, shopId }, include: { meetings: { orderBy: { startsAt: "asc" } } } });
  if (!c) notFound();
  const on = gate === "on";
  const admin = user.role !== "TECH" && on;
  // Marketing drafts (shop-features-round-2-design.md 5.2): "Draft it" for About the class, and a social post.
  const mk = admin ? await entryFor(shopId, "marketing") : ({ show: false } as const);
  const now = new Date();
  const [tz, marketing, rows] = await Promise.all([
    shopTimeZone(shopId),
    gateFor(shopId, "marketing").then((g) => g === "on"),
    db.enrollment.findMany({ where: { shopId, classId: c.id }, orderBy: { createdAt: "asc" }, include: { customer: { select: { id: true, name: true, phone: true } } } }),
  ]);
  const enrolled = rows.filter((r) => r.status === "ENROLLED");
  const waiting = rows.filter((r) => r.status === "WAITLIST");
  const cancelled = rows.filter((r) => r.status === "CANCELLED");
  const seatsLeft = c.seats - enrolled.length;
  const over = !!c.lastAt && c.lastAt.getTime() < now.getTime();
  const canSignUp = on && c.status === "OPEN" && !over;
  const paidLines = rows.filter((r) => r.paidLineId).map((r) => r.paidLineId!);
  const sales = paidLines.length ? await db.saleLine.findMany({ where: { id: { in: paidLines } }, select: { id: true, sale: { select: { id: true, number: true } } } }) : [];
  const saleOf = new Map(sales.map((s) => [s.id, s.sale]));
  const first = c.meetings.find((m) => !m.cancelled);
  const meetingDefaults = first ? { start: hmOf(wall(first.startsAt, tz).hour * 60 + wall(first.startsAt, tz).minute), end: hmOf(wall(first.endsAt, tz).hour * 60 + wall(first.endsAt, tz).minute) } : undefined;

  // Owner's classes that came with machines the people signed up bought here (machines for sale), by customer.
  const people = [...new Set(rows.filter((r) => r.customerId && r.status !== "CANCELLED").map((r) => r.customerId!))];
  const credits = new Map(await Promise.all(people.map(async (id) => [id, (await classCreditsFor(shopId, id)).filter((x) => x.left > 0)] as const)));
  const payment = (r: (typeof rows)[number]) => {
    if (r.creditUnitId && !r.paidAt) {
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          Owner&apos;s class (came with their machine)
          {on && (
            <ActionButton action={applyClassCredit.bind(null, r.id, null)} className="link text-xs">
              Charge for it instead
            </ActionButton>
          )}
        </span>
      );
    }
    const free = r.customerId && !r.paidAt && r.feeCents > 0 && on ? (credits.get(r.customerId) ?? []) : [];
    if (free.length && !r.refundedAt) {
      return (
        <span className="inline-flex flex-wrap items-center gap-2">
          Owes {money(r.feeCents)}
          {free.map((x) => (
            <ActionButton key={x.unitId} action={applyClassCredit.bind(null, r.id, x.unitId)} className="btn btn-sm btn-primary">
              Use an owner&apos;s class ({x.left} left with the {x.machine})
            </ActionButton>
          ))}
        </span>
      );
    }
    if (r.refundedAt) return <span className="muted">Refunded {money(r.refundedCents ?? 0)}</span>;
    if (r.paidAt) {
      const s = r.paidLineId ? saleOf.get(r.paidLineId) : null;
      return s ? (
        <Link href={`/register/sales/${s.id}`} className="link">
          Paid, sale #{s.number}
        </Link>
      ) : (
        <span>Paid {money(r.paidCents ?? r.feeCents)}</span>
      );
    }
    if (!r.feeCents) return <span className="muted">Free</span>;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        Owes {money(r.feeCents)}
        {on && r.status === "ENROLLED" && (
          <Link href={`/register?booking=enrollment:${r.id}`} className="btn btn-sm">
            Ring up
          </Link>
        )}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={c.title}
        back={{ href: "/classes", label: "Classes" }}
        sub={
          <>
            <span className={`pill tone-${CLASS_STATUS_TONE[c.status] ?? "neutral"}`}>{CLASS_STATUS_LABEL[c.status] ?? c.status}</span> · {c.feeCents ? money(c.feeCents) : "Free"} · {enrolled.length} of {c.seats} seats
            {waiting.length ? ` (${waiting.length} waiting)` : ""}
            {c.firstAt ? ` · starts ${fmtWhen(c.firstAt, tz)}` : ""}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/classes/${c.id}/roster`} className="btn btn-sm">
              Print roster
            </Link>
            {admin && c.status === "OPEN" && (
              <ActionForm action={setClassStatus.bind(null, c.id, "CLOSED")} success="Sign-ups closed" className="inline-flex">
                <Submit className="btn btn-sm">Close sign-ups</Submit>
              </ActionForm>
            )}
            {admin && c.status === "CLOSED" && (
              <ActionForm action={setClassStatus.bind(null, c.id, "OPEN")} success="Sign-ups open" className="inline-flex">
                <Submit className="btn btn-sm">Reopen sign-ups</Submit>
              </ActionForm>
            )}
          </div>
        }
      />
      {gate === "readonly" && <ModuleOff shopId={shopId} module="scheduling" admin={user.role !== "TECH"} />}

      {canSignUp && (
        <Section title="Sign someone up">
          <ActionForm action={enroll.bind(null, c.id)} success={seatsLeft > 0 && !waiting.length ? "Signed up" : "Added to the waiting list"} reset className="space-y-3">
            <CustomerPicker initial={null} newBox />
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="field">
                <label htmlFor="customerName" className="label">
                  Or a new customer&apos;s name
                </label>
                <input id="customerName" name="customerName" className="input" autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="customerPhone" className="label">
                  Phone
                </label>
                <input id="customerPhone" name="customerPhone" type="tel" className="input" />
              </div>
              <div className="field">
                <label htmlFor="customerEmail" className="label">
                  Email address
                </label>
                <input id="customerEmail" name="customerEmail" type="email" className="input" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="attendee" className="label">
                Who&apos;s coming (if not them)
              </label>
              <input id="attendee" name="attendee" className="input" maxLength={80} placeholder="A child, a friend" />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span>{c.feeCents ? `Fee ${money(c.feeCents)}, paid at the counter.` : "No fee."}</span>
              {seatsLeft <= 0 && c.waitlist && <span className="pill tone-wait">Full: they go on the waiting list</span>}
              {seatsLeft <= 0 && !c.waitlist && <span className="pill tone-bad">Full</span>}
              {admin && waiting.length > 0 && seatsLeft > 0 && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="skipWaitlist" className="check" /> Skip the waiting list
                </label>
              )}
              <Tell on={marketing} label="Tell them (sign-up confirmation)" />
            </div>
            <Submit>Sign up</Submit>
          </ActionForm>
        </Section>
      )}

      <Section title={`Roster (${enrolled.length})`}>
        {enrolled.length === 0 ? (
          <p className="muted text-sm">Nobody yet.</p>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Signed up</th>
                  <th>Payment</th>
                  {admin && <th>Price</th>}
                  {on && <th></th>}
                </tr>
              </thead>
              <tbody>
                {enrolled.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.customer ? (
                        <Link href={`/customers/${r.customer.id}`} className="link">
                          {r.customer.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                      {r.attendee && <div className="muted text-xs">for {r.attendee}</div>}
                      {r.source === "online" && <span className="pill tone-neutral">online</span>}
                    </td>
                    <td className="num">{r.customer?.phone ? fmtPhone(r.customer.phone) : ""}</td>
                    <td className="num whitespace-nowrap">{fmtDate(r.createdAt, tz)}</td>
                    <td>{payment(r)}</td>
                    {admin && (
                      <td>
                        {!r.paidAt && (
                          <ActionForm action={setEnrollmentFee.bind(null, r.id)} success="Price saved" className="inline-flex items-center gap-1">
                            <input name="fee" className="input num w-24" inputMode="decimal" defaultValue={(r.feeCents / 100).toFixed(2)} aria-label={`Price for ${r.attendee ?? r.name}`} />
                            <Submit className="btn btn-sm">Price for this person</Submit>
                          </ActionForm>
                        )}
                      </td>
                    )}
                    {on && (
                      <td className="text-right">
                        <ActionForm action={cancelEnrollment.bind(null, r.id)} success="Cancelled" className="inline-flex">
                          <Submit className="btn btn-sm">Cancel</Submit>
                        </ActionForm>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {(waiting.length > 0 || c.waitlist) && (
        <Section title={`Waiting list (${waiting.length})`}>
          {waiting.length === 0 ? (
            <p className="muted text-sm">Nobody waiting.</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {waiting.map((r, i) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3">
                  <span className="num">{i + 1}.</span>
                  <span>
                    {r.customer ? (
                      <Link href={`/customers/${r.customer.id}`} className="link">
                        {r.customer.name}
                      </Link>
                    ) : (
                      r.name
                    )}
                    {r.attendee ? ` for ${r.attendee}` : ""}
                  </span>
                  <span className="muted">{fmtDate(r.createdAt, tz)}</span>
                  {on && (
                    <>
                      <ActionForm action={moveUp.bind(null, r.id)} success="Moved up" className="inline-flex items-center gap-2">
                        <Tell on={marketing} />
                        <Submit className="btn btn-sm btn-primary">Move up</Submit>
                      </ActionForm>
                      <ActionForm action={cancelEnrollment.bind(null, r.id)} success="Removed" className="inline-flex">
                        <Submit className="btn btn-sm">Remove</Submit>
                      </ActionForm>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}

      <Section title={`Meetings (${c.meetings.filter((m) => !m.cancelled).length})`}>
        {c.meetings.length === 0 ? (
          <p className="muted text-sm">No meetings yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {c.meetings.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3">
                <span className={m.cancelled ? "line-through muted" : ""}>{fmtRange(m.startsAt, m.endsAt, tz)}</span>
                {m.cancelled && <span className="pill tone-bad">Cancelled</span>}
                {m.note && <span className="muted">{m.note}</span>}
                {admin && !m.cancelled && (
                  <details className="inline-block">
                    <summary className="link cursor-pointer">Change</summary>
                    <div className="mt-2 space-y-3 rounded border border-line p-3">
                      <ActionForm action={saveMeeting.bind(null, m.id)} success="Saved" className="space-y-2">
                        <div className="grid gap-2 sm:grid-cols-3">
                          <input name="date" type="date" className="input" defaultValue={ymdOf(m.startsAt, tz)} aria-label="Date" />
                          <input name="start" type="time" className="input" defaultValue={hmOf(wall(m.startsAt, tz).hour * 60 + wall(m.startsAt, tz).minute)} aria-label="Starts" />
                          <input name="end" type="time" className="input" defaultValue={hmOf(wall(m.endsAt, tz).hour * 60 + wall(m.endsAt, tz).minute)} aria-label="Ends" />
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Tell on={marketing} label="Tell everyone signed up" />
                          <Submit className="btn btn-sm">Save the new time</Submit>
                        </div>
                      </ActionForm>
                      <ActionForm action={cancelMeeting.bind(null, m.id)} success="Meeting cancelled" className="flex flex-wrap items-center gap-2">
                        <input name="note" className="input" placeholder="Why (goes in the message)" maxLength={500} aria-label="Why" />
                        <Tell on={marketing} label="Tell everyone signed up" />
                        <Submit className="btn btn-sm">Cancel this meeting</Submit>
                      </ActionForm>
                      {rows.filter((r) => r.status !== "CANCELLED").length === 0 && (
                        <ActionButton action={deleteMeeting.bind(null, m.id)} confirm="Tap again to delete" className="btn btn-sm">
                          Delete this meeting
                        </ActionButton>
                      )}
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && c.status !== "CANCELLED" && (
          <details className="mt-3">
            <summary className="link cursor-pointer text-sm">Add meetings</summary>
            <ActionForm action={addMeetings.bind(null, c.id)} success="Meetings added" className="mt-2 space-y-3">
              <MeetingFields prefix="" defaults={meetingDefaults} />
              <Submit className="btn btn-sm">Add</Submit>
            </ActionForm>
          </details>
        )}
      </Section>

      <Section title="About">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <KV k="Teacher" v={c.teacher} />
          <KV k="Where" v={c.location} />
          <KV k="Reminders" v={CLASS_REMIND_LABEL[c.remind] ?? c.remind} />
          <KV k="Waiting list" v={c.waitlist ? "Yes" : "No"} />
          <KV k="About" v={c.description ? <span className="whitespace-pre-wrap">{c.description}</span> : null} />
          <KV k="What to bring" v={c.supplies ? <span className="whitespace-pre-wrap">{c.supplies}</span> : null} />
        </div>
        {cancelled.length > 0 && (
          <p className="muted mt-3 text-xs">
            Cancelled sign-ups: {cancelled.map((r) => `${r.name}${r.attendee ? ` for ${r.attendee}` : ""}${r.paidAt && !r.refundedAt ? ` (paid ${money(r.paidCents ?? r.feeCents)}: refund it at the register)` : ""}`).join("; ")}
          </p>
        )}
      </Section>

      {admin && (
        <>
          <Section title="Edit the class">
            <ClassForm action={saveClass.bind(null, c.id)} draft={c} isNew={false} drafting={mk.show ? { classId: c.id, unavailable: mk.unavailable } : null} />
            {mk.show && !mk.unavailable && c.status !== "CANCELLED" && (
              <div className="mt-4">
                <PostDraft about="class" id={c.id} />
              </div>
            )}
          </Section>
          {marketing && c.status !== "CANCELLED" && (
            <Section title="Message everyone">
              <ActionForm action={messageClass.bind(null, c.id)} success="Queued: it goes out in a moment" reset className="space-y-3">
                <div className="field">
                  <label htmlFor="mc-subject" className="label">
                    Subject (email)
                  </label>
                  <input id="mc-subject" name="subject" className="input" maxLength={150} defaultValue={`${c.title}: a note from us`} />
                </div>
                <div className="field">
                  <label htmlFor="mc-body" className="label">
                    Message
                  </label>
                  <textarea id="mc-body" name="body" rows={4} maxLength={2000} className="input" required />
                </div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="waitlist" className="check" /> Include the waiting list
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="onlyAboutClass" className="check" /> This is only about this class (promotions go in Campaigns)
                  </label>
                </div>
                <Submit className="btn btn-sm">Send to everyone signed up</Submit>
              </ActionForm>
            </Section>
          )}
          <Section title="Cancel or delete">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {c.status !== "CANCELLED" && (
                <ActionForm action={setClassStatus.bind(null, c.id, "CANCELLED")} success="Class cancelled" className="inline-flex items-center gap-3">
                  <Tell on={marketing} label="Tell everyone signed up" />
                  <Submit className="btn btn-sm">Cancel the class</Submit>
                </ActionForm>
              )}
              {rows.length === 0 && (
                <ActionButton action={deleteClass.bind(null, c.id)} confirm="Tap again to delete" className="btn btn-sm">
                  Delete the class
                </ActionButton>
              )}
              {c.status === "CANCELLED" && rows.some((r) => r.paidAt && !r.refundedAt) && <span className="muted">Paid sign-ups: refund them at the register.</span>}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
