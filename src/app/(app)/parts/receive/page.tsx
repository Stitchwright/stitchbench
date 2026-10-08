// "Receive without an order" (shop-features-round-2-design.md 1.10): a picture of a packing slip or invoice for a box
// that came without one of your orders; the lines are matched to your items by number (new ones made with one tap).
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { entryFor } from "@/lib/assistant/ui";
import { SlipReader } from "@/components/slip-reader";
import { PageHeader } from "@/components/ui";

export default async function ReceiveFromSlip() {
  const user = await requireUser();
  const slip = await entryFor(user.shopId, "stock");
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Receive from a packing slip" sub="A box that came without one of your orders. For an order, open it under Orders to suppliers instead." back={{ href: "/parts", label: "Inventory" }} />
      {slip.show ? (
        <div className="card card-pad">
          <SlipReader orderId={null} unavailable={slip.unavailable} canCost={user.role !== "TECH"} />
        </div>
      ) : (
        <p className="card card-pad text-base">
          Reading a packing slip needs the Assistant with its Stock helpers on (
          <Link href="/settings/assistant" className="link">
            Settings, Assistant
          </Link>
          ). Without it, receive each item on its page.
        </p>
      )}
    </div>
  );
}
