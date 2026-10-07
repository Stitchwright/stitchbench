"use client";
// Rentals (shop-features-round-2-design.md 1.8): "Rent it out" (a rental that's in, the customer, the rate a day, week or
// month, rent-to-own) and, for one out, "Take rent" and "Buy it now" (the rent credit off its price). Each rings up its
// own sale; the receipt link shows after.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { buyRental, payRent, rentOut } from "@/actions/rentals";
import { CustomerPicker } from "@/components/customer-picker";
import { money, toCents } from "@/lib/format";
import { TENDER_LABEL, type TenderMethod } from "@/lib/register-math";

const METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK", "OTHER"];
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

function PayBy({ method, onChange }: { method: TenderMethod; onChange: (m: TenderMethod) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Paid by">
      {METHODS.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn min-h-11 ${method === m ? "btn-primary" : ""}`} onClick={() => onChange(m)}>
          {TENDER_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

function Receipt({ done }: { done: { saleId: string; number: number } | null }) {
  return done ? (
    <p className="text-base">
      <Link href={`/register/sales/${done.saleId}`} className="link">
        Receipt for sale #{done.number}
      </Link>
    </p>
  ) : null;
}

export function RentOutForm({ units }: { units: { id: string; description: string; priceCents: number | null }[] }) {
  const router = useRouter();
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [rate, setRate] = useState("");
  const [per, setPer] = useState("month");
  const [periods, setPeriods] = useState("1");
  const [ownPct, setOwnPct] = useState("100");
  const [ownMonths, setOwnMonths] = useState("3");
  const [method, setMethod] = useState<TenderMethod>("CARD");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ saleId: string; number: number } | null>(null);
  const [k] = useState(key);
  if (!units.length) return <p className="muted text-base">No rentals in the shop. Set a machine for sale as a rental on its page.</p>;
  const cents = toCents(rate) ?? 0;
  return (
    <form
      className="space-y-3 text-base"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        try {
          const r = await rentOut({ unitId, customerId: (fd.get("customerId") as string) || null, rateCents: cents, ratePer: per, periods: Number(periods), ownPct: Number(ownPct), ownMonths: Number(ownMonths), tender: { method, amountCents: 0 }, clientKey: k });
          if ("error" in r) toast.error(r.error);
          else {
            toast.success("Rented out; the first rent is rung up.");
            setDone(r);
            router.refresh();
          }
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="rent-unit" className="label">
          Rental (only those in the shop)
        </label>
        <select id="rent-unit" className="select text-base" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.description}
              {u.priceCents != null ? ` (sells for ${money(u.priceCents)})` : ""}
            </option>
          ))}
        </select>
      </div>
      <CustomerPicker initial={null} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor="rent-rate" className="label">
            Rent
          </label>
          <input id="rent-rate" className="input num w-28 text-base" inputMode="decimal" placeholder="$40.00" value={rate} onChange={(e) => setRate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rent-per" className="label">
            A
          </label>
          <select id="rent-per" className="select text-base" value={per} onChange={(e) => setPer(e.target.value)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="rent-periods" className="label">
            Paying now for
          </label>
          <input id="rent-periods" className="input num w-20 text-base" inputMode="numeric" value={periods} onChange={(e) => setPeriods(e.target.value)} />
        </div>
      </div>
      <details>
        <summary className="link cursor-pointer text-base">Rent-to-own: {ownPct}% of the rent counts toward buying it for {ownMonths} months</summary>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="field">
            <label htmlFor="rent-own" className="label">
              Percent of rent that counts
            </label>
            <input id="rent-own" className="input num w-20" inputMode="numeric" value={ownPct} onChange={(e) => setOwnPct(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="rent-own-months" className="label">
              For (months)
            </label>
            <input id="rent-own-months" className="input num w-20" inputMode="numeric" value={ownMonths} onChange={(e) => setOwnMonths(e.target.value)} />
          </div>
        </div>
      </details>
      <PayBy method={method} onChange={setMethod} />
      <button className="btn btn-primary min-h-11" disabled={busy || !unitId || cents <= 0}>
        {busy ? "Renting..." : `Rent it out${cents > 0 ? ` (${money(cents * (Number(periods) || 1))} plus tax now)` : ""}`}
      </button>
      <Receipt done={done} />
    </form>
  );
}

export function RentalMoney({ loanId, rateCents, ratePer, creditCents, priceCents }: { loanId: string; rateCents: number; ratePer: string; creditCents: number; priceCents: number | null }) {
  const router = useRouter();
  const [periods, setPeriods] = useState("1");
  const [method, setMethod] = useState<TenderMethod>("CARD");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ saleId: string; number: number } | null>(null);
  const [k, setK] = useState(key);
  const run = async (fn: () => Promise<{ saleId: string; number: number } | { error: string }>, words: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(words);
        setDone(r);
        setK(key());
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 text-base">
      <PayBy method={method} onChange={setMethod} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor={`rp-${loanId}`} className="label">
            {ratePer === "day" ? "Days" : ratePer === "week" ? "Weeks" : "Months"} of rent
          </label>
          <input id={`rp-${loanId}`} className="input num w-20" inputMode="numeric" value={periods} onChange={(e) => setPeriods(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary min-h-11" disabled={busy} onClick={() => run(() => payRent(loanId, Number(periods) || 1, { method, amountCents: 0 }, k), "Rent taken.")}>
          Take {money(rateCents * (Number(periods) || 1))} rent (plus tax)
        </button>
        {priceCents != null && (
          <button type="button" className="btn min-h-11" disabled={busy} onClick={() => run(() => buyRental(loanId, { method, amountCents: 0 }, k), "Sold to her.")}>
            Buy it now: {money(priceCents - creditCents)}
            {creditCents > 0 ? ` (${money(creditCents)} rent credit)` : ""}
          </button>
        )}
      </div>
      <Receipt done={done} />
    </div>
  );
}
