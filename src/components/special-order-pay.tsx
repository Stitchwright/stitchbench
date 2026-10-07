"use client";
// A payment toward a special order at the counter (shop-features-round-2-design.md 1.2): the amount (what is left filled
// in) and how she pays. One main button; the receipt link shows after.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { paySpecialOrder } from "@/actions/special-orders";
import { money, toCents } from "@/lib/format";
import { TENDER_LABEL, type TenderMethod } from "@/lib/register-math";

const METHODS: TenderMethod[] = ["CASH", "CARD", "CHECK", "CREDIT", "GIFT", "OTHER"];
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export function SpecialOrderPay({ id, leftCents }: { id: string; leftCents: number }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<TenderMethod>("CASH");
  const [card, setCard] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ saleId: string; number: number } | null>(null);
  const [k, setK] = useState<{ sent: string; key: string } | null>(null);
  const cents = amount === "" ? leftCents : (toCents(amount) ?? -1);
  return (
    <div className="space-y-3 text-base">
      <div className="field max-w-xs">
        <label htmlFor="sop-amount" className="label">
          Payment
        </label>
        <input id="sop-amount" className="input num text-base" inputMode="decimal" placeholder={(leftCents / 100).toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Paid by">
        {METHODS.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn min-h-11 ${method === m ? "btn-primary" : ""}`} onClick={() => setMethod(m)}>
            {TENDER_LABEL[m]}
          </button>
        ))}
      </div>
      {(method === "GIFT" || method === "CREDIT") && (
        <div className="field max-w-xs">
          <label htmlFor="sop-card" className="label">
            {method === "GIFT" ? "Gift card number" : "Store credit number (blank: hers)"}
          </label>
          <input id="sop-card" className="input mono" autoComplete="off" value={card} onChange={(e) => setCard(e.target.value)} />
        </div>
      )}
      <button
        type="button"
        className="btn btn-primary min-h-11"
        disabled={busy || cents <= 0}
        onClick={async () => {
          setBusy(true);
          const sent = JSON.stringify({ cents, method, card });
          const useKey = k?.sent === sent ? k.key : key();
          setK({ sent, key: useKey });
          try {
            const r = await paySpecialOrder(id, cents, { method, amountCents: cents, cardNumber: card.trim() || null }, useKey);
            if ("error" in r) toast.error(r.error);
            else {
              toast.success(`Payment of ${money(cents)} taken.`);
              setDone(r.saleId && r.number ? { saleId: r.saleId, number: r.number } : null);
              setAmount("");
              setK(null);
              router.refresh();
            }
          } catch {
            toast.error("It didn't go through (no connection?). Press it again: a payment that did save won't be taken twice.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Take {cents > 0 ? money(cents) : "the payment"}
      </button>
      {done && (
        <p>
          <Link href={`/register/sales/${done.saleId}`} className="link">
            Receipt for sale #{done.number}
          </Link>
        </p>
      )}
    </div>
  );
}
