// Settings -> Messages -> Automatic messages: each automatic message's switch, its numbers, who gets it and whether it
// counts as marketing, and its wording with a live sample (scheduling-messaging-design.md section 5, 8.3).
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasModule } from "@/lib/modules";
import { gateFor } from "@/lib/module-gate";
import { validEmail } from "@/lib/phone";
import { messagingView } from "@/lib/messaging/settings";
import { FIELDS, SAMPLE_VARS, TEMPLATE_KEYS, templateFor } from "@/lib/messaging/templates";
import { PageHeader } from "@/components/ui";
import { ModuleOff } from "@/components/module-off";
import { MessagingTabs } from "@/components/messaging-tabs";
import { AutoMessagesForm } from "@/components/messaging-settings-forms";

export default async function AutoMessagesPage() {
  const user = await requireUser();
  const admin = user.role !== "TECH";
  const gate = await gateFor(user.shopId, "marketing");
  if (gate === "hidden") return <ModuleOff shopId={user.shopId} module="marketing" admin={admin} />;
  const canEdit = admin && gate === "on";
  const [ms, shop, vac] = await Promise.all([
    messagingView(user.shopId),
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true, address: true } }),
    hasModule(user.shopId, "vac"),
  ]);
  const templates: Record<string, string> = {};
  for (const key of TEMPLATE_KEYS) templates[key] = templateFor(ms, key);
  const postal = ms.postalAddress ?? shop.address ?? "(the shop's postal address)";
  const ownEmail = validEmail(user.email);
  const addresses = canEdit ? { emails: [...new Set([ownEmail, ms.fromEmail, ms.replyTo].filter((a): a is string => !!a))], phones: ms.testPhones } : { emails: [], phones: [] };

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Email and text messages" back={{ href: "/settings", label: "Settings" }} sub="What goes out by itself, and the words it uses. Texts start with the shop's name; marketing messages end with how to opt out." />
      <MessagingTabs active="auto" />
      {gate === "readonly" && <ModuleOff shopId={user.shopId} module="marketing" what="Your automatic messages" admin={admin} />}
      {!admin && <p className="muted text-sm">The shop owner or an admin changes these.</p>}
      <AutoMessagesForm
        v={{
          readyNotice: ms.readyNotice,
          reminders: ms.reminders,
          reminderHour: ms.reminderHour,
          abandonNotices: ms.abandonNotices,
          abandonDays: ms.abandonDays,
          finalNoticeDays: ms.finalNoticeDays,
          serviceDue: ms.serviceDue,
          serviceDueMonths: ms.serviceDueMonths,
          reviewRequest: ms.reviewRequest,
          reviewUrl: ms.reviewUrl,
          reviewDelayHours: ms.reviewDelayHours,
          reviewEveryDays: ms.reviewEveryDays,
          reviewAfterSales: ms.reviewAfterSales,
          estimateLinkDays: ms.estimateLinkDays,
        }}
        wording={{
          templates,
          fields: FIELDS,
          sample: { ...SAMPLE_VARS, shop_name: shop.name, shop_phone: shop.phone ?? SAMPLE_VARS.shop_phone },
          smsPrefix: `${shop.name}: `,
          noticeEmailFooter: `\n\n${shop.name}${shop.phone ? ` · ${shop.phone}` : ""}`,
          marketingEmailFooter: `\n\n--\nThis is an advertisement from ${shop.name}, ${postal}.\nTo stop getting these emails, reply with the word UNSUBSCRIBE (or use the link in the email).`,
          partMills: ms.smsPartMills,
          addresses,
        }}
        hasVac={vac}
        readOnly={!canEdit}
      />
    </div>
  );
}
