// "What you repair": the kinds a shop checks in and its own kinds. Foundation stub (owner: appliance-repair). The page
// is shown when vac or appliance is not off; otherwise the appliance module's notice.
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { pageGate } from "@/lib/module-info";
import { getModules } from "@/lib/modules";
import { ModuleNotice } from "@/components/module-notice";
import { Empty, PageHeader } from "@/components/ui";

export default async function EquipmentSettings() {
  const user = await requireUser();
  const [mods, shop] = await Promise.all([getModules(user.shopId), db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { id: true, name: true } })]);
  const admin = user.role !== "TECH";
  const shown = pageGate(mods.states.vac) !== "none" || pageGate(mods.states.appliance) !== "none";
  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="What you repair" sub="The kinds of things you check in, and what each one asks for." back={{ href: "/settings", label: "Settings" }} />
      {shown ? <Empty>Coming in this update.</Empty> : <ModuleNotice state={mods.states.appliance} admin={admin} shop={shop} />}
    </div>
  );
}
