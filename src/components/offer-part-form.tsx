"use client";

// "Offer this part" (HANDOFF item 9): one form where the shop picks where the part goes, to its partner sewing shops at
// the partner price, on the community marketplace as a listing, or both. Nothing is sent unless a box is ticked.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { offerPart } from "@/actions/market";
import { ListingFields, shrinkListingPhotos, useListingClientId, type ListingDefaults } from "@/components/listing-form";

const d2 = (c?: number | null) => (c == null ? "" : (c / 100).toFixed(2));

export function OfferPartForm({
  partId,
  listing,
  wholesaleCents,
  mayOfferToPartners,
  hubJoined,
}: {
  partId: string;
  listing: ListingDefaults;
  /** The partner price saved on the part, if any (the form starts with it). */
  wholesaleCents: number | null;
  /** Owner or admin: a tech can't set what partner shops pay. */
  mayOfferToPartners: boolean;
  /** The marketplace lives on the hub: without a hub, that choice is shown but can't be ticked. */
  hubJoined: boolean;
}) {
  const [partners, setPartners] = useState(false);
  const [market, setMarket] = useState(false);
  const [pending, start] = useTransition();
  const clientId = useListingClientId();
  const router = useRouter();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("clientId", clientId());
    start(async () => {
      try {
        if (market) await shrinkListingPhotos(fd);
        const r = await offerPart(partId, fd);
        if (r?.error) {
          toast.error(r.error);
          return;
        }
        toast.success(partners && market ? "Offered to partner shops and listed on the marketplace" : partners ? "Offered to partner shops" : "Listed on the marketplace");
        form.reset();
        setPartners(false);
        setMarket(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't offer it.");
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="label">Where to offer it</legend>
        <label className={`flex items-start gap-2 text-sm ${mayOfferToPartners ? "" : "muted"}`}>
          <input type="checkbox" name="partners" className="check mt-0.5" checked={partners} onChange={(e) => setPartners(e.target.checked)} disabled={!mayOfferToPartners} />
          <span>
            To my partner shops, in their catalog at the partner price
            {!mayOfferToPartners && <span className="muted"> (an owner or admin sets what partners pay)</span>}
          </span>
        </label>
        {partners && (
          <div className="field ml-6 max-w-xs">
            <label htmlFor="offer-wholesale" className="label">
              Partner price ($ each)
            </label>
            <input id="offer-wholesale" name="wholesale" inputMode="decimal" required defaultValue={d2(wholesaleCents)} className="input num" />
          </div>
        )}
        <label className={`flex items-start gap-2 text-sm ${hubJoined ? "" : "muted"}`}>
          <input type="checkbox" name="market" className="check mt-0.5" checked={market} onChange={(e) => setMarket(e.target.checked)} disabled={!hubJoined} />
          <span>
            On the community marketplace, for any shop on the hub to buy
            {!hubJoined && <span className="muted"> (join StitchHub in Settings first)</span>}
          </span>
        </label>
      </fieldset>
      {market && (
        <div className="ml-6">
          <ListingFields defaults={listing} id="offer" />
        </div>
      )}
      <button className="btn btn-primary" disabled={pending || (!partners && !market)}>
        {pending ? "Offering..." : "Offer it"}
      </button>
    </form>
  );
}
