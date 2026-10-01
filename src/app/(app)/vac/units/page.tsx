// Vacuums for sale. Foundation stub (owner: vac-sales-warranty).
import { requireUser } from "@/lib/session";
import { Empty } from "@/components/ui";
import { VacFrame, vacPageState } from "@/components/vac/vac-page";
import { listUnits } from "@/lib/vac/units";

export default async function VacUnits() {
  const user = await requireUser();
  const units = await listUnits(user.shopId, null, null);
  const s = await vacPageState(user, units.length > 0);
  return (
    <VacFrame title="Vacuums for sale" tab="units" what="Your vacuums for sale" needsRegister {...s}>
      <Empty>Coming in this update.</Empty>
    </VacFrame>
  );
}
