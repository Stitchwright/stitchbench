// Between stores (shop-features-round-2-design.md 7.2, 7.3, 7.7): what other stores asked this store for (Send it /
// Can't this time), what is coming here (It arrived), what this store asked for, what it sent, and stock that sells
// faster at another store (a suggestion: Send it there). Only with more than one store.
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { activeStores, currentStore } from "@/lib/stores";
import { storeTodo, transfersFor, TRANSFER_STATUS_LABEL, lineQty, type TransferView } from "@/lib/transfers";
import { moveSuggestionsFor } from "@/lib/store-orders";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtDate } from "@/lib/format";
import { qtyText } from "@/lib/register-math";
import { cancelTransfer, declineAsked, sendAsked, sendByNumber, sendItem, transferArrived } from "@/actions/transfers";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { Empty, PageHeader, Section } from "@/components/ui";

function Lines({ t }: { t: TransferView }) {
  return (
    <ul className="text-sm">
      {t.lines.map((l) => (
        <li key={l.id}>
          {l.partId ? (
            <Link href={`/parts/${l.partId}`} className="link">
              {l.description}
            </Link>
          ) : (
            l.description
          )}{" "}
          <span className="num font-semibold">× {lineQty({ qty: l.qtySent ?? l.qty, unit: l.unit })}</span>
          {l.qtySent != null && l.qtySent !== l.qty && <span className="muted"> (of {lineQty(l)} asked)</span>}
        </li>
      ))}
    </ul>
  );
}

function Head({ t, tz, what }: { t: TransferView; tz: string; what: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <strong>{what}</strong> <span className="muted text-sm">· {t.status === "ASKED" ? "request" : "transfer"} {t.number}</span>
        {t.forCustomer && (
          <span className="pill tone-wait ml-2">
            for{" "}
            <Link href={`/customers/${t.forCustomer.id}`} className="underline">
              {t.forCustomer.name}
            </Link>
          </span>
        )}
      </div>
      <span className="muted text-sm">
        {t.sentAt ? `Sent ${fmtDate(t.sentAt, tz)}` : t.askedAt ? `Asked ${fmtDate(t.askedAt, tz)}` : ""}
        {t.neededBy ? ` · needed by ${t.neededBy}` : ""}
      </span>
    </div>
  );
}

export default async function TransfersPage() {
  const user = await requireUser();
  const stores = await activeStores(user.shopId);
  if (stores.length <= 1) redirect("/parts");
  const here = (await currentStore(user))!;
  const tz = await shopTimeZone(user.shopId);
  const [todo, recent, suggest] = await Promise.all([storeTodo(user.shopId, here.id), transfersFor(user.shopId, { open: false, storeId: here.id, take: 15 }), moveSuggestionsFor(user.shopId, here, { take: 20 })]);
  const sentFromHere = (await transfersFor(user.shopId, { open: true, storeId: here.id })).filter((t) => t.status === "SENT" && t.from.id === here.id);
  const others = stores.filter((s) => s.id !== here.id);

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Between stores" sub={`At ${here.name}. Stock sent and asked for between your stores; nothing is lost on the way: it shows here until the other store says it arrived.`} />

      <Section title={`Asked of ${here.name}`}>
        {todo.askedOfUs.length === 0 ? (
          <Empty>Nothing asked of this store right now.</Empty>
        ) : (
          <ul className="space-y-4">
            {todo.askedOfUs.map((t) => (
              <li key={t.id} className="rounded border border-line p-3" data-testid="asked-of-us">
                <Head t={t} tz={tz} what={`${t.to.name} asks for`} />
                {t.note && <p className="text-sm">&ldquo;{t.note}&rdquo;</p>}
                <ActionForm action={sendAsked.bind(null, t.id)} className="mt-2 space-y-2">
                  <ul className="space-y-1 text-sm">
                    {t.lines.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-48">{l.description}</span>
                        {l.qtySent != null ? (
                          <span className="pill tone-ready">held here: {lineQty({ qty: l.qtySent, unit: l.unit })}</span>
                        ) : (
                          <label className="text-sm">
                            Send <input name={`qty.${l.id}`} className="input num w-20" inputMode="decimal" defaultValue={l.qty} aria-label={`How many of ${l.description} to send`} />
                          </label>
                        )}
                      </li>
                    ))}
                  </ul>
                  <Submit>Send it</Submit>
                </ActionForm>
                <details className="mt-2">
                  <summary className="link cursor-pointer text-sm">Can&apos;t this time</summary>
                  <ActionForm action={declineAsked.bind(null, t.id)} success="They'll see it" className="mt-2 flex flex-wrap gap-2">
                    <input name="reason" className="input w-72" placeholder="Why, in a few words (sold out here)" aria-label="Why not" />
                    <Submit className="btn btn-sm">Tell them</Submit>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Coming to ${here.name}`}>
        {todo.comingHere.length === 0 ? (
          <Empty>Nothing on its way here.</Empty>
        ) : (
          <ul className="space-y-4">
            {todo.comingHere.map((t) => (
              <li key={t.id} className="rounded border border-line p-3" data-testid="coming-here">
                <Head t={t} tz={tz} what={`From ${t.from.name}`} />
                <Lines t={t} />
                <ActionForm action={transferArrived.bind(null, t.id)} className="mt-2 space-y-2">
                  <details>
                    <summary className="link cursor-pointer text-sm">The box isn&apos;t what was sent?</summary>
                    <ul className="mt-2 space-y-1 text-sm">
                      {t.lines
                        .filter((l) => l.partId)
                        .map((l) => (
                          <li key={l.id}>
                            <label>
                              {l.description}: came <input name={`got.${l.id}`} className="input num w-20" inputMode="decimal" placeholder={String(l.qtySent ?? l.qty)} />
                            </label>
                          </li>
                        ))}
                    </ul>
                  </details>
                  <Submit>It arrived</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {(todo.weAsked.length > 0 || sentFromHere.length > 0) && (
        <Section title="Waiting on the other store">
          <ul className="space-y-3">
            {todo.weAsked.map((t) => (
              <li key={t.id} className="rounded border border-line p-3">
                <Head t={t} tz={tz} what={`Asked ${t.from.name}`} />
                <Lines t={t} />
                <ActionButton action={cancelTransfer.bind(null, t.id)} className="btn btn-sm mt-2" success="Request cancelled">
                  Cancel the request
                </ActionButton>
              </li>
            ))}
            {sentFromHere.map((t) => (
              <li key={t.id} className="rounded border border-line p-3">
                <Head t={t} tz={tz} what={`On the way to ${t.to.name}`} />
                <Lines t={t} />
                <ActionButton action={cancelTransfer.bind(null, t.id)} className="btn btn-sm mt-2" success="Back on the shelf here">
                  It didn&apos;t go: put it back here
                </ActionButton>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Send an item">
        <ActionForm action={sendByNumber} reset className="flex flex-wrap items-end gap-2">
          <div className="field">
            <label htmlFor="send-number" className="label">
              Item number
            </label>
            <input id="send-number" name="number" required className="input w-48" />
          </div>
          <div className="field">
            <label htmlFor="send-qty" className="label">
              How many
            </label>
            <input id="send-qty" name="qty" required className="input num w-20" inputMode="decimal" />
          </div>
          <div className="field">
            <label htmlFor="send-to" className="label">
              To
            </label>
            <select id="send-to" name="toId" className="select w-48">
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <Submit>Send</Submit>
        </ActionForm>
        <p className="muted mt-2 text-sm">Or open the item and use Send to another store. A machine for sale is sent from its own page.</p>
      </Section>

      {suggest.length > 0 && (
        <Section title="Sells faster at another store">
          <p className="muted mb-2 text-sm">A suggestion only: nothing moves until you send it.</p>
          <ul className="divide-y divide-line text-sm">
            {suggest.map((s) => (
              <li key={s.partId} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="move-suggestion">
                <span>
                  <Link href={`/parts/${s.partId}`} className="link">
                    <span className="mono">{s.partNumber}</span> {s.description}
                  </Link>
                  <span className="muted"> · {qtyText(s.qtyHere, s.unit)} here · {s.words}</span>
                </span>
                <ActionForm action={sendItem.bind(null, s.partId)} success="Sent" className="flex items-center gap-2">
                  <input type="hidden" name="toId" value={s.to.id} />
                  <input name="qty" className="input num w-20" inputMode="decimal" defaultValue={s.qtyHere} aria-label={`How many of ${s.partNumber} to send`} />
                  <Submit className="btn btn-sm">Send it there</Submit>
                </ActionForm>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {recent.length > 0 && (
        <Section title="Lately">
          <ul className="divide-y divide-line text-sm">
            {recent.map((t) => (
              <li key={t.id} className="py-2">
                <span className="font-semibold">
                  {t.status === "DECLINED" ? `${t.from.name} couldn't send` : `${t.from.name} to ${t.to.name}`}
                </span>{" "}
                <span className="muted">
                  · {t.status === "ASKED" || t.status === "DECLINED" ? "request" : "transfer"} {t.number} · {TRANSFER_STATUS_LABEL[t.status] ?? t.status}
                  {t.declineReason ? `: ${t.declineReason}` : ""}
                  {t.arrivedAt ? ` ${fmtDate(t.arrivedAt, tz)}` : ""}
                </span>
                <Lines t={t} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
