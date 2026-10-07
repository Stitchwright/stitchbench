// "12 items are under your margin floor" (shop-features-round-2-design.md 4.4), on Inventory and the dashboard, with
// Raise prices pre-filled. Nothing when the floor is off or every item is above it. A server component.
import Link from "next/link";
import { underFloorCount } from "@/lib/repricing";

export async function MarginFloorNotice({ shopId }: { shopId: string }) {
  const n = await underFloorCount(shopId);
  if (!n) return null;
  return (
    <p className="card card-pad flex flex-wrap items-center justify-between gap-3 text-base" role="status">
      <span>
        {n} item{n === 1 ? " is" : "s are"} under your margin floor (the cost went up, or the price is low).
      </span>
      <Link href="/parts/raise-prices?who=floor" className="btn min-h-11 text-base">
        Raise prices
      </Link>
    </p>
  );
}
