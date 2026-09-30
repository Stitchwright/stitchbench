import Link from "next/link";
import { money } from "@/lib/format";
import { ORIGIN_NAME } from "@/lib/part-labels";

export const CONDITION_LABEL: Record<string, string> = { NEW: "New", USED: "Used", REFURB: "Refurbished" };

/** Who made a listed item ("Compatible"); null when the seller's install didn't say. */
export const originName = (origin: string | null | undefined) => (origin ? ((ORIGIN_NAME as Record<string, string>)[origin] ?? null) : null);

export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  REQUESTED: { label: "Waiting for the seller", tone: "tone-wait" },
  ACCEPTED: { label: "Invoiced, awaiting payment", tone: "tone-work" },
  PAID: { label: "Paid, to ship", tone: "tone-work" },
  SHIPPED: { label: "Shipped", tone: "tone-ready" },
  RECEIVED: { label: "Received", tone: "tone-done" },
  DECLINED: { label: "Declined", tone: "tone-bad" },
  CANCELLED: { label: "Cancelled", tone: "tone-bad" },
};

/** "★ 4.8 (12)" or "No ratings yet". */
export function Stars({ avg, count, what = "rating" }: { avg: number | null | undefined; count: number; what?: string }) {
  if (!count || avg == null) return <span className="muted text-xs">No {what}s yet</span>;
  return (
    <span className="text-xs whitespace-nowrap" title={`${avg.toFixed(1)} out of 5 from ${count} ${what}${count === 1 ? "" : "s"}`}>
      <span className="text-[var(--wait)]" aria-hidden>
        ★
      </span>{" "}
      <span className="num font-semibold">{avg.toFixed(1)}</span> <span className="muted">({count})</span>
    </span>
  );
}

export function OrderStatus({ status }: { status: string }) {
  const s = ORDER_STATUS[status] ?? { label: status, tone: "tone-neutral" };
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

type L = {
  id: string;
  title: string;
  shopName: string;
  priceCents: number;
  qty: number;
  condition: string;
  origin?: string | null;
  brand: string | null;
  partNumber: string | null;
  shippingCents: number | null;
  status: string;
  photoIds: string[];
  mine: boolean;
  sellerAvg?: number | null;
  sellerCount?: number;
};

export function ListingCard({ l }: { l: L }) {
  return (
    <Link href={`/market/${l.id}`} className="card block overflow-hidden hover:border-[var(--navy)]">
      {l.photoIds[0] ? (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated image route
        <img src={`/api/listing-photos/${l.photoIds[0]}`} alt="" className="aspect-[4/3] w-full bg-white object-contain" loading="lazy" />
      ) : (
        <div className="aspect-[4/3] w-full bg-surface-2" aria-hidden />
      )}
      <div className="space-y-1 p-3 text-sm">
        <div className="font-semibold">{l.title}</div>
        <div className="muted text-xs">
          {[l.brand, l.partNumber, CONDITION_LABEL[l.condition] ?? l.condition].filter(Boolean).join(" · ")}
          {(l.origin === "COMPATIBLE" || l.origin === "PRINTED") && <span className="pill tone-wait ml-2">{originName(l.origin)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="num font-semibold">{money(l.priceCents)}</span>
          <span className="muted text-xs">
            {l.qty} available{l.shippingCents != null ? ` · ship ${money(l.shippingCents)}` : ""}
          </span>
        </div>
        <div className="muted flex flex-wrap items-center gap-2 text-xs">
          {l.mine ? "Your listing" : l.shopName}
          {!l.mine && <Stars avg={l.sellerAvg} count={l.sellerCount ?? 0} />}
          {l.status !== "ACTIVE" && <span className="pill tone-neutral ml-2">{l.status.toLowerCase().replace("_", " ")}</span>}
        </div>
      </div>
    </Link>
  );
}

export function MarketNav({ current }: { current: "browse" | "mine" | "orders" }) {
  const tabs = [
    { key: "browse", href: "/market", label: "Browse" },
    { key: "mine", href: "/market/mine", label: "My listings" },
    { key: "orders", href: "/market/orders", label: "Orders" },
  ] as const;
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Marketplace">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={`btn btn-sm ${current === t.key ? "btn-primary" : ""}`} aria-current={current === t.key ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
