// Orders moved to Parts (Inventory) → Orders when they opened for every item (shop-features-round-2-design.md 1.1):
// an old link or bookmark lands on the same order there.
import { redirect } from "next/navigation";

export default async function OldOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/parts/orders/${encodeURIComponent(id)}`);
}
