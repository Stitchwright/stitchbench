"use client";
// "Lend a machine" (shop-features-round-2-design.md 1.7): one of the loaners that are in, who borrows it (filled in on a
// ticket), when it's due back (filled in), the deposit (the shop's default; none: a "card on file" note instead), the
// condition going out ("Good"). One main button; the loan slip to sign prints from the next page.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { lendMachine } from "@/actions/loans";
import type { CustomerHit } from "@/actions/register";
import { CustomerPicker } from "@/components/customer-picker";
import { money, toCents } from "@/lib/format";
import { TENDER_LABEL, type TenderMethod } from "@/lib/register-math";

const METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK", "OTHER"];
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export function LendForm({
  units,
  kind = "LOAN",
  customer,
  ticketId,
  dueOn,
  depositCents,
}: {
  units: { id: string; description: string }[];
  kind?: "LOAN" | "DEMO";
  customer: CustomerHit | null;
  ticketId?: string | null;
  dueOn: string;
  depositCents: number;
}) {
  const router = useRouter();
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [due, setDue] = useState(dueOn);
  const [deposit, setDeposit] = useState(depositCents ? (depositCents / 100).toFixed(2) : "");
  const [method, setMethod] = useState<TenderMethod>("CASH");
  const [cardNote, setCardNote] = useState("");
  const [condition, setCondition] = useState("Good");
  const [busy, setBusy] = useState(false);
  const [k] = useState(key);
  const cents = deposit.trim() ? (toCents(deposit) ?? -1) : 0;
  if (!units.length) return <p className="muted text-base">{kind === "DEMO" ? "No demos in the shop right now." : "No loaners in the shop right now."} Set a machine for sale as a {kind === "DEMO" ? "demo" : "loaner"} on its page.</p>;
  return (
    <form
      className="space-y-3 text-base"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        try {
          const r = await lendMachine({
            unitId,
            kind,
            customerId: (fd.get("customerId") as string) || customer?.id || null,
            ticketId: ticketId ?? null,
            dueOn: due || null,
            depositCents: cents > 0 ? cents : 0,
            tender: cents > 0 ? { method, amountCents: cents } : null,
            cardNote: cardNote || null,
            conditionOut: condition,
            clientKey: k,
          });
          if ("error" in r) toast.error(r.error);
          else {
            toast.success(cents > 0 ? `Lent, with a ${money(cents)} deposit.` : "Lent.");
            router.push(`/units/loans/${r.loanId}`);
          }
        } catch {
          toast.error("It didn't go through (no connection?). Press it again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="lend-unit" className="label">
          {kind === "DEMO" ? "Demo" : "Loaner"} (only those in the shop)
        </label>
        <select id="lend-unit" className="select text-base" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.description}
            </option>
          ))}
        </select>
      </div>
      {!customer && <CustomerPicker initial={null} />}
      <div className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor="lend-due" className="label">
            Due back
          </label>
          <input id="lend-due" type="date" className="input text-base" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="lend-deposit" className="label">
            Deposit (blank: none)
          </label>
          <input id="lend-deposit" className="input num w-28 text-base" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="lend-condition" className="label">
            Condition going out
          </label>
          <input id="lend-condition" className="input text-base" value={condition} onChange={(e) => setCondition(e.target.value)} />
        </div>
      </div>
      {cents > 0 ? (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Deposit paid by">
          {METHODS.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn min-h-11 ${method === m ? "btn-primary" : ""}`} onClick={() => setMethod(m)}>
              {TENDER_LABEL[m]}
            </button>
          ))}
        </div>
      ) : (
        <div className="field">
          <label htmlFor="lend-card" className="label">
            Card on file (optional note)
          </label>
          <input id="lend-card" className="input text-base" placeholder="Visa ending 4242" value={cardNote} onChange={(e) => setCardNote(e.target.value)} />
        </div>
      )}
      <button className="btn btn-primary min-h-11" disabled={busy || !unitId || cents < 0}>
        {busy ? "Lending..." : kind === "DEMO" ? "Take the demo out" : "Lend it"}
      </button>
    </form>
  );
}
