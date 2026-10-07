// Want lists across the shop (shop-features-round-2-design.md 1.4): what came in that a customer is waiting for ("Here
// now", with Let her know), then everything being watched. Lines are added on a customer's page.
import Link from "next/link";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { wantsFor } from "@/lib/want-lists";
import { WantLines } from "@/components/want-lines";
import { Empty, PageHeader } from "@/components/ui";

export default async function WantLists({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requireUser();
  const { all } = await searchParams;
  const [rows, tz] = await Promise.all([wantsFor(user.shopId, { hereOnly: !all }), shopTimeZone(user.shopId)]);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Want lists"
        sub={all ? "Everything customers asked to hear about." : "What came in that a customer is waiting for. Add to a want list on the customer's page."}
        back={{ href: "/special-orders", label: "Special orders" }}
        actions={
          <Link href={all ? "/want-lists" : "/want-lists?all=1"} className="btn min-h-11">
            {all ? "Here now only" : "Show everything watched"}
          </Link>
        }
      />
      {rows.length === 0 ? (
        <Empty>{all ? "No want lists yet. On a customer's page, use Add to her want list (call me when the next Tula Pink line lands)." : "Nothing on a want list has come in yet."}</Empty>
      ) : (
        <div className="card card-pad">
          <WantLines rows={rows} tz={tz} showCustomer />
        </div>
      )}
    </div>
  );
}
