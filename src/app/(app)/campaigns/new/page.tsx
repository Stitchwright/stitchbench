// A new campaign draft (scheduling-messaging-design.md 11.3). Admins with Marketing on.
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { gateFor } from "@/lib/module-gate";
import { messagingView } from "@/lib/messaging/settings";
import { saveCampaign } from "@/actions/campaigns";
import { CampaignForm } from "@/components/campaign-form";
import { MessagesTabs } from "@/components/messages-tabs";
import { ModuleOff } from "@/components/module-off";
import { PageHeader, Section } from "@/components/ui";
import { MapWarnings } from "@/components/map-price";

export default async function NewCampaignPage() {
  const user = await requireAdmin();
  const shopId = user.shopId;
  const gate = await gateFor(shopId, "marketing");
  if (gate !== "on") return <ModuleOff shopId={shopId} module="marketing" admin />;
  const [shop, ms, classes] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true, sellsRetail: true, doesRepair: true } }),
    messagingView(shopId),
    db.shopClass.findMany({ where: { shopId, status: { in: ["OPEN", "CLOSED"] } }, select: { id: true, title: true }, orderBy: { firstAt: "desc" }, take: 100 }),
  ]);
  return (
    <div className="space-y-4">
      <PageHeader title="New campaign" back={{ href: "/campaigns", label: "Campaigns" }} />
      <MessagesTabs active="campaigns" />
      <MapWarnings shopId={shopId} />
      <Section title="The message">
        <CampaignForm action={saveCampaign.bind(null, null)} draft={null} classes={classes} shop={shop} partMills={ms.smsPartMills} />
      </Section>
    </div>
  );
}
