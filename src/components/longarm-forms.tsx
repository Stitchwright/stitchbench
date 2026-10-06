"use client";
// Longarm quilting's forms (fabric-smarts-design.md section 4a, package F7): the work order form with the price shown as
// it is typed, the status buttons, collecting (the tender, billed as a register sale), photos and the certified flag.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, Trash2 } from "lucide-react";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { shrinkImage } from "@/components/photo-upload";
import { collectLongarmOrder, deleteLongarmPhoto, saveLongarmOrder, setLongarmCertified, setLongarmStatus, startLongarmOrder } from "@/actions/longarm";
import { MOVES, STATUS_LABEL, orderCents, rateTenthFrom } from "@/lib/longarm-math";
import type { LongarmDesign, LongarmPricing, LongarmStatus } from "@/generated/prisma/enums";

export type OrderDraft = {
  widthIn: number;
  lengthIn: number;
  pricing: LongarmPricing;
  rate: string; // cents a square inch, "2.5"
  flat: string; // dollars
  design: LongarmDesign;
  designName: string;
  thread: string;
  threadPrice: string;
  batting: string;
  battingPrice: string;
  extra: string;
  extraNote: string;
  taxable: boolean;
  due: string; // YYYY-MM-DD
  note: string;
};

const BLANK: OrderDraft = { widthIn: 0, lengthIn: 0, pricing: "PER_SQIN", rate: "", flat: "", design: "PANTOGRAPH", designName: "", thread: "", threadPrice: "", batting: "", battingPrice: "", extra: "", extraNote: "", taxable: true, due: "", note: "" };

const dollars = (s: string) => {
  const n = Math.round(Number(s.replace(/[$,\s]/g, "")) * 100);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

function Field({ id, label, hint, children, wide }: { id: string; label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`field ${wide ? "sm:col-span-2" : ""}`}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && <p className="muted mt-1 text-xs">{hint}</p>}
    </div>
  );
}

/** The fields of a work order, with the price worked out as they are typed (the server works it out again). */
function OrderFields({ init, p }: { init: OrderDraft; p: string }) {
  const [d, setD] = useState(init);
  const set = <K extends keyof OrderDraft>(k: K, v: OrderDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const w = Math.max(0, Math.round(Number(d.widthIn)) || 0);
  const l = Math.max(0, Math.round(Number(d.lengthIn)) || 0);
  const price = orderCents({ pricing: d.pricing, widthIn: w, lengthIn: l, rateTenthCents: rateTenthFrom(d.rate) ?? 0, flatCents: dollars(d.flat), threadCents: dollars(d.threadPrice), battingCents: dollars(d.battingPrice), extraCents: dollars(d.extra) });
  return (
    <>
      <Field id={`${p}w`} label="Width (inches)">
        <input id={`${p}w`} name="widthIn" className="input num" inputMode="numeric" required value={d.widthIn || ""} onChange={(e) => set("widthIn", Number(e.target.value.replace(/\D/g, "")))} />
      </Field>
      <Field id={`${p}l`} label="Length (inches)">
        <input id={`${p}l`} name="lengthIn" className="input num" inputMode="numeric" required value={d.lengthIn || ""} onChange={(e) => set("lengthIn", Number(e.target.value.replace(/\D/g, "")))} />
      </Field>
      <Field id={`${p}pricing`} label="Priced">
        <select id={`${p}pricing`} name="pricing" className="input" value={d.pricing} onChange={(e) => set("pricing", e.target.value as LongarmPricing)}>
          <option value="PER_SQIN">By the square inch</option>
          <option value="FLAT">One flat price</option>
        </select>
      </Field>
      {d.pricing === "PER_SQIN" ? (
        <Field id={`${p}rate`} label="Cents per square inch" hint={w && l ? `${(w * l).toLocaleString()} square inches` : "Like 2.5"}>
          <input id={`${p}rate`} name="rate" className="input num" inputMode="decimal" value={d.rate} onChange={(e) => set("rate", e.target.value)} placeholder="2.5" />
        </Field>
      ) : (
        <Field id={`${p}flat`} label="Flat price (dollars)">
          <input id={`${p}flat`} name="flat" className="input num" inputMode="decimal" value={d.flat} onChange={(e) => set("flat", e.target.value)} />
        </Field>
      )}
      <Field id={`${p}design`} label="Design">
        <select id={`${p}design`} name="design" className="input" value={d.design} onChange={(e) => set("design", e.target.value as LongarmDesign)}>
          <option value="PANTOGRAPH">Pantograph (edge to edge)</option>
          <option value="CUSTOM">Custom</option>
        </select>
      </Field>
      <Field id={`${p}dn`} label="Pattern (optional)">
        <input id={`${p}dn`} name="designName" className="input" maxLength={80} value={d.designName} onChange={(e) => set("designName", e.target.value)} placeholder="Baptist fan" />
      </Field>
      <Field id={`${p}thread`} label="Thread (optional)">
        <input id={`${p}thread`} name="thread" className="input" maxLength={80} value={d.thread} onChange={(e) => set("thread", e.target.value)} placeholder="Glide, ivory" />
      </Field>
      <Field id={`${p}tp`} label="Thread price (dollars)">
        <input id={`${p}tp`} name="threadPrice" className="input num" inputMode="decimal" value={d.threadPrice} onChange={(e) => set("threadPrice", e.target.value)} />
      </Field>
      <Field id={`${p}batting`} label="Batting (optional)">
        <input id={`${p}batting`} name="batting" className="input" maxLength={80} value={d.batting} onChange={(e) => set("batting", e.target.value)} placeholder="Warm & Natural, queen" />
      </Field>
      <Field id={`${p}bp`} label="Batting price (dollars)">
        <input id={`${p}bp`} name="battingPrice" className="input num" inputMode="decimal" value={d.battingPrice} onChange={(e) => set("battingPrice", e.target.value)} />
      </Field>
      <Field id={`${p}extra`} label="Extras (dollars)" hint="Binding, trimming, a rush fee">
        <input id={`${p}extra`} name="extra" className="input num" inputMode="decimal" value={d.extra} onChange={(e) => set("extra", e.target.value)} />
      </Field>
      <Field id={`${p}en`} label="What the extras are">
        <input id={`${p}en`} name="extraNote" className="input" maxLength={120} value={d.extraNote} onChange={(e) => set("extraNote", e.target.value)} />
      </Field>
      <Field id={`${p}due`} label="Due">
        <input id={`${p}due`} name="due" type="date" className="input" value={d.due} onChange={(e) => set("due", e.target.value)} />
      </Field>
      <div className="field flex items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="hidden" name="taxable" value="off" />
          <input type="checkbox" name="taxable" value="on" className="check" checked={d.taxable} onChange={(e) => set("taxable", e.target.checked)} /> Taxable
        </label>
      </div>
      <Field id={`${p}note`} label="Note" wide>
        <input id={`${p}note`} name="note" className="input" maxLength={1000} value={d.note} onChange={(e) => set("note", e.target.value)} />
      </Field>
      <p className="sm:col-span-2 text-sm" aria-live="polite">
        <span className="muted">Quilting </span>
        <span className="num font-semibold">{money(price.quiltCents)}</span>
        <span className="muted"> · with thread, batting and extras </span>
        <span className="num font-semibold">{money(price.totalCents)}</span>
        <span className="muted"> before tax</span>
      </p>
    </>
  );
}

export function NewOrderForm() {
  return (
    <ActionForm action={startLongarmOrder} className="grid gap-2 sm:grid-cols-2">
      <CustomerPicker initial={null} />
      <OrderFields init={BLANK} p="new-" />
      <div className="sm:col-span-2">
        <Submit>Take it in</Submit>
      </div>
    </ActionForm>
  );
}

export function EditOrderForm({ id, init }: { id: string; init: OrderDraft }) {
  return (
    <ActionForm action={saveLongarmOrder.bind(null, id)} className="grid gap-2 sm:grid-cols-2">
      <OrderFields init={init} p="edit-" />
      <div className="sm:col-span-2">
        <Submit>Save</Submit>
      </div>
    </ActionForm>
  );
}

/** The moves the work order can make by hand (see MOVES), as buttons. */
export function StatusButtons({ id, status }: { id: string; status: LongarmStatus }) {
  const moves = MOVES[status];
  if (!moves.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {moves.map((to) => (
        <ActionButton
          key={to}
          action={setLongarmStatus.bind(null, id, to)}
          className={`btn btn-sm ${to === "CANCELLED" ? "btn-danger" : to === STATUS_NEXT[status] ? "btn-primary" : ""}`}
          confirm={to === "CANCELLED" ? "Tap again to cancel this work order" : undefined}
        >
          {to === "RECEIVED" && status === "CANCELLED" ? "Reopen" : to === "CANCELLED" ? "Cancel" : to === STATUS_NEXT[status] ? `Now ${STATUS_LABEL[to].toLowerCase()}` : `Back to ${STATUS_LABEL[to].toLowerCase()}`}
        </ActionButton>
      ))}
    </div>
  );
}
const STATUS_NEXT: Partial<Record<LongarmStatus, LongarmStatus>> = { RECEIVED: "ON_FRAME", ON_FRAME: "READY" };

/** A ready quilt is collected and paid here: billed as a register sale in the tender chosen. */
export function CollectForm({ id, totalLabel }: { id: string; totalLabel: string }) {
  return (
    <ActionForm action={collectLongarmOrder.bind(null, id)} className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="lc-method">
        Paid by
      </label>
      <select id="lc-method" name="method" defaultValue="CASH" className="input w-28">
        <option value="CASH">Cash</option>
        <option value="CARD">Card</option>
        <option value="CHECK">Check</option>
        <option value="GIFT">Gift card</option>
        <option value="OTHER">Other</option>
      </select>
      <Submit className="btn btn-primary">Collect and take payment{totalLabel ? ` (${totalLabel})` : ""}</Submit>
    </ActionForm>
  );
}

export function PhotoAdd({ orderId }: { orderId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.set("orderId", orderId);
        fd.set("file", await shrinkImage(f), "photo.jpg");
        const r = await fetch("/api/longarm-photos", { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.text()) || "Upload failed.");
      }
      toast.success(files.length > 1 ? `${files.length} photos added` : "Photo added");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <>
      <input ref={input} id={`lp-${orderId}`} type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => upload(e.target.files)} />
      <label htmlFor={`lp-${orderId}`} className={`btn btn-sm cursor-pointer ${busy ? "opacity-60" : ""}`}>
        <Camera size={14} aria-hidden /> {busy ? "Uploading..." : "Add photo"}
      </label>
    </>
  );
}

export function PhotoDelete({ orderId, photoId }: { orderId: string; photoId: string }) {
  return (
    <ActionButton action={deleteLongarmPhoto.bind(null, orderId, photoId)} className="btn btn-sm btn-danger" confirm="Delete?" title="Delete photo">
      <Trash2 size={12} aria-label="Delete" />
    </ActionButton>
  );
}

/** On the customer's page: certified to rent the longarm, or not. */
export function CertifyButton({ customerId, certified }: { customerId: string; certified: boolean }) {
  return (
    <ActionButton action={setLongarmCertified.bind(null, customerId, !certified)} className="btn btn-sm" confirm={certified ? "Tap again to take the certification away" : undefined}>
      {certified ? "Take away certification" : "Certify to rent"}
    </ActionButton>
  );
}
