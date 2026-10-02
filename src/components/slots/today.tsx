// Today at a glance (scheduling-messaging-design.md 12.2). On the register: one line above the cart that opens into the
// list ("Today: 2 appointments · Quilting 6 pm (8, 2 owe) · Working: Sue, Ann"). On the repair Dashboard: a small card.
// Nothing when the gate is hidden or the day is empty.
import Link from "next/link";
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { shopTimeZone } from "@/lib/shop-zone";
import { calendarItems } from "@/lib/calendar";
import { addDays, dayStart, fmtTime, ymdOf } from "@/lib/zoned";
import { Section } from "@/components/ui";

export async function TodaySlot({ user, place }: { user: CurrentUser; place: "register" | "dashboard" }) {
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "scheduling");
  if (gate === "hidden") return null;
  const tz = await shopTimeZone(shopId);
  const today = ymdOf(new Date(), tz);
  const from = dayStart(today, tz);
  const to = dayStart(addDays(today, 1), tz);
  const items = await calendarItems(shopId, from, to, { shifts: true });
  const appts = items.filter((i) => i.kind === "appointment");
  const classes = items.filter((i) => i.kind === "class" && !i.struck);
  const others = items.filter((i) => i.kind === "run" || i.kind === "install");
  const working = [...new Set(items.filter((i) => i.kind === "shift").map((i) => i.title))];
  if (!appts.length && !classes.length && !others.length && !working.length) return null;

  // Each class meeting today: how many are signed up and how many still owe.
  const classIds = [...new Set(classes.map((c) => c.href.split("/").pop()!))];
  const rows = classIds.length ? await db.enrollment.findMany({ where: { shopId, classId: { in: classIds }, status: "ENROLLED" }, select: { id: true, classId: true, feeCents: true, paidAt: true } }) : [];
  const classWords = classes.map((c) => {
    const id = c.href.split("/").pop()!;
    const mine = rows.filter((r) => r.classId === id);
    const owe = mine.filter((r) => r.feeCents > 0 && !r.paidAt);
    return { item: c, signed: mine.length, owe: owe.length, firstOwing: owe[0]?.id ?? null };
  });
  const parts = [
    appts.length ? `${appts.length} appointment${appts.length === 1 ? "" : "s"}` : null,
    ...classWords.map((c) => `${c.item.title} ${fmtTime(c.item.start, tz)} (${c.signed}${c.owe ? `, ${c.owe} owe` : ""})`),
    ...others.map((o) => `${o.title} ${fmtTime(o.start, tz)}`),
    working.length ? `Working: ${working.join(", ")}` : null,
  ].filter(Boolean);

  const list = (
    <ul className="space-y-1 text-sm">
      {appts.map((a) => (
        <li key={a.id}>
          <Link href={a.href} className="link">
            {fmtTime(a.start, tz)} {a.title}
          </Link>
          {a.sub && <span className="muted"> · {a.sub}</span>}
        </li>
      ))}
      {classWords.map((c) => (
        <li key={c.item.id}>
          <Link href={c.item.href} className="link">
            {fmtTime(c.item.start, tz)} {c.item.title}
          </Link>
          <span className="muted">
            {" "}
            · {c.signed} signed up{c.owe ? `, ${c.owe} owe` : ""}
          </span>
          {c.owe > 0 && place === "register" && (
            <Link href={`/register?booking=enrollment:${c.firstOwing}`} className="link ml-2 text-xs">
              Ring up
            </Link>
          )}
        </li>
      ))}
      {others.map((o) => (
        <li key={`${o.kind}:${o.id}`}>
          <Link href={o.href} className="link">
            {fmtTime(o.start, tz)} {o.title}
          </Link>
          {o.sub && <span className="muted"> · {o.sub}</span>}
        </li>
      ))}
      {working.length > 0 && <li className="muted">Working: {working.join(", ")}</li>}
    </ul>
  );

  if (place === "register") {
    return (
      <details className="card px-4 py-2 text-sm">
        <summary className="cursor-pointer">
          <strong>Today:</strong> {parts.join(" · ")}
        </summary>
        <div className="mt-2">{list}</div>
      </details>
    );
  }
  return (
    <Section
      title="Today"
      actions={
        <Link href="/calendar" className="btn btn-sm">
          Calendar
        </Link>
      }
    >
      {list}
    </Section>
  );
}
