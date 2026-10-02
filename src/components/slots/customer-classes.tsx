// A customer's classes on their page (scheduling-messaging-design.md 12.1): their sign-ups with the next meeting, the
// status and the payment, and "Sign up for a class" posting enroll with the customer already picked.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { ENROLLMENT_STATUS_LABEL } from "@/lib/constants";
import { nextMeetings, seatCounts } from "@/lib/classes";
import { enroll } from "@/actions/classes";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

const TONE: Record<string, string> = { ENROLLED: "ready", WAITLIST: "wait", CANCELLED: "neutral" };

export async function CustomerClassesSlot({ customerId, user }: { customerId: string; user: CurrentUser }) {
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return null;
  const now = new Date();
  const [rows, open, tz, marketing] = await Promise.all([
    db.enrollment.findMany({ where: { shopId, customerId }, orderBy: { createdAt: "desc" }, take: 20, include: { shopClass: { select: { id: true, title: true, lastAt: true } } } }),
    db.shopClass.findMany({ where: { shopId, status: "OPEN", OR: [{ lastAt: null }, { lastAt: { gte: now } }] }, select: { id: true, title: true, firstAt: true, seats: true, feeCents: true }, orderBy: { firstAt: "asc" }, take: 30 }),
    shopTimeZone(shopId),
    gateFor(shopId, "marketing").then((g) => g === "on"),
  ]);
  if (!rows.length && !open.length) return null;
  const [next, counts] = await Promise.all([nextMeetings(db, rows.map((r) => r.classId), now), seatCounts(db, open.map((c) => c.id))]);
  const on = gate === "on";
  return (
    <Section title="Classes">
      <div className="space-y-3 text-sm">
        {rows.length > 0 && (
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const n = next.get(r.classId);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Link href={`/classes/${r.classId}`} className="link">
                    {r.shopClass.title}
                  </Link>
                  {r.attendee && <span className="muted">for {r.attendee}</span>}
                  <span className={`pill tone-${TONE[r.status] ?? "neutral"}`}>{ENROLLMENT_STATUS_LABEL[r.status] ?? r.status}</span>
                  {n && r.status !== "CANCELLED" && <span className="muted">next {fmtWhen(n.startsAt, tz)}</span>}
                  {r.refundedAt ? (
                    <span className="muted">Refunded</span>
                  ) : r.paidAt ? (
                    <span className="muted">Paid</span>
                  ) : r.feeCents && r.status === "ENROLLED" ? (
                    <>
                      <span>Owes {money(r.feeCents)}</span>
                      {on && (
                        <Link href={`/register?booking=enrollment:${r.id}`} className="btn btn-sm">
                          Ring up
                        </Link>
                      )}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {on && open.length > 0 && (
          <SignUp customerId={customerId} open={open.map((c) => ({ ...c, seatsLeft: c.seats - (counts.get(c.id)?.enrolled ?? 0) }))} tz={tz} marketing={marketing} />
        )}
      </div>
    </Section>
  );
}

function SignUp({ customerId, open, tz, marketing }: { customerId: string; open: { id: string; title: string; firstAt: Date | null; seatsLeft: number; feeCents: number }[]; tz: string; marketing: boolean }) {
  return (
    <details>
      <summary className="link cursor-pointer">Sign up for a class</summary>
      <div className="mt-2 space-y-2">
        {open.map((c) => (
          <ActionForm key={c.id} action={enroll.bind(null, c.id)} success="Signed up" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="customerId" value={customerId} />
            <span>
              {c.title}
              {c.firstAt ? `, ${fmtWhen(c.firstAt, tz)}` : ""} · {c.seatsLeft > 0 ? `${c.seatsLeft} seat${c.seatsLeft === 1 ? "" : "s"} left` : "full (waiting list)"}
              {c.feeCents ? ` · ${money(c.feeCents)}` : ""}
            </span>
            {marketing && (
              <label className="flex items-center gap-1">
                <input type="checkbox" name="tell" className="check" defaultChecked /> Tell them
              </label>
            )}
            <Submit className="btn btn-sm">Sign up</Submit>
          </ActionForm>
        ))}
      </div>
    </details>
  );
}
