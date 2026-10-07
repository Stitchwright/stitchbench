// Build this quilt from our stock (shop-features-round-2-design.md 5.3, package quilt-from-stock):
//   1. the request and the checks (pure): the focus fabric's tags and collection, numbered candidates; a pick off the
//      list, for a part not asked, without the yards, or a second pick for a part is dropped
//   2. Suggest coordinates end to end: this company's fabric in stock with enough yards (the focus itself, short bolts,
//      consigned stock and another company's never sent), the same collection first; one quilt_pick call (suggest)
//   3. a photo of what she brought: tagged first (tag_fabric with the image), then the picks
//   4. refused: no focus, a focus with no tags, another company's fabric, nothing left to fill, the switch off (no call)
//   5. thread to match (no Assistant): threads on the shelf whose swatch or color words match, best first
//   npm run -s check scripts/checks/quilt-from-stock.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { saveSettings } from "@/lib/assistant/bodies";
import { quiltPick } from "@/lib/assistant/quilt";
import { buildQuiltPick, parseQuiltPicks } from "@/lib/assistant/quilt-prompt";
import { threadMatchesFor } from "@/lib/quilt";
import { bestThreads, colorDistance, threadScore } from "@/lib/quilt-thread";
import { assistantOn, expectUserError, ok, PHOTO, startAssistantHub, stepCount } from "./assistant-hub";
import { checkShop, cleanup } from "./lib";

async function main() {
  // ===== 1. pure =====
  const cands = [
    { ref: "f1", id: "c1", name: "Kona Cream", tags: ["cream"], collection: "Kona Solids", yards: 10 },
    { ref: "f2", id: "c2", name: "Batik Red", tags: ["red", "batik"], collection: null, yards: 1.5 },
  ];
  const roles = [
    { role: "Background", yards: 2.25 },
    { role: "Binding", yards: 0.5 },
  ];
  const b1 = buildQuiltPick({ name: "Kona Navy", tags: ["navy"], collection: "Kona Solids" }, roles, cands);
  assert.equal(b1.feature, "quilt_pick");
  assert.equal(b1.cls, "suggest");
  assert.match(b1.messages[0].content, /\[f1\] Kona Cream; collection Kona Solids; cream; 10 yd/);
  assert.match(b1.messages[0].content, /- Background: needs 2.25 yd/);
  const parsed = parseQuiltPicks(
    JSON.stringify({
      picks: [
        { role: "background", ref: "F1", why: "Calm cream lets the navy sing" },
        { role: "Background", ref: "f2", why: "second pick for the same part" },
        { role: "Binding", ref: "f9", why: "not on the list" },
        { role: "Border", ref: "f2", why: "not asked" },
        { role: "Binding", ref: "f1", why: "same bolt again: 2.25 + 0.5 <= 10" },
      ],
    }),
    roles,
    cands,
  );
  assert.deepEqual(parsed, {
    picks: [
      { role: "Background", id: "c1", why: "Calm cream lets the navy sing" },
      { role: "Binding", id: "c1", why: "same bolt again: 2.25 + 0.5 <= 10" },
    ],
    dropped: 3,
  });
  assert.deepEqual(parseQuiltPicks('{"picks":[{"role":"Background","ref":"f2"}]}', roles, cands), { picks: [], dropped: 1 }, "1.5 yd can't cover 2 1/4");
  assert.equal(parseQuiltPicks("no json", roles, cands), null);
  assert.equal(colorDistance("#000000", "#000000"), 0);
  assert.ok((colorDistance("#000000", "#ffffff") ?? 0) > 700);
  assert.equal(colorDistance("navy", "#000080"), null);
  assert.equal(threadScore({ tags: ["navy"], colorHex: null }, { colorHex: null, colorName: "Dark Blue", description: "Isacord" }), 60, "navy fabric, blue thread");
  assert.equal(threadScore({ tags: ["red"], colorHex: null }, { colorHex: null, colorName: "Green", description: "Isacord" }), null);
  assert.ok((threadScore({ tags: [], colorHex: "#1b2a4a" }, { colorHex: "#1c2b4c", colorName: null, description: "x" }) ?? 0) > 190);
  ok("the request and its checks: off the list, not asked, short on yards, twice for a part: dropped");

  // ===== set-up =====
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const hub = await startAssistantHub((rec) => {
    if (rec.system.startsWith("You look at a photo of a quilting fabric")) return '{"colors":["navy"],"themes":["batik"]}';
    if (rec.system.startsWith("You help a quilt shop pick")) {
      const ref = (name: string) => new RegExp(`\\[(f\\d+)\\] ${name}`).exec(rec.userText)?.[1] ?? "f99";
      return JSON.stringify({
        picks: [
          { role: "Background", ref: ref("Kona Cream"), why: "Soft cream calms the navy" },
          { role: "Binding", ref: ref("Batik Red"), why: "A pop of red" },
          { role: "Border", ref: ref("Kona Cream"), why: "not asked for" },
        ],
      });
    }
    return "?";
  });
  try {
    const fab = (shopId: string, pn: string, description: string, qty: number, o: { tags?: string[]; collection?: string; hex?: string; consign?: boolean } = {}) =>
      db.part.create({ data: { shopId, partNumber: pn, description, kind: "FABRIC", unit: "yd", qtyOnHand: qty, priceCents: 1200, colorTags: o.tags ?? [], collection: o.collection ?? null, colorHex: o.hex ?? null, consignLinkId: o.consign ? "x" : null } });
    const navy = await fab(a.shopId, "K-NAVY", "Kona Navy", 8, { tags: ["navy"], collection: "Kona Solids", hex: "#1b2a4a" });
    const cream = await fab(a.shopId, "K-CREAM", "Kona Cream", 10, { tags: ["cream"], collection: "Kona Solids" });
    const red = await fab(a.shopId, "B-RED", "Batik Red", 5, { tags: ["red", "batik"] });
    await fab(a.shopId, "SHORT", "Short Bolt SHORTONE", 0.25, { tags: ["navy"] });
    await fab(a.shopId, "CONS", "Consigned CONSIGNED", 9, { tags: ["navy"], consign: true });
    const untagged = await fab(a.shopId, "PLAIN", "Plain untagged", 9);
    const other = await fab(b.shopId, "B-1", "B-SECRET fabric", 20, { tags: ["navy"] });
    const want = [
      { role: "Background", yards: 2.25 },
      { role: "Binding", yards: 0.5 },
    ];

    await expectUserError("module off", () => quiltPick(a.user, { focusId: navy.id, roles: want }), /Assistant isn't turned on/);
    await assistantOn(a.shopId);
    await assistantOn(b.shopId);

    // ===== 2. end to end =====
    const r = await quiltPick(a.user, { focusId: navy.id, roles: want });
    assert.equal(hub.calls.length, 1);
    const call = hub.calls[0];
    assert.deepEqual([call.body.feature, call.body.model], ["quilt_pick", "suggest"]);
    const sent = call.body.messages[0].content;
    assert.match(sent, /Colors and themes: navy/);
    assert.match(sent, /\[f1\] Kona Cream; collection Kona Solids/, "the same collection first");
    assert.ok(!/SHORTONE|CONSIGNED|B-SECRET|\] Kona Navy/.test(sent), "not short bolts, consigned stock, another company's, or the focus itself");
    assert.deepEqual(r.picks, [
      { role: "Background", id: cream.id, why: "Soft cream calms the navy" },
      { role: "Binding", id: red.id, why: "A pop of red" },
    ]);
    assert.equal(r.dropped, 1, "the part not asked for is dropped");
    assert.equal((await db.assistantCall.findUniqueOrThrow({ where: { id: r.callId } })).partId, navy.id);
    ok("Suggest coordinates: this company's shelf with the yards, one call, the picks checked");

    // ===== 3. a photo =====
    const before = hub.calls.length;
    const rp = await quiltPick(a.user, { photo: { mediaType: "image/jpeg", data: PHOTO }, roles: want });
    assert.equal(hub.calls.length, before + 2, "the photo is tagged, then the picks");
    assert.deepEqual([hub.calls[before].body.feature, !!hub.calls[before].body.image], ["tag_fabric", true]);
    assert.deepEqual([hub.calls[before + 1].body.feature, !!hub.calls[before + 1].body.image], ["quilt_pick", false], "only the tags go with the picks, not the photo");
    assert.deepEqual(rp.focusTags, ["navy", "batik"]);
    assert.match(hub.calls[before + 1].body.messages[0].content, /\] Kona Navy/, "with a photo, the navy on the shelf is a candidate too");
    ok("a photo of what she brought: tagged first, then the picks");

    // ===== 4. refusals =====
    const n = hub.calls.length;
    await expectUserError("no focus", () => quiltPick(a.user, { roles: want }), /focus fabric first/);
    await expectUserError("untagged focus", () => quiltPick(a.user, { focusId: untagged.id, roles: want }), /no color tags/);
    await expectUserError("another company's fabric", () => quiltPick(a.user, { focusId: other.id, roles: want }), /not found/);
    await expectUserError("nothing to fill", () => quiltPick(a.user, { focusId: navy.id, roles: [] }), /Every part already has a fabric/);
    await saveSettings(a.user, { draftOn: true, causesOn: true, plateOn: true, quiltOn: false, offerFirstNames: false, voice: null });
    await expectUserError("switched off", () => quiltPick(a.user, { focusId: navy.id, roles: want }), /switched off/);
    assert.equal(hub.calls.length, n, "no call for any refusal");
    ok("refused before any call: no focus, untagged, another company's, nothing to fill, the switch off");

    // ===== 5. thread to match =====
    const thread = (shopId: string, pn: string, colorName: string, hex: string | null, qty: number) =>
      db.part.create({ data: { shopId, partNumber: pn, description: `Isacord ${colorName}`, kind: "THREAD", itemType: "thread", brand: "Isacord", colorNumber: pn, colorName, colorHex: hex, qtyOnHand: qty, priceCents: 899 } });
    const tNavy = await thread(a.shopId, "3644", "Navy", "#1c2b4c", 5);
    const tBlue = await thread(a.shopId, "3722", "Light Blue", null, 3);
    const tCream = await thread(a.shopId, "0761", "Ivory", null, 4);
    await thread(a.shopId, "0000", "Navy Gone", "#1b2a4a", 0);
    await thread(b.shopId, "9999", "Navy B-SECRET", "#1b2a4a", 9);
    const m = await threadMatchesFor(a.shopId, [navy.id, cream.id, red.id, other.id]);
    assert.deepEqual(Object.keys(m).sort(), [cream.id, navy.id, red.id].sort(), "another company's fabric is left out");
    assert.deepEqual(m[navy.id].map((t) => t.id), [tNavy.id, tBlue.id], "the close swatch first, then the color word");
    assert.deepEqual(m[cream.id].map((t) => t.id), [tCream.id], "cream fabric, ivory thread");
    assert.deepEqual(m[red.id], []);
    assert.match(m[navy.id][0].name, /Isacord 3644 Navy/);
    assert.ok(!JSON.stringify(m).includes("B-SECRET") && !JSON.stringify(m).includes("Navy Gone"));
    assert.deepEqual(bestThreads({ tags: ["navy"], colorHex: null }, []), []);
    ok("thread to match: on the shelf, this company's, the close swatch first");

    console.log(`quilt-from-stock check: ${stepCount()} groups passed`);
  } finally {
    await hub.close();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
