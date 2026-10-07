// Maker Shop home (shop-features-round-2-design.md section 6): 3D printers first (the owner likes them most), then cutters
// and lasers: what is for sale, the supplies on the shelf, and the module's own work as cards with their counts.
// Selling the machines and supplies is in the base; this module adds the lists below.
import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { suppliesDueCount } from "@/lib/supplies-due";
import { MakerFrame, makerPageState } from "@/components/maker/maker-page";

const SUPPLY_TYPES = ["filament", "resin", "blade", "mat", "vinyl", "laser-material", "die"];

export default async function MakerHome() {
  const user = await requireUser();
  const s = await makerPageState(user);
  const shopId = user.shopId;
  const [printers, cutters, supplies, due] = await Promise.all([
    db.stockUnit.count({ where: { shopId, status: "IN_STOCK", machine: { kind: { in: ["3d-printer", "resin-printer"] } } } }),
    db.stockUnit.count({ where: { shopId, status: "IN_STOCK", machine: { kind: { in: ["craft-cutter", "die-cutter", "laser-cutter"] } } } }),
    db.part.count({ where: { shopId, itemType: { in: SUPPLY_TYPES }, qtyOnHand: { gt: 0 } } }),
    s.gate === "none" ? Promise.resolve(0) : suppliesDueCount(shopId),
  ]);
  const cards: { href: string; title: string; text: string; count: string }[] = [
    { href: "/units?kind=3d-printer#add", title: "3D printers for sale", text: "Filament and resin printers with serials, warranties, owner's classes and starter bundles.", count: `${printers} in stock` },
    { href: "/units?kind=craft-cutter#add", title: "Cutters and lasers for sale", text: "Craft cutters, fabric die cutters and laser cutters.", count: `${cutters} in stock` },
    { href: "/parts?kind=SUPPLY", title: "Supplies", text: "Filament, resin, blades, mats, vinyl, laser stock and dies, each with its own details and colors.", count: `${supplies} on the shelf` },
    { href: "/maker/space", title: "Maker-space time", text: "Customers certified on your laser or printer book it by the hour.", count: "" },
    { href: "/maker/supplies", title: "Supplies due", text: "Printer and cutter owners probably running low, to call or remind.", count: `${due} due` },
  ];
  return (
    <MakerFrame title="Maker Shop" tab="home" sub="3D printers, cutters and lasers: selling them and their supplies, and the work around them." {...s}>
      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="card card-pad block hover:bg-surface-2">
            <div className="text-base font-semibold">{c.title}</div>
            <div className="muted text-sm">{c.text}</div>
            {c.count && <div className="mt-2 text-base">{c.count}</div>}
          </Link>
        ))}
      </div>
    </MakerFrame>
  );
}
