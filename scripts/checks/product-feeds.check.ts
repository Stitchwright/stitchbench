// Google and Facebook feeds (shop-features-round-2-design.md 4.1, 4.2): the barcode's check digit and what the item form
// takes, which items go in and why one doesn't, the three files (Google products, local inventory, Meta catalog), the
// secret in the links (wrong, off, new links), the online shop switched off, a tech refused, and the tenant section.
//   npm run -s check scripts/checks/product-feeds.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { feedFile, feedView, newFeedLinksFor, turnFeedsOffFor, turnFeedsOnFor } from "@/lib/shop/feeds";
import { gtinInput, gtinOf, gtinOk } from "@/lib/shop/feeds-math";
import { saveShopSettingsFor } from "@/lib/shop/online-shop";
import { checkShop, cleanup } from "./lib";
import { RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

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

const tokenOf = (url: string) => url.split("/feeds/")[1].split("/")[0];

async function main() {
  process.env.PUBLIC_URL = "http://localhost:3999";
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  try {
    // 1. Barcodes.
    assert.ok(gtinOk("012345678905") && gtinOk("4006381333931") && gtinOk("96385074") && !gtinOk("012345678901") && !gtinOk("000000000000"));
    assert.deepEqual(gtinInput("0 12345-67890 5"), { gtin: "012345678905" });
    assert.match(gtinInput("12345").error ?? "", /8, 12, 13 or 14/);
    assert.match(gtinInput("012345678901").error ?? "", /last digit/);
    assert.match(gtinInput("abc").error ?? "", /digits only/);
    assert.equal(gtinOf({ gtin: null, partNumber: "ISA-0015", altNumbers: ["4006381333931"] }), "4006381333931", "a barcode kept among the item's numbers");
    ok("barcodes: check digits for 8, 12 and 13 digits, forgiving input, wrong ones explained, one found among the item's numbers");

    // 2. The shop: online shop on; items in and out.
    const slug = `check-${RUN}-fd`;
    await saveShopSettingsFor(a.user, form({ slug, on: "on", pickup: "on", shipRate: "0", payVia: "own", stripeKey: "sk_test_feeds1234567890", stripeWebhook: "whsec_feeds1234567890" }));
    const mk = (n: string, d: Partial<Parameters<typeof db.part.create>[0]["data"]>) =>
      db.part.create({ data: { shopId: a.shopId, partNumber: n, description: `Item ${n}`, numberKeys: [n], priceCents: 1299, qtyOnHand: 4, online: true, kind: "ACCESSORY", ...d } as Parameters<typeof db.part.create>[0]["data"] });
    const good = await mk("FD-1", { gtin: "012345678905", brand: "Clover", onlineText: 'Seam ripper, "large" & sharp' });
    await db.partPhoto.create({ data: { shopId: a.shopId, partId: good.id, data: new Uint8Array([1, 2, 3]), mime: "image/png", sortOrder: 0 } as Parameters<typeof db.partPhoto.create>[0]["data"] });
    await mk("FD-2", { altNumbers: ["4006381333931"], unit: "yd", qtyOnHand: 2.5, kind: "FABRIC", priceCents: 1200 });
    await mk("FD-3", {}); // no barcode
    await mk("FD-4", { gtin: "96385074", priceCents: null }); // no price
    await mk("FD-5", { gtin: "012345678905", online: false }); // not listed
    await mk("FD-6", { gtin: "012345678905", kind: "MACHINE" }); // a model to order
    const before = await feedView(a.shopId);
    assert.ok(!before.on && !before.links && before.problem === null);
    await expectError("a tech", () => turnFeedsOnFor({ ...a.user, role: "TECH" }, null), /owner or admin/);
    await expectError("a bad store code", () => turnFeedsOnFor(a.user, "<script>"), /store code/);
    await turnFeedsOnFor(a.user, "MAIN-1");
    const v = await feedView(a.shopId);
    assert.ok(v.on && v.links && v.storeCode === "MAIN-1");
    assert.equal(v.google, 2, "the barcoded, priced, listed item and the fabric");
    assert.equal(v.meta, 1, "Meta needs a photo");
    const why = Object.fromEntries(v.left.map((l) => [l.partNumber, l.reason]));
    assert.deepEqual(why, { "FD-2": "No photo (Facebook needs one)", "FD-3": "No barcode", "FD-4": "No price", "FD-6": "A machine model to order, not stock" });
    assert.equal(v.notListed, 1);
    ok("switched on by an owner (a tech and a bad store code refused); 2 items for Google, 1 for Meta, the rest named with the reason");

    // 3. The files.
    const token = tokenOf(v.links!.google);
    const g = (await feedFile(slug, token, "google.xml"))!;
    assert.match(g.type, /xml/);
    assert.ok(g.body.includes("<g:gtin>012345678905</g:gtin>") && g.body.includes("<g:price>12.99 USD</g:price>") && g.body.includes("<g:brand>Clover</g:brand>"));
    assert.ok(g.body.includes("&quot;large&quot; &amp; sharp"), "escaped");
    assert.ok(g.body.includes(`/shop/${slug}/i/${good.id}`) && g.body.includes("/api/shop/photo/"), "the item's page and photo");
    assert.ok(g.body.includes("Item FD-2 (price per yard)") && g.body.includes("<g:unit_pricing_measure>1yd</g:unit_pricing_measure>"));
    assert.ok(!g.body.includes("FD-3") && !g.body.includes("FD-5") && !g.body.includes("FD-6"));
    const l = (await feedFile(slug, token, "local.tsv"))!.body.trim().split("\n");
    assert.equal(l[0], "store_code\tid\tquantity\tprice\tavailability\tpickup_method\tpickup_sla");
    assert.ok(l.includes("MAIN-1\tFD-1\t4\t12.99 USD\tin_stock\tbuy\tsame day"));
    assert.ok(l.includes("MAIN-1\tFD-2\t2\t12.00 USD\tin_stock\tbuy\tsame day"));
    const m = (await feedFile(slug, token, "meta.csv"))!.body.trim().split("\n");
    assert.equal(m.length, 2);
    assert.ok(m[1].startsWith("FD-1,Item FD-1,\"Seam ripper, \"\"large\"\" & sharp\",in stock,new,12.99 USD,"));
    await db.part.update({ where: { id: good.id }, data: { qtyOnHand: 0 } });
    assert.ok((await feedFile(slug, token, "google.xml"))!.body.includes("<g:availability>out_of_stock</g:availability>"));
    ok("Google's products (escaped, per yard, the page and photo), the shelf counts by store code, Meta's CSV; sold out shows out of stock");

    // 4. The secret, new links, off; the online shop off.
    assert.equal(await feedFile(slug, "x".repeat(32), "google.xml"), null);
    assert.equal(await feedFile(slug, token, "other.csv"), null);
    await newFeedLinksFor(a.user);
    assert.equal(await feedFile(slug, token, "google.xml"), null, "the old link stops");
    const t2 = tokenOf((await feedView(a.shopId)).links!.meta);
    assert.ok(await feedFile(slug, t2, "meta.csv"));
    await db.shop.update({ where: { id: a.shopId }, data: { shopOn: false } });
    assert.equal(await feedFile(slug, t2, "meta.csv"), null, "the online shop off: no feed");
    assert.match((await feedView(a.shopId)).problem ?? "", /Switch your online shop on/);
    await db.shop.update({ where: { id: a.shopId }, data: { shopOn: true } });
    await turnFeedsOffFor(a.user);
    assert.equal(await feedFile(slug, t2, "meta.csv"), null);
    assert.ok(!(await feedView(a.shopId)).on);
    ok("a wrong secret or file is not found; new links stop the old; the online shop off or the feeds off stop them");

    // 5. Tenant: B's own secret doesn't open A's feed; B's view is its own.
    await turnFeedsOnFor(a.user, null);
    await saveShopSettingsFor(b.user, form({ slug: `${slug}b`, on: "on", pickup: "on", shipRate: "0", payVia: "own", stripeKey: "sk_test_feedsb234567890", stripeWebhook: "whsec_feedsb234567890" }));
    await turnFeedsOnFor(b.user, null);
    const tb = tokenOf((await feedView(b.shopId)).links!.google);
    assert.equal(await feedFile(slug, tb, "google.xml"), null, "B's secret on A's address");
    const bv = await feedView(b.shopId);
    assert.ok(bv.google === 0 && bv.left.length === 0);
    assert.ok(!(await feedFile(`${slug}b`, tb, "google.xml"))!.body.includes("FD-1"));
    ok("tenant: another company's secret doesn't open A's feed, and its feed and view hold none of A's items");

    console.log(`product-feeds.check: ${steps} groups passed`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
