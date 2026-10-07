// The "Merge or delete" card on a customer's and a machine's page (round 3 L126), for the owner and admins. Driven by the
// page's address so the preview is worked out on the server: ?mergeq= searches for the record to keep, ?merge=<id>
// shows what a merge would move, ?delete=1 what a delete would do; then the name is typed to confirm (merge-form.tsx).
import Link from "next/link";
import { Section } from "@/components/ui";
import { ConfirmForm } from "@/components/merge-form";
import { deleteCustomer, deleteMachine, mergeCustomer, mergeMachine } from "@/actions/merge";
import { customerDeletePlan, customerMergeCandidates, customerMergePlan, machineDeletePlan, machineMergeCandidates, machineMergePlan, type Plan } from "@/lib/merge";
import { fmtPhone, toE164 } from "@/lib/phone";
import type { CurrentUser } from "@/lib/session";
import { isUserError } from "@/lib/user-error";

export type MergeParams = { merge?: string; mergeq?: string; delete?: string };

async function planOr(fn: () => Promise<Plan>): Promise<Plan | string> {
  try {
    return await fn();
  } catch (e) {
    if (isUserError(e)) return e.message;
    throw e;
  }
}

function PlanView({ plan, empty }: { plan: Plan | string; empty: string }) {
  if (typeof plan === "string") return <p className="mt-3 rounded bg-[var(--bad-bg)] p-3 text-sm text-[var(--bad)]">{plan}</p>;
  return (
    <div className="mt-3 space-y-2 text-sm">
      {plan.rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {plan.rows.map((r, i) => (
            <li key={i} className="py-1.5">
              <span className="font-semibold">{r.what}</span>: {r.then}
            </li>
          ))}
        </ul>
      )}
      {plan.notes.map((n, i) => (
        <p key={i} className="muted">
          {n}
        </p>
      ))}
      {plan.blockers.length > 0 && (
        <div className="rounded bg-[var(--bad-bg)] p-3 text-[var(--bad)]">
          <p className="font-semibold">Not possible yet:</p>
          <ul className="mt-1 list-disc pl-5">
            {plan.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SearchForm({ base, q, placeholder }: { base: string; q: string; placeholder: string }) {
  return (
    <form method="get" action={base} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="field">
        <label htmlFor="mergeq" className="label">
          Find the one to keep
        </label>
        <input id="mergeq" name="mergeq" defaultValue={q} placeholder={placeholder} className="input" />
      </div>
      <button type="submit" className="btn">
        Search
      </button>
    </form>
  );
}

export async function CustomerMergePanel({ user, customer, sp }: { user: CurrentUser; customer: { id: string; name: string }; sp: MergeParams }) {
  if (user.role === "TECH") return null;
  const base = `/customers/${customer.id}`;
  const q = (sp.mergeq ?? "").trim();
  const merge = sp.merge ? await planOr(() => customerMergePlan(user, customer.id, sp.merge!)) : null;
  const del = sp.delete === "1" ? await planOr(() => customerDeletePlan(user, customer.id)) : null;
  const candidates = merge ? [] : await customerMergeCandidates(user, customer.id, q);
  return (
    <Section title="Merge or delete" id="merge">
      <details open={sp.merge !== undefined || sp.mergeq !== undefined}>
        <summary className="cursor-pointer font-semibold">Merge into another customer…</summary>
        <p className="muted mt-2 text-sm">
          For a duplicate: everything of {customer.name} moves to the customer you keep, their details fill its blanks, and {customer.name} is deleted.
        </p>
        {merge ? (
          <>
            <PlanView plan={merge} empty={`Nothing points at ${customer.name}: only the record goes.`} />
            {typeof merge !== "string" && merge.blockers.length === 0 && (
              <ConfirmForm id="merge-confirm" action={mergeCustomer.bind(null, customer.id, merge.into!.id)} word={merge.confirm} label={`Merge into ${merge.into!.name}`} />
            )}
            <Link href={`${base}?mergeq=#merge`} className="link mt-3 inline-block text-sm">
              Pick another customer
            </Link>
          </>
        ) : (
          <>
            <SearchForm base={`${base}#merge`} q={q} placeholder="Name, phone or email" />
            <p className="muted mt-3 text-xs">{q ? `Matching "${q}":` : "Same name, email or phone:"}</p>
            {candidates.length === 0 ? (
              <p className="muted text-sm">None found.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {candidates.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <Link href={`/customers/${c.id}`} className="link">
                        {c.name}
                      </Link>
                      <span className="muted">
                        {c.phone ? ` · ${toE164(c.phone) ? fmtPhone(toE164(c.phone)!) : c.phone}` : ""}
                        {c.email ? ` · ${c.email}` : ""} · {c._count.tickets} ticket{c._count.tickets === 1 ? "" : "s"}, {c._count.machines} machine{c._count.machines === 1 ? "" : "s"}
                      </span>
                    </span>
                    <Link href={`${base}?merge=${encodeURIComponent(c.id)}#merge`} className="btn btn-sm">
                      Merge into this one
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </details>
      <details open={!!del} className="mt-4">
        <summary className="cursor-pointer font-semibold">Delete this customer…</summary>
        <p className="muted mt-2 text-sm">
          For a customer who asks you to delete their details, or a record made by mistake. Money records stay in the books without their name; the consent record and opt-outs stay, as the law
          expects.
        </p>
        {del ? (
          <>
            <PlanView plan={del} empty="Nothing else points at this customer: only the record goes." />
            {typeof del !== "string" && del.blockers.length === 0 && <ConfirmForm id="delete-confirm" action={deleteCustomer.bind(null, customer.id)} word={del.confirm} label="Delete for good" />}
          </>
        ) : (
          <Link href={`${base}?delete=1#merge`} className="link mt-2 inline-block text-sm">
            Show what deleting would do
          </Link>
        )}
      </details>
    </Section>
  );
}

export async function MachineMergePanel({ user, machine, noun, sp }: { user: CurrentUser; machine: { id: string; brand: string; model: string }; noun: string; sp: MergeParams }) {
  if (user.role === "TECH") return null;
  const base = `/machines/${machine.id}`;
  const q = (sp.mergeq ?? "").trim();
  const name = `${machine.brand} ${machine.model}`;
  const merge = sp.merge ? await planOr(() => machineMergePlan(user, machine.id, sp.merge!)) : null;
  const del = sp.delete === "1" ? await planOr(() => machineDeletePlan(user, machine.id)) : null;
  const candidates = merge ? [] : await machineMergeCandidates(user, machine.id, q);
  return (
    <Section title="Merge or delete" id="merge">
      <details open={sp.merge !== undefined || sp.mergeq !== undefined}>
        <summary className="cursor-pointer font-semibold">Merge into another {noun}…</summary>
        <p className="muted mt-2 text-sm">For one entered twice: its tickets, photos and the rest move to the one you keep, and this record is deleted.</p>
        {merge ? (
          <>
            <PlanView plan={merge} empty={`Nothing points at this ${noun}: only the record goes.`} />
            {typeof merge !== "string" && merge.blockers.length === 0 && (
              <ConfirmForm id="merge-confirm" action={mergeMachine.bind(null, machine.id, merge.into!.id)} word={merge.confirm} label={`Merge into ${merge.into!.name}`} />
            )}
            <Link href={`${base}?mergeq=#merge`} className="link mt-3 inline-block text-sm">
              Pick another {noun}
            </Link>
          </>
        ) : (
          <>
            <SearchForm base={`${base}#merge`} q={q} placeholder="Serial, brand, model or owner" />
            <p className="muted mt-3 text-xs">{q ? `Matching "${q}":` : "Same model, owner or serial:"}</p>
            {candidates.length === 0 ? (
              <p className="muted text-sm">None found.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {candidates.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <Link href={`/machines/${m.id}`} className="link">
                        {m.brand} {m.model}
                      </Link>
                      <span className="muted">
                        {m.serial ? <span className="mono"> SN {m.serial}</span> : " · no serial"}
                        {m.customer ? ` · ${m.customer.name}` : ""} · {m._count.tickets} ticket{m._count.tickets === 1 ? "" : "s"}
                      </span>
                    </span>
                    <Link href={`${base}?merge=${encodeURIComponent(m.id)}#merge`} className="btn btn-sm">
                      Merge into this one
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </details>
      <details open={!!del} className="mt-4">
        <summary className="cursor-pointer font-semibold">Delete this {noun}…</summary>
        <p className="muted mt-2 text-sm">For a record entered by mistake. One with tickets is merged instead: its history and bills stay.</p>
        {del ? (
          <>
            <PlanView plan={del} empty={`Nothing else points at this ${noun}: only the record goes.`} />
            {typeof del !== "string" && del.blockers.length === 0 && <ConfirmForm id="delete-confirm" action={deleteMachine.bind(null, machine.id)} word={del.confirm} label="Delete for good" />}
          </>
        ) : (
          <Link href={`${base}?delete=1#merge`} className="link mt-2 inline-block text-sm">
            Show what deleting {name} would do
          </Link>
        )}
      </details>
    </Section>
  );
}
