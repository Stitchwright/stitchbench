// Campaigns end to end without a browser (scheduling-messaging-design.md 15.4 acceptance 3): 1 200 members build in 3
// runs of at most 500; a shared address gets one row (same_address counted); the sweep turns a campaign SENT when its
// last rows were SKIPPED; an 8-day campaign is refused; the fourth campaign on one shop-day is refused; cancelCampaign
// cancels its queued rows; the import adds, matches and unsubscribes without ever recording text consent.
//   npm run check scripts/checks/campaigns.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";
import { buildCampaign, buildCampaigns } from "@/lib/messaging/campaign-build";
import { cancelCampaignAs, copyCampaignAs, deleteCampaignAs, importCustomersAs, queueCampaignAs, saveCampaignAs, sendCampaignTestAs } from "@/lib/messaging/campaigns";
import { previewCampaign } from "@/lib/messaging/audiences";
import { messageRun } from "@/lib/messaging/worker";
import { checkShop, cleanup, clearKick, messagingFor, withSink, type CheckShop, type SinkHandle } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const user = (s: CheckShop): CurrentUser => s.user;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const emailDraft = (name: string, body = "Hi {first_name}, our spring tune-up special is on: $20 off a full service this month.") =>
  fd({ name, channel: "email", subject: "Spring tune-up special", body, audience: "all" });

async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

async function run(shopId: string, now = new Date()) {
  clearKick();
  for (let i = 0; i < 120; i++) {
    const r = await messageRun({ now, shopIds: [shopId] });
    if ("busy" in r) {
      await new Promise((res) => setTimeout(res, 300));
      continue;
    }
    return r;
  }
  throw new Error("messageRun stayed busy");
}

async function customers(shopId: string, count: number, o: { prefix?: string; email?: (i: number) => string } = {}) {
  const prefix = o.prefix ?? uniq();
  await db.customer.createMany({ data: Array.from({ length: count }, (_, i) => ({ shopId, name: `${prefix} ${i}`, kind: "RETAIL" as const, email: o.email ? o.email(i) : `${prefix}-${i}@a.test`, notifyBy: "email" })) });
}

async function main() {
  const t0 = Date.now();
  let sink: SinkHandle;
  // The hosted rules (a public address): marketing emails carry the one-click unsubscribe link and header.
  const prior = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "http://127.0.0.1:39997";
  try {
    sink = await withSink();

    // ---- 1 200 members build in 3 runs of at most 500; a couple sharing an inbox get one message.
    const big = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
    await messagingFor(big.shopId, { email: true, settings: { emailDailyCap: 5000 } });
    await customers(big.shopId, 1198);
    const shared = `shared-${uniq()}@a.test`;
    await customers(big.shopId, 2, { prefix: "Couple", email: () => shared });
    const id = await saveCampaignAs(user(big), null, emailDraft("Big one"));
    const draft = await db.campaign.findUniqueOrThrow({ where: { id } });
    assert.equal(draft.status, "DRAFT");
    const pv = await previewCampaign(big.shopId, draft, new Date());
    assert.equal(pv.members, 1200);
    assert.equal(pv.allowed, 1199, `1 200 people, one shared address: ${JSON.stringify(pv.skipped)}`);
    assert.equal(pv.skipped.same_address, 1);
    assert.equal(pv.days, 1);
    await expectError("wrong confirm", () => queueCampaignAs(user(big), id, fd({ confirm: "5" })), /^The list changed: it's now 1199 people\. Check and tap again\.$/);
    await queueCampaignAs(user(big), id, fd({ confirm: "1199" }));
    clearKick();
    let c = await db.campaign.findUniqueOrThrow({ where: { id } });
    assert.equal(c.status, "QUEUING");
    assert.equal((c.members as unknown[]).length, 1200);
    await expectError("queued twice", () => queueCampaignAs(user(big), id, fd({ confirm: "1199" })), /already gone out/);
    for (const [i, [builtAfter, insertedNow]] of ([[500, 499], [1000, 500], [1200, 200]] as const).entries()) {
      clearKick();
      const r = await buildCampaign(await db.campaign.findUniqueOrThrow({ where: { id } }), new Date());
      clearKick();
      assert.equal(r.inserted, insertedNow, `run ${i + 1} inserted (built ${r.built}, done ${r.done})`);
      c = await db.campaign.findUniqueOrThrow({ where: { id } });
      assert.equal(c.built, builtAfter, `run ${i + 1}`);
      assert.equal(c.status, builtAfter === 1200 ? "SENDING" : "QUEUING");
    }
    assert.equal(c.recipients, 1199, `recipients; skipped ${JSON.stringify(c.skipped)}`);
    assert.deepEqual(c.skipped, { same_address: 1 });
    assert.equal((c.skipped as Record<string, number>).same_address, 1);
    assert.equal(await db.outMessage.count({ where: { shopId: big.shopId, campaignId: id } }), 1199);
    const one = await db.outMessage.findFirstOrThrow({ where: { shopId: big.shopId, campaignId: id } });
    assert.equal(one.purpose, "marketing");
    assert.equal(one.kind, "campaign");
    assert.ok(one.optOutToken && /^[A-Za-z0-9_-]{22}$/.test(one.optOutToken), "an unsubscribe token per row");
    assert.match(one.body, /This is an advertisement from Check .*, 1 Main St, Springfield\./);
    assert.match(one.body, /UNSUBSCRIBE/);
    assert.ok(!one.body.includes("{first_name}") && /^Hi \S+/.test(one.body), one.body.slice(0, 60));
    await buildCampaigns(new Date(), [big.shopId]); // nothing more to do
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id } })).recipients, 1199);
    ok("1 200 members: 3 runs of 500, 500, 200; the shared address gets one row (same_address 1); the rows are marketing campaign emails with tokens, the footer and the merge done");

    // ---- cancel: the campaign and its queued rows
    clearKick();
    await cancelCampaignAs(user(big), id);
    c = await db.campaign.findUniqueOrThrow({ where: { id } });
    assert.equal(c.status, "CANCELLED");
    assert.equal(await db.outMessage.count({ where: { shopId: big.shopId, campaignId: id, status: "QUEUED" } }), 0);
    const dist = await db.outMessage.groupBy({ by: ["status", "error"], where: { shopId: big.shopId, campaignId: id }, _count: { _all: true } });
    assert.equal(await db.outMessage.count({ where: { shopId: big.shopId, campaignId: id, status: "CANCELLED", error: "Campaign cancelled" } }), 1199, JSON.stringify(dist));
    await expectError("cancel twice", () => cancelCampaignAs(user(big), id), /Only a campaign that is going out/);
    ok("cancelCampaign: CANCELLED, and every queued row with it");

    // ---- a small shop: sent through the worker; the sweep finishes it even when the last rows were skipped
    const a = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
    await messagingFor(a.shopId, { email: true });
    await customers(a.shopId, 3, { prefix: "Small" });
    const unsub = await db.customer.create({ data: { shopId: a.shopId, name: "Unsubscribed", kind: "RETAIL", email: `unsub-${uniq()}@a.test`, notifyBy: "email" } });
    await db.suppression.create({ data: { shopId: a.shopId, channel: "email", address: unsub.email!, scope: "marketing", source: "staff" } });
    const small = await saveCampaignAs(user(a), null, emailDraft("Small"));
    const spv = await previewCampaign(a.shopId, await db.campaign.findUniqueOrThrow({ where: { id: small } }), new Date());
    assert.equal(spv.allowed, 3);
    assert.equal(spv.skipped.unsubscribed, 1);
    assert.ok(spv.sample.subject === "Spring tune-up special" && spv.sample.body.startsWith("Hi Mary,"), "the sample uses the sample names");
    await queueCampaignAs(user(a), small, fd({ confirm: "3" }));
    clearKick();
    await buildCampaigns(new Date(), [a.shopId]);
    // One recipient unsubscribes after the rows were queued: the worker skips that row at send time.
    const late = await db.outMessage.findFirstOrThrow({ where: { shopId: a.shopId, campaignId: small }, orderBy: { address: "asc" } });
    await db.suppression.create({ data: { shopId: a.shopId, channel: "email", address: late.address, scope: "marketing", source: "unsubscribe_link" } });
    const before = sink.messages.length;
    await run(a.shopId);
    await run(a.shopId); // the sweep runs after the sends of the same run; a second pass is sure to see them all gone
    const sc = await db.campaign.findUniqueOrThrow({ where: { id: small } });
    assert.equal(sc.status, "SENT", `status ${sc.status}`);
    assert.ok(sc.finishedAt);
    const statuses = (await db.outMessage.findMany({ where: { shopId: a.shopId, campaignId: small }, select: { status: true } })).map((r) => r.status).sort();
    assert.deepEqual(statuses, ["SENT", "SENT", "SKIPPED"]);
    assert.equal(sink.messages.length - before, 2, "two emails reached the sink");
    const raw = sink.messages[sink.messages.length - 1].raw;
    assert.match(raw, /List-Unsubscribe:/i);
    assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    ok("a 4-person campaign: 3 queued, 1 unsubscribed before; 1 skipped at send time; 2 sent with List-Unsubscribe headers; the sweep marks it SENT");

    // ---- copy and delete
    const copyId = await copyCampaignAs(user(a), small);
    const copy = await db.campaign.findUniqueOrThrow({ where: { id: copyId } });
    assert.equal(copy.status, "DRAFT");
    assert.equal(copy.name, "Small (copy)");
    assert.equal(copy.body, sc.body);
    await expectError("delete a sent one", () => deleteCampaignAs(user(a), small), /^Only drafts can be deleted\./);
    await deleteCampaignAs(user(a), copyId);
    assert.equal(await db.campaign.count({ where: { id: copyId } }), 0);
    ok("copy makes a draft with the same wording; only drafts can be deleted");

    // ---- the limits: a week at the cap, the fourth campaign in a day, the postal address, a test to someone else
    const capped = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
    await messagingFor(capped.shopId, { email: true, settings: { emailDailyCap: 10 } });
    await customers(capped.shopId, 80);
    const week = await saveCampaignAs(user(capped), null, emailDraft("Too big"));
    await expectError("8 days", () => queueCampaignAs(user(capped), week, fd({ confirm: "80" })), /^That would take more than a week at your limit of 10 a day\./);
    await db.messagingSettings.update({ where: { shopId: capped.shopId }, data: { emailDailyCap: 300 } });
    for (let i = 0; i < 3; i++) {
      const cid = await saveCampaignAs(user(capped), null, emailDraft(`Day ${i}`));
      await queueCampaignAs(user(capped), cid, fd({ confirm: "80" }));
      clearKick();
    }
    const fourth = await saveCampaignAs(user(capped), null, emailDraft("Fourth"));
    await expectError("fourth today", () => queueCampaignAs(user(capped), fourth, fd({ confirm: "80" })), /^You've sent 3 campaigns today\. Try again tomorrow\.$/);
    await db.messagingSettings.update({ where: { shopId: capped.shopId }, data: { postalAddress: null } });
    await db.shop.update({ where: { id: capped.shopId }, data: { address: null } });
    await expectError("no postal address", () => queueCampaignAs(user(capped), fourth, fd({ confirm: "80" })), /^Add the shop's postal address in Settings -> Messages\./);
    await expectError("test to a stranger", () => sendCampaignTestAs(user(capped), fourth, fd({ to: "stranger@a.test" })), /only to your own login address/);
    ok("refused: more than a week at the cap; the fourth campaign of the day; no postal address; a test to an address that isn't the admin's");

    // ---- the draft's rules
    await expectError("RE: subject", () => saveCampaignAs(user(a), null, fd({ name: "x", channel: "email", subject: "RE: your order", body: "hi", audience: "all" })), /^Don't start the subject with RE: or FW:/);
    await expectError("unknown field", () => saveCampaignAs(user(a), null, fd({ name: "x", channel: "email", subject: "s", body: "hi {total}", audience: "all" })), /Unknown field \{total\}/);
    await expectError("no audience", () => saveCampaignAs(user(a), null, fd({ name: "x", channel: "email", subject: "s", body: "hi", audience: "" })), /^Pick who gets it\.$/);
    // 480 characters is the most a text may be (plainText() turns accents and smart quotes into plain ones, so 4 parts always hold it).
    await expectError("481 characters", () => saveCampaignAs(user(a), null, fd({ name: "x", channel: "sms", body: "x".repeat(481), audience: "all" })), /up to 480 characters/);
    const longest = await saveCampaignAs(user(a), null, fd({ name: "Longest", channel: "sms", body: "word ".repeat(96).trim(), audience: "all" }));
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: longest } })).body.length, 479);
    const sms = await saveCampaignAs(user(a), null, fd({ name: "Text one", channel: "sms", body: "Spring special: $20 off a service this month.", audience: "all" }));
    const smsDraft = await db.campaign.findUniqueOrThrow({ where: { id: sms } });
    assert.equal(smsDraft.channel, "sms");
    await saveCampaignAs(user(a), sms, fd({ name: "Text one", channel: "email", subject: "x", body: "Changed.", audience: "all" }));
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: sms } })).channel, "sms", "the channel is fixed after the first save");
    const nobody = await previewCampaign(a.shopId, await db.campaign.findUniqueOrThrow({ where: { id: sms } }), new Date());
    assert.equal(nobody.allowed, 0, "no one agreed to texts");
    assert.ok(nobody.parts && nobody.parts >= 1);
    ok("drafts: RE: subjects, unknown fields, no audience and 5-part texts are refused; the channel can't change after the first save; a text to people without consent reaches nobody");

    // ---- import
    const existing = await db.customer.create({ data: { shopId: a.shopId, name: "Pat Phone", kind: "RETAIL", phone: "+12125550199", notifyBy: "" } });
    const r = await importCustomersAs(user(a), [
      { name: "New Person", email: `new-${uniq()}@a.test`, phone: "(212) 555-0188" },
      { name: "Pat P.", email: `pat-${uniq()}@a.test`, phone: "212-555-0199" },
      { name: "Gone Person", email: `gone-${uniq()}@a.test`, unsubscribed: "yes" },
      { name: "", email: "nobody@a.test" },
    ]);
    assert.deepEqual({ added: r.added, matched: r.matched, unsubscribed: r.unsubscribed }, { added: 2, matched: 1, unsubscribed: 1 });
    assert.deepEqual(r.problems, ["Row 4: needs a name and an email or phone."]);
    const pat = await db.customer.findUniqueOrThrow({ where: { id: existing.id } });
    assert.ok(pat.email?.startsWith("pat-"), "the matched customer's missing email is filled in");
    assert.equal(pat.name, "Pat Phone", "the name isn't overwritten");
    assert.equal(await db.suppression.count({ where: { shopId: a.shopId, source: "import", scope: "marketing", channel: "email" } }), 1);
    assert.equal(await db.customer.count({ where: { shopId: a.shopId, smsConsentAt: { not: null } } }), 0, "an import never records text consent");
    await expectError("too many", () => importCustomersAs(user(a), Array.from({ length: 5001 }, () => ({ name: "x", email: "x@a.test" }))), /^Import at most 5000 at a time\.$/);
    ok("import: 1 added by email+phone, 1 matched by phone (email filled in), 1 unsubscribed (suppression), 1 problem row; no text consent; 5001 rows refused");

    // ---- tenant: another company's campaign id is "not found"
    const b = await checkShop({ retail: true, modules: ["marketing"] });
    for (const [label, fn] of [
      ["queue", () => queueCampaignAs(user(b), small, fd({ confirm: "3" }))],
      ["cancel", () => cancelCampaignAs(user(b), small)],
      ["copy", () => copyCampaignAs(user(b), small)],
      ["delete", () => deleteCampaignAs(user(b), small)],
      ["save", () => saveCampaignAs(user(b), small, emailDraft("x"))],
    ] as const) {
      await expectError(label, fn, /^Campaign not found\.$/);
    }
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: small } })).status, "SENT");
    ok("tenant: company B can't touch company A's campaign");

    console.log(`campaigns.check: ${steps} groups passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } finally {
    if (prior === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = prior;
    await cleanup();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
