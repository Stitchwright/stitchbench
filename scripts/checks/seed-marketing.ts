// Seeds one SENT marketing email (kind "campaign") for a company so the unsubscribe page can be tried by hand or by
// tests/notices.spec.ts (scheduling-messaging-design.md 15.2 acceptance 4). Prints the unsubscribe token on its last line.
// Nothing is sent: the row is written as already sent, with the unsubscribe wording a real campaign email carries.
//   npx tsx --conditions=react-server scripts/checks/seed-marketing.ts --shop "<company name or id>" --email <address> [--name "<customer>"]
// With PUBLIC_URL set the token also prints as a link.
import "dotenv/config";
import { db } from "@/lib/db";
import { finalize, unsubscribeParts } from "@/lib/messaging/queue";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const shopArg = arg("shop");
  const email = arg("email")?.trim().toLowerCase() ?? null;
  if (!shopArg || !email) {
    console.error('usage: seed-marketing.ts --shop "<company name or id>" --email <address> [--name "<customer>"]');
    process.exit(2);
  }
  const shop = await db.shop.findFirst({ where: { OR: [{ id: shopArg }, { name: shopArg }] }, select: { id: true, name: true, phone: true } });
  if (!shop) throw new Error(`No company "${shopArg}".`);

  // Marketing email must show the shop's postal address: give it one if it has none yet.
  const ms = await db.messagingSettings.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id, postalAddress: "1 Main St, Springfield" }, update: {}, select: { postalAddress: true, replyTo: true, fromEmail: true } });
  const postal = ms.postalAddress || (await db.messagingSettings.update({ where: { shopId: shop.id }, data: { postalAddress: "1 Main St, Springfield" }, select: { postalAddress: true } })).postalAddress!;

  const customer =
    (await db.customer.findFirst({ where: { shopId: shop.id, email }, select: { id: true, name: true } })) ??
    (await db.customer.create({ data: { shopId: shop.id, name: arg("name") ?? "Seeded Reader", email, notifyBy: "email" }, select: { id: true, name: true } }));

  const unsub = unsubscribeParts(shop.id, ms.replyTo ?? ms.fromEmail ?? "");
  const body = finalize("email", "campaign", `Hi ${customer.name.split(/[\s,]+/)[0]},\n\nSpring tune-up special: $20 off a full service this month. Bring this email in.`, {
    shopName: shop.name,
    shopPhone: shop.phone,
    postal,
    unsubscribeUrl: unsub.url,
    replyWord: true,
  });
  const now = new Date();
  const row = await db.outMessage.create({
    data: {
      shopId: shop.id,
      channel: "email",
      purpose: "marketing",
      kind: "campaign",
      customerId: customer.id,
      address: email,
      subject: `${shop.name}: spring tune-up special`,
      body,
      status: "SENT",
      sendAfter: now,
      sentAt: now,
      tries: 1,
      optOutToken: unsub.token,
      providerId: `<seed-${unsub.token}@stitchbench.test>`,
    },
    select: { id: true },
  });
  console.log(`seeded marketing email ${row.id} to ${email} for "${shop.name}" (customer ${customer.id})`);
  if (unsub.url) console.log(`link: ${unsub.url}`);
  console.log(`token=${unsub.token}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
