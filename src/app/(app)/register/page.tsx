import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { Register } from "@/components/register";
import { PartnerTodo } from "@/components/partner-todo";

export default async function RegisterPage() {
  const user = await requireUser();
  const [shop, partners] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { sellsRetail: true, taxRatePct: true } }),
    db.partnerLink.count({ where: { shopId: user.shopId, side: "retail" } }),
  ]);
  if (!shop.sellsRetail) {
    return (
      <div className="space-y-4">
        <PageHeader title="Register" />
        <p className="card card-pad text-sm">
          The register is for selling over the counter (notions, fabric, accessories). Turn it on in{" "}
          <Link href="/settings#company" className="link">
            Settings
          </Link>{" "}
          under &quot;What this company does&quot;.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title="Register"
        actions={
          <>
            <Link href="/register/sales" className="btn">
              Sales
            </Link>
            <Link href="/parts" className="btn">
              Inventory
            </Link>
          </>
        }
      />
      <PartnerTodo shopId={user.shopId} />
      <Register taxRatePct={shop.taxRatePct} hasPartners={partners > 0} canSell={user.role !== "TECH"} />
    </div>
  );
}
