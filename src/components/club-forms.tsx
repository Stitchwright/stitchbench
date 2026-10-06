"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ActionButton, ActionForm, Submit, runAction } from "@/components/action-form";
import { CustomerPicker } from "@/components/customer-picker";
import { addClubMember, cancelMember, closeClub, markMemberPaid, markPickDone, takeBackMemberPaid, pauseMember, resumeMember, saveClub, saveClubMember, setClubMonth, startCardLink, startClub, undoPick } from "@/actions/clubs";

type Kind = "FAT_QUARTER" | "FABRIC" | "BOM" | "OTHER";
export type SeriesOption = { id: string; name: string };
const KINDS: { v: Kind; label: string }[] = [
  { v: "FAT_QUARTER", label: "Fat quarter club" },
  { v: "FABRIC", label: "Fabric club" },
  { v: "BOM", label: "Block of the Month" },
  { v: "OTHER", label: "Other club" },
];

function ClubFields({ idp, init, series }: { idp: string; init: { name: string; kind: Kind; price: string; fulfil: "PICKUP" | "SHIP"; billDay: string; seriesId: string; note: string }; series: SeriesOption[] }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${idp}-name`}>
          Club name
        </label>
        <input id={`${idp}-name`} name="name" defaultValue={init.name} className="input" maxLength={80} required placeholder="Fat Quarter of the Month" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idp}-kind`}>
          Kind
        </label>
        <select id={`${idp}-kind`} name="kind" defaultValue={init.kind} className="input">
          {KINDS.map((k) => (
            <option key={k.v} value={k.v}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idp}-price`}>
          Monthly price ($)
        </label>
        <input id={`${idp}-price`} name="price" defaultValue={init.price} inputMode="decimal" className="input num w-28" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idp}-fulfil`}>
          New members: ship or pick up
        </label>
        <select id={`${idp}-fulfil`} name="fulfil" defaultValue={init.fulfil} className="input">
          <option value="PICKUP">Pick up in the shop</option>
          <option value="SHIP">Ship</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idp}-day`}>
          Bill day (1 to 28, blank: each member&apos;s sign-up day)
        </label>
        <input id={`${idp}-day`} name="billDay" defaultValue={init.billDay} inputMode="numeric" className="input num w-24" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idp}-series`}>
          Block of the Month series
        </label>
        <select id={`${idp}-series`} name="seriesId" defaultValue={init.seriesId} className="input">
          <option value="">(none)</option>
          {series.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field sm:col-span-2 lg:col-span-3">
        <label className="label" htmlFor={`${idp}-note`}>
          Note
        </label>
        <input id={`${idp}-note`} name="note" defaultValue={init.note} className="input" maxLength={500} />
      </div>
    </>
  );
}

export function NewClubForm({ series }: { series: SeriesOption[] }) {
  return (
    <ActionForm action={startClub} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <ClubFields idp="nc" init={{ name: "", kind: "FAT_QUARTER", price: "", fulfil: "PICKUP", billDay: "", seriesId: "", note: "" }} series={series} />
      <div className="sm:col-span-2 lg:col-span-3">
        <Submit>Start the club</Submit>
      </div>
    </ActionForm>
  );
}

export function ClubSettingsForm({ clubId, closed, init, series }: { clubId: string; closed: boolean; init: { name: string; kind: Kind; price: string; fulfil: "PICKUP" | "SHIP"; billDay: string; seriesId: string; note: string }; series: SeriesOption[] }) {
  return (
    <div className="space-y-3">
      <ActionForm action={saveClub.bind(null, clubId)} success="Saved" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <ClubFields idp="cs" init={init} series={series} />
        <div className="sm:col-span-2 lg:col-span-3">
          <Submit>Save</Submit>
        </div>
      </ActionForm>
      <ActionButton action={closeClub.bind(null, clubId, !closed)} className="btn btn-sm" confirm={closed ? undefined : "Tap again to close the club to new members"}>
        {closed ? "Open the club again" : "Close the club to new members"}
      </ActionButton>
    </div>
  );
}

export function AddMemberForm({ clubId, cardReady, cardWhy, defaultFulfil }: { clubId: string; cardReady: boolean; cardWhy: string | null; defaultFulfil: "PICKUP" | "SHIP" }) {
  return (
    <ActionForm action={addClubMember.bind(null, clubId)} reset className="grid gap-2 sm:grid-cols-2">
      <CustomerPicker initial={null} />
      <div className="field">
        <label className="label" htmlFor="am-fulfil">
          Ship or pick up
        </label>
        <select id="am-fulfil" name="fulfil" defaultValue={defaultFulfil} className="input">
          <option value="PICKUP">Pick up in the shop</option>
          <option value="SHIP">Ship</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="am-billing">
          Pays
        </label>
        <select id="am-billing" name="billing" defaultValue={cardReady ? "STRIPE" : "PAY_AT_PICKUP"} className="input">
          {cardReady && <option value="STRIPE">By card, every month (your Stripe)</option>}
          <option value="PAY_AT_PICKUP">At pickup (marked paid by hand)</option>
        </select>
        {!cardReady && cardWhy && <p className="muted text-xs">{cardWhy}</p>}
      </div>
      <div className="field sm:col-span-2">
        <label className="label" htmlFor="am-note">
          Note
        </label>
        <input id="am-note" name="note" className="input" maxLength={200} />
      </div>
      <div className="sm:col-span-2">
        <Submit>Add the member</Submit>
      </div>
    </ActionForm>
  );
}

/** "Send card link": the Stripe page for this member's card, shown once to hand over, text or copy. */
export function CardLinkButton({ clubId, memberId }: { clubId: string; memberId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await runAction(() => startCardLink(clubId, memberId));
            if (r?.error) toast.error(r.error);
            else if (r?.shown) setUrl(r.shown);
          })
        }
      >
        {pending ? "Making the link..." : "Card link"}
      </button>
      {url && (
        <span className="text-xs">
          <input readOnly value={url} aria-label="Card page address" className="input mono w-64" onFocus={(e) => e.currentTarget.select()} />
          <span className="muted block">Give this to the member (it expires in 24 hours). It is shown only here, now.</span>
        </span>
      )}
    </span>
  );
}

export function MemberControls({ clubId, m }: { clubId: string; m: { id: string; status: "ACTIVE" | "PAUSED" | "CANCELLED"; fulfil: "PICKUP" | "SHIP"; billing: "STRIPE" | "PAY_AT_PICKUP"; awaitingCard: boolean; note: string } }) {
  if (m.status === "CANCELLED") return <span className="muted text-xs">Cancelled. Add them again above to re-join.</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionForm action={saveClubMember.bind(null, clubId, m.id)} success="Saved" className="flex flex-wrap items-center gap-1">
        <label className="sr-only" htmlFor={`mf-${m.id}`}>
          Ship or pick up
        </label>
        <select id={`mf-${m.id}`} name="fulfil" defaultValue={m.fulfil} className="input">
          <option value="PICKUP">Pick up</option>
          <option value="SHIP">Ship</option>
        </select>
        <label className="sr-only" htmlFor={`mn-${m.id}`}>
          Note
        </label>
        <input id={`mn-${m.id}`} name="note" defaultValue={m.note} placeholder="Note" className="input w-40" maxLength={200} />
        <Submit className="btn btn-sm">Save</Submit>
      </ActionForm>
      {m.awaitingCard && m.status === "ACTIVE" && <CardLinkButton clubId={clubId} memberId={m.id} />}
      {m.status === "ACTIVE" ? (
        <ActionButton action={pauseMember.bind(null, clubId, m.id)} className="btn btn-sm">
          Pause
        </ActionButton>
      ) : (
        <ActionButton action={resumeMember.bind(null, clubId, m.id)} className="btn btn-sm">
          Resume
        </ActionButton>
      )}
      <ActionButton action={cancelMember.bind(null, clubId, m.id)} className="btn btn-sm" confirm="Tap again to cancel (stops card billing)">
        Cancel
      </ActionButton>
    </div>
  );
}

export function MonthForm({ clubId, month, what, kitId, kits }: { clubId: string; month: string; what: string; kitId: string; kits: { id: string; name: string; seriesMonth: number | null }[] }) {
  return (
    <ActionForm action={setClubMonth.bind(null, clubId, month)} success="Saved" className="flex flex-wrap items-end gap-2">
      <div className="field min-w-[14rem] flex-1">
        <label className="label" htmlFor="cm-what">
          What goes out this month
        </label>
        <input id="cm-what" name="what" defaultValue={what} className="input" maxLength={200} placeholder="Six fat quarters, Bali batiks, blues" />
      </div>
      {kits.length > 0 && (
        <div className="field">
          <label className="label" htmlFor="cm-kit">
            Or a kit from the series
          </label>
          <select id="cm-kit" name="kitId" defaultValue={kitId} className="input">
            <option value="">(none)</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.seriesMonth ? `Month ${k.seriesMonth}: ` : ""}
                {k.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <Submit className="btn btn-sm">Save</Submit>
    </ActionForm>
  );
}

export function PickControls({ clubId, month, r }: { clubId: string; month: string; r: { memberId: string; fulfil: "PICKUP" | "SHIP"; billing: "STRIPE" | "PAY_AT_PICKUP"; paid: boolean; doneAt: string | null } }) {
  // Pay at pickup: marked paid with how it was paid (it goes into the register's sales), or taken back (the sale is voided).
  const takeBack =
    r.billing === "PAY_AT_PICKUP" && r.paid ? (
      <ActionButton action={takeBackMemberPaid.bind(null, clubId, r.memberId, month)} className="btn btn-sm">
        Take back paid
      </ActionButton>
    ) : null;
  if (r.doneAt) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {takeBack}
        <ActionButton action={undoPick.bind(null, clubId, r.memberId, month)} className="btn btn-sm">
          Undo
        </ActionButton>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {r.billing === "PAY_AT_PICKUP" && !r.paid && (
        <ActionForm action={markMemberPaid.bind(null, clubId, r.memberId, month)} className="flex flex-wrap items-center gap-1">
          <select name="method" aria-label="Paid by" defaultValue="CASH" className="input w-24">
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="CHECK">Check</option>
            <option value="OTHER">Other</option>
          </select>
          <Submit className="btn btn-sm">Mark paid</Submit>
        </ActionForm>
      )}
      {takeBack}
      <ActionForm action={markPickDone.bind(null, clubId, r.memberId, month)} className="flex flex-wrap items-center gap-1">
        {r.fulfil === "SHIP" && <input name="tracking" aria-label="Tracking number" placeholder="Tracking" className="input w-36" maxLength={100} />}
        <Submit className="btn btn-sm btn-primary">{r.fulfil === "SHIP" ? "Shipped" : "Picked up"}</Submit>
      </ActionForm>
    </div>
  );
}
