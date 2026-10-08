// Today at every store (shop-features-round-2-design.md 7.5 and 7.7), made for the owner's phone: one card per store
// with what was taken so far (by payment), sales, repairs waiting and ready, low stock, who's on shift now, and what
// waits for her OK; then the approvals themselves, and the notes between stores. Only with more than one store.
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { activeStores, currentStore } from "@/lib/stores";
import { storesToday, type StoreDay } from "@/lib/owner-today";
import { waitingApprovals } from "@/lib/approvals";
import { notesFor } from "@/lib/store-notes";
import { fmtDateTime, money } from "@/lib/format";
import { shopTimeZone } from "@/lib/shop-zone";
import { decideApproval } from "@/actions/stores";
import { markNotesRead, pinNote, postNote, removeNote } from "@/actions/today";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/ui";

function StoreCard({ d, here }: { d: StoreDay; here: boolean }) {
  const time = (t: Date) => t.toLocaleTimeString("en-US", { timeZone: d.store.timeZone, hour: "numeric", minute: "2-digit" });
  return (
    <section className="card card-pad space-y-3" aria-label={d.store.name} data-testid="store-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="h2">
          {d.store.name}
          {here && <span className="muted text-sm font-normal"> (this computer)</span>}
        </h2>
        <span className="num text-2xl font-semibold" title="Taken today">
          {money(d.takenCents)}
        </span>
      </div>
      {d.tenders.length > 0 && <p className="muted text-sm">{d.tenders.map((t) => `${t.label} ${money(t.cents)}`).join(" · ")}</p>}
      <ul className="grid grid-cols-2 gap-2 text-base">
        <li>
          <span className="num font-semibold">{d.sales}</span> {d.sales === 1 ? "sale" : "sales"}
        </li>
        <li>
          <Link href="/tickets" className="link">
            <span className="num font-semibold">{d.ticketsOpen}</span> repairs waiting
          </Link>
        </li>
        <li>
          <span className="num font-semibold">{d.ticketsReady}</span> ready for pickup
        </li>
        <li>
          <Link href="/parts/orders" className="link">
            <span className="num font-semibold">{d.lowCount}</span> low on stock
          </Link>
        </li>
        {d.toShip > 0 && (
          <li>
            <Link href="/register/online" className="link">
              <span className="num font-semibold">{d.toShip}</span> to ship
            </Link>
          </li>
        )}
        {(d.askedOfUs > 0 || d.comingHere > 0) && (
          <li>
            <Link href="/parts/transfers" className="link">
              {d.askedOfUs > 0 ? `${d.askedOfUs} asked of it` : ""}
              {d.askedOfUs > 0 && d.comingHere > 0 ? ", " : ""}
              {d.comingHere > 0 ? `${d.comingHere} coming` : ""}
            </Link>
          </li>
        )}
        {d.approvals > 0 && (
          <li>
            <a href="#approvals" className="pill tone-wait">
              {d.approvals} waiting for your OK
            </a>
          </li>
        )}
      </ul>
      <p className="text-sm">
        {d.onShift.length ? (
          <>On shift now: {d.onShift.map((s) => `${s.name} (until ${time(s.until)})`).join(", ")}</>
        ) : d.workedToday.length ? (
          <span className="muted">Nobody on shift now. Today: {d.workedToday.join(", ")}</span>
        ) : (
          <span className="muted">No shifts scheduled today.</span>
        )}
      </p>
      {d.lowStock.length > 0 && (
        <details>
          <summary className="link cursor-pointer text-sm">What&apos;s low</summary>
          <ul className="mt-1 text-sm">
            {d.lowStock.map((l) => (
              <li key={l.id}>
                <Link href={`/parts/${l.id}`} className="link mono">
                  {l.partNumber}
                </Link>{" "}
                {l.description}: {l.qty}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default async function TodayPage() {
  const user = await requireUser();
  const stores = await activeStores(user.shopId);
  if (stores.length <= 1) redirect("/");
  const here = await currentStore(user);
  const tz = await shopTimeZone(user.shopId);
  const [days, approvals, notes, older] = await Promise.all([
    user.role === "TECH" ? Promise.resolve([] as StoreDay[]) : storesToday(user.shopId),
    user.role === "OWNER" ? waitingApprovals(user.shopId) : Promise.resolve([]),
    notesFor(user, user.role === "OWNER" ? null : (here?.id ?? null)),
    notesFor(user, user.role === "OWNER" ? null : (here?.id ?? null), { older: true }),
  ]);
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const unread = notes.filter((n) => !n.read).map((n) => n.id);
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Today" sub={user.role === "TECH" ? `At ${here?.name}.` : "Every store's day so far. Tap a line for the detail."} />

      {approvals.length > 0 && (
        <section id="approvals" className="space-y-3" aria-label="Waiting for your OK">
          <h2 className="h2">Waiting for your OK</h2>
          {approvals.map((a) => (
            <div key={a.id} className="card card-pad space-y-2 text-base" data-testid="approval">
              <p>
                <strong>{a.askedBy ?? "Someone"}</strong>
                {a.storeId ? ` at ${storeName.get(a.storeId) ?? "a store"}` : ""} asks to give {a.words}.
              </p>
              {a.reason && <p>&ldquo;{a.reason}&rdquo;</p>}
              <p className="muted text-sm">
                <Link href={`/today/approvals/${a.id}`} className="link">
                  See the sale
                </Link>{" "}
                · asked {fmtDateTime(a.at, tz)}
              </p>
              <div className="flex flex-wrap gap-2">
                <ActionButton action={decideApproval.bind(null, a.id, true)} className="btn btn-primary min-h-11" success="Approved: the register goes on">
                  Approve
                </ActionButton>
                <ActionButton action={decideApproval.bind(null, a.id, false)} className="btn min-h-11" success="They'll see Not this time">
                  Not this time
                </ActionButton>
              </div>
            </div>
          ))}
        </section>
      )}

      {days.map((d) => (
        <StoreCard key={d.store.id} d={d} here={d.store.id === here?.id} />
      ))}

      <Section
        title="Notes between stores"
        actions={
          unread.length > 0 ? (
            <ActionButton action={markNotesRead.bind(null, unread)} className="btn btn-sm" success="Marked read">
              Mark {unread.length} read
            </ActionButton>
          ) : undefined
        }
      >
        <ActionForm action={postNote} reset success="Posted" className="mb-4 space-y-2">
          <label htmlFor="note-text" className="label">
            A note for
          </label>
          <div className="flex flex-wrap gap-2">
            <select name="to" className="select w-48" aria-label="For which store" defaultValue="all">
              <option value="all">All stores</option>
              {stores
                .filter((s) => s.id !== here?.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <input id="note-text" name="text" required maxLength={500} className="input min-w-0 flex-1" placeholder="The Bernina rep visits Thursday" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {user.role !== "TECH" && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="pinned" className="check" /> Pin it to the top
              </label>
            )}
            <Submit className="btn btn-primary">Post the note</Submit>
          </div>
        </ActionForm>
        {notes.length === 0 ? (
          <Empty>No notes yet. A note here reaches the other store&apos;s Today page.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {notes.map((n) => (
              <li key={n.id} className="py-3" data-testid="store-note">
                <p className={`text-base ${n.read ? "" : "font-semibold"}`}>
                  {n.pinned && <span className="pill tone-wait mr-2">Pinned</span>}
                  {n.text}
                </p>
                <p className="muted text-sm">
                  {n.from}
                  {n.fromStore ? ` (${n.fromStore})` : ""} to {n.to} · {fmtDateTime(n.at, tz)}
                  {n.readBy.length > 0 && ` · read by ${n.readBy.join(", ")}`}
                </p>
                <div className="mt-1 flex flex-wrap gap-3 text-sm">
                  {user.role !== "TECH" && (
                    <ActionButton action={pinNote.bind(null, n.id, !n.pinned)} className="link">
                      {n.pinned ? "Unpin" : "Pin"}
                    </ActionButton>
                  )}
                  {(n.mine || user.role !== "TECH") && (
                    <ActionButton action={removeNote.bind(null, n.id)} className="link" success="Note taken down">
                      Take it down
                    </ActionButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {older.length > 0 && (
          <details className="mt-3">
            <summary className="link cursor-pointer text-sm">Older notes ({older.length})</summary>
            <ul className="mt-2 divide-y divide-line text-sm">
              {older.map((n) => (
                <li key={n.id} className="py-2">
                  {n.text} <span className="muted">· {n.from} to {n.to}, {fmtDateTime(n.at, tz)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>
    </div>
  );
}
