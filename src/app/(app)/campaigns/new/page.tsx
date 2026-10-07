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
import { entryFor } from "@/lib/assistant/ui";
import { DraftFill, PostDraft } from "@/components/assistant/marketing-drafts";
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
  // Marketing drafts (shop-features-round-2-design.md 5.2): a new arrivals email and a social post, for a shop with a counter.
  const mk = shop.sellsRetail ? await entryFor(shopId, "marketing") : ({ show: false } as const);
  return (
    <div className="space-y-4">
      <PageHeader title="New campaign" back={{ href: "/campaigns", label: "Campaigns" }} />
      <MessagesTabs active="campaigns" />
      <MapWarnings shopId={shopId} />
      {mk.show && (
        <Section title="Let the Assistant start it">
          <div className="space-y-3">
            <p className="muted text-sm">Drafts an email about what came in lately, from your own stock (names, makers, colors and prices). It lands in the subject and message below for you to change; nothing is sent until you send it.</p>
            <DraftFill what={{ kind: "arrivals", subjectId: "cp-subject", bodyId: "cp-body" }} unavailable={mk.unavailable} />
            {!mk.unavailable && <PostDraft about="arrivals" />}
          </div>
        </Section>
      )}
      <Section title="The message">
        <CampaignForm action={saveCampaign.bind(null, null)} draft={null} classes={classes} shop={shop} partMills={ms.smsPartMills} />
      </Section>
    </div>
  );
}
