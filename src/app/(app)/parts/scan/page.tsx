import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { OPEN_STATUSES } from "@/lib/constants";
import { ticketNo } from "@/lib/format";
import { PageHeader } from "@/components/ui";
import { ScanStation } from "@/components/scan-station";

export default async function ScanParts() {
  const user = await requireUser();
  const tickets = await db.ticket.findMany({
    where: { shopId: user.shopId, status: { in: OPEN_STATUSES } },
    include: { machine: { select: { brand: true, model: true } }, customer: { select: { name: true } } },
    orderBy: { number: "desc" },
    take: 100,
  });
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        back={{ href: "/parts", label: "Parts" }}
        title="Scan parts"
        sub="Use a USB or Bluetooth barcode scanner (it types into the box), or a phone or tablet camera. Print barcode labels from the Parts list."
      />
      <ScanStation
        shopId={user.shopId}
        tickets={tickets.map((t) => ({
          id: t.id,
          label: `#${ticketNo(t.number)} ${t.machine.brand} ${t.machine.model}${t.customer ? ` · ${t.customer.name}` : ""}`,
        }))}
      />
    </div>
  );
}
