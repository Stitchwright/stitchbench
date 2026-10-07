// Shop hop passports, the program's side (shop-features-round-2-design.md 4.6), against a mock of the hub routes listed in
// the Built note: off by default (refused until turned on); the code read forgivingly; an organizer starts a hop and
// invites a shop that chooses to take part; stamps signed with the shop's key (the mock checks the SBHS1 signature),
// "Stamp 2 of 2", once per passport, a shopper's details only when she shared them; a passport the hub doesn't know;
// the hub unreachable: the stamp waits and goes later; the organizer's completed passports and drawing; tenant.
//   npm run -s check scripts/checks/shop-hops.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { passportCode, ruleOf, ruleWords, signStamp, verifyStamp, type StampSig } from "@/lib/hops/hop-math";
import { completedFor, drawHopWinnerFor, hopDay, hopNotPresentFor, inviteCodeFor, joinHopFor, leaveHopFor, refreshHopsFor, sendWaitingFor, setHopOnFor, stampFor, startHopFor } from "@/lib/hops/hops";
import { newKeyPair } from "@/lib/partner-signing";
import { checkShop, cleanup } from "./lib";
import { expectNotFound } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

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

// ---------------------------------------------------------------- the mock hub
type MHop = { id: string; name: string; startsOn: string; endsOn: string; rule: string; shops: Map<string, { key: string; role: string; status: string }>; codes: Set<string>; draws: { id: string; passport: string; name: string; prize: string; present: boolean; at: string }[] };
type MPassport = { code: string; hopId: string; name: string; email: string; share: boolean; stamps: Set<string> };
const hops = new Map<string, MHop>();
const passports = new Map<string, MPassport>();
let n = 0;
const badSigs: string[] = [];

function startHub(port = 0): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.headers.authorization !== "Bearer ik_hop") return send(401, { error: "Who are you?" });
    const shop = String(req.headers["x-shop-ref"] ?? "");
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url ?? "";
    const view = (h: MHop) => ({ id: h.id, name: h.name, startsOn: h.startsOn, endsOn: h.endsOn, rule: h.rule, shops: [...h.shops.values()].filter((s) => s.status === "JOINED").length, role: h.shops.get(shop)?.role, status: h.shops.get(shop)?.status });
    if (url === "/v1/hops" && req.method === "GET") return send(200, { hops: [...hops.values()].filter((h) => h.shops.has(shop)).map(view) });
    if (url === "/v1/hops" && req.method === "POST") {
      const id = `hop${++n}`;
      const h: MHop = { id, name: body.name, startsOn: body.startsOn, endsOn: body.endsOn, rule: body.rule, shops: new Map([[shop, { key: body.publicKey, role: "ORGANIZER", status: "JOINED" }]]), codes: new Set(), draws: [] };
      hops.set(id, h);
      return send(200, { hop: view(h) });
    }
    if (url === "/v1/hops/join") {
      const h = [...hops.values()].find((x) => x.codes.has(body.code));
      if (!h) return send(404, { error: "That code isn't right or has run out." });
      h.shops.set(shop, { key: body.publicKey, role: "MEMBER", status: "JOINED" });
      return send(200, { hop: view(h) });
    }
    const m = /^\/v1\/hops\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(url);
    const h = m ? hops.get(m[1]) : null;
    const me = h?.shops.get(shop);
    if (!h || !me) return send(404, { error: "Hop not found." });
    const what = m![2];
    if (what === "invite-code") {
      if (me.role !== "ORGANIZER") return send(403, { error: "Only the organizer invites shops." });
      const code = `HJ-${++n}ABC`;
      h.codes.add(code);
      return send(200, { code });
    }
    if (what === "leave") {
      me.status = "LEFT";
      return send(200, { ok: true });
    }
    if (what === "stamps") {
      const p = passports.get(body.passport);
      if (!p || p.hopId !== h.id) return send(404, { error: "No passport with that code in this hop.", code: "no_passport" });
      const sig = body.sig as StampSig;
      const fields = { hopId: h.id, shopRef: shop, stampId: body.stampId, passport: body.passport, at: body.at };
      if (sig.pub !== me.key || !verifyStamp(sig, fields)) {
        badSigs.push(body.stampId);
        return send(403, { error: "The stamp's signature doesn't check out." });
      }
      p.stamps.add(shop);
      const joined = [...h.shops.values()].filter((s) => s.status === "JOINED").length;
      const of = h.rule.startsWith("any:") ? Number(h.rule.slice(4)) : joined;
      return send(200, { stampNo: p.stamps.size, of, complete: p.stamps.size >= of, shopper: p.share ? { name: p.name, email: p.email } : null });
    }
    if (what === "completed") {
      if (me.role !== "ORGANIZER") return send(403, { error: "Only the organizer sees completed passports." });
      const joined = [...h.shops.values()].filter((s) => s.status === "JOINED").length;
      const of = h.rule.startsWith("any:") ? Number(h.rule.slice(4)) : joined;
      const mine = [...passports.values()].filter((p) => p.hopId === h.id);
      return send(200, { passports: mine.length, stamps: mine.reduce((a, p) => a + p.stamps.size, 0), completed: mine.filter((p) => p.stamps.size >= of).map((p) => ({ passport: p.code, name: p.name })), draws: h.draws });
    }
    if (what === "draws" && req.method === "POST") {
      const p = passports.get(body.passport)!;
      const d = { id: `d${++n}`, passport: p.code, name: p.name, prize: body.prize, present: true, at: new Date().toISOString() };
      h.draws.push(d);
      return send(200, { draw: d });
    }
    if (what === "draws" && req.method === "PATCH") {
      const d = h.draws.find((x) => x.id === m![3]);
      if (!d) return send(404, { error: "Draw not found." });
      d.present = body.present !== false;
      return send(200, { draw: d });
    }
    return send(404, { error: "No such route." });
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

async function main() {
  let server = await startHub();
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const saved = await db.hubState.findUnique({ where: { id: 1 } });
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url, installKey: "ik_hop", scope: "member", installId: "inst_hop" }, update: { url, installKey: "ik_hop", scope: "member", installId: "inst_hop" } });
  const a = await checkShop({ retail: true });
  const b = await checkShop({ retail: true });
  const c = await checkShop({ retail: true });
  try {
    // 1. The pure part.
    assert.equal(passportCode("hop-7k2m-9qxd"), "7K2M9QXD");
    assert.equal(passportCode("https://hub.example/p/HOP-7K2M-9QXD"), "7K2M9QXD");
    assert.equal(passportCode(" 7k2m 9qxo "), "7K2M9QX0");
    assert.equal(passportCode("12345"), null);
    assert.equal(ruleOf("any", 6), "any:6");
    assert.equal(ruleWords("all", 10), "Stamps from all 10 shops");
    const kp = newKeyPair();
    const f = { hopId: "h", shopRef: "s", stampId: "x", passport: "7K2M9QXD", at: "2026-10-07T10:00:00.000Z" };
    assert.ok(verifyStamp(signStamp(kp, f), f) && !verifyStamp(signStamp(kp, f), { ...f, passport: "7K2M9QXE" }));
    ok("passport codes read forgivingly (a QR address, O and I), the prize rule, the stamp signature (SBHS1) and its check");

    // 2. Off by default; on; an organizer starts a hop and invites a shop that takes part.
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).hopOn, false);
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await expectError("off", () => startHopFor(a.user, { name: "Fall Hop", startsOn: today, endsOn: later, ruleKind: "all" }), /Shop hops are off/);
    await expectError("a tech turning it on", () => setHopOnFor({ ...a.user, role: "TECH" }, true), /owner or admin/);
    for (const s of [a, b, c]) await setHopOnFor(s.user, true);
    await expectError("bad dates", () => startHopFor(a.user, { name: "Fall Hop", startsOn: later, endsOn: today, ruleKind: "all" }), /first and last day/);
    const hopA = await startHopFor(a.user, { name: "Fall Hop", startsOn: today, endsOn: later, ruleKind: "all" });
    const code = await inviteCodeFor(a.user, hopA);
    await expectError("a member inviting", () => joinHopFor(b.user, "nope-nope"), /code/);
    const hopB = await joinHopFor(b.user, code);
    await refreshHopsFor(a.user);
    const rowA = await db.shopHop.findUniqueOrThrow({ where: { id: hopA } });
    assert.ok(rowA.role === "ORGANIZER" && rowA.shopsCount === 2 && rowA.rule === "all");
    await expectError("a member's invite", () => inviteCodeFor(b.user, hopB), /organizer/);
    ok("off by default (refused until turned on); an organizer starts a hop, invites a shop with a code, and it takes part");

    // 3. Stamps: signed, "Stamp 1 of 2" then "2 of 2" complete; once per passport; shared details only when shared.
    passports.set("AAAA1111", { code: "AAAA1111", hopId: "hop1", name: "Jane Hopper", email: "jane-hop@example.test", share: true, stamps: new Set() });
    passports.set("BBBB2222", { code: "BBBB2222", hopId: "hop1", name: "Private Pat", email: "pat@example.test", share: false, stamps: new Set() });
    const s1 = await stampFor(a.user, hopA, "hop-aaaa-1111");
    assert.ok(s1.words === "Stamp 1 of 2" && s1.shopper === "Jane Hopper" && !s1.complete);
    const again = await stampFor(a.user, hopA, "AAAA1111");
    assert.match(again.words, /Already stamped here \(stamp 1 of 2\)/);
    const s2 = await stampFor(b.user, hopB, "aaaa1111");
    assert.ok(s2.words === "Stamp 2 of 2" && s2.complete);
    const s3 = await stampFor(b.user, hopB, "BBBB2222");
    assert.ok(s3.words === "Stamp 1 of 2" && s3.shopper === null, "Pat didn't share: a count only");
    await expectError("an unknown passport", () => stampFor(b.user, hopB, "ZZZZ9999"), /isn't in this hop/);
    assert.equal(await db.hopStampLocal.count({ where: { passportRef: "ZZZZ9999" } }), 0, "taken back");
    await expectError("not a code", () => stampFor(b.user, hopB, "hello"), /isn't a passport code/);
    assert.equal(badSigs.length, 0);
    const dayB = (await hopDay(b.shopId, hopB))!;
    assert.ok(dayB.totals.today === 2 && dayB.totals.shared === 1 && dayB.today.some((x) => x.name === null));
    ok("stamps signed and counted (1 of 2, 2 of 2 complete), once per passport, a shopper's details only when she shared them; unknown codes refused");

    // 4. The hub unreachable: the stamp waits, then goes.
    passports.set("CCCC3333", { code: "CCCC3333", hopId: "hop1", name: "Cara", email: "cara@example.test", share: false, stamps: new Set() });
    await new Promise<void>((r) => server.close(() => r()));
    const w = await stampFor(a.user, hopA, "CCCC3333");
    assert.ok(w.waiting && /can't be reached/.test(w.words));
    assert.equal((await hopDay(a.shopId, hopA))!.totals.waiting, 1);
    server = await startHub(port);
    await new Promise((r) => setTimeout(r, 15_500)); // the program waits 15 seconds before asking an offline hub again
    assert.equal(await sendWaitingFor(a.user), 1);
    assert.equal((await hopDay(a.shopId, hopA))!.totals.waiting, 0);
    assert.equal(passports.get("CCCC3333")!.stamps.size, 1);
    ok("with the hub unreachable the stamp is kept and waits; Send now sends it later");

    // 5. The organizer: completed passports and the drawing (not present: drawn again).
    passports.get("BBBB2222")!.stamps.add(a.shopId);
    const comp = await completedFor(a.user, hopA);
    assert.deepEqual(comp.completed.map((x) => x.passport).sort(), ["AAAA1111", "BBBB2222"]);
    await expectError("a member's list", () => completedFor(b.user, hopB), /organizer/);
    const d1 = await drawHopWinnerFor(a.user, hopA, "Sewing machine");
    await hopNotPresentFor(a.user, hopA, d1.id);
    const d2 = await drawHopWinnerFor(a.user, hopA, "Sewing machine");
    assert.notEqual(d2.passport, d1.passport);
    await expectError("nobody left", () => drawHopWinnerFor(a.user, hopA, "Sewing machine"), /has been drawn/);
    ok("the organizer sees completed passports and draws a winner; not present, drawn again; never twice for one prize");

    // 6. Leaving; tenant.
    await expectNotFound("C stamps on B's hop", () => stampFor(c.user, hopB, "AAAA1111"));
    await expectNotFound("C leaves B's hop", () => leaveHopFor(c.user, hopB));
    await expectNotFound("C asks for A's list", () => completedFor(c.user, hopA));
    assert.equal(await hopDay(c.shopId, hopA), null);
    await leaveHopFor(b.user, hopB);
    await expectError("stamping after leaving", () => stampFor(b.user, hopB, "CCCC3333"), /isn't taking part/);
    ok("tenant: another company can't stamp, leave or read A's and B's hops; a shop that left can't stamp");

    console.log(`shop-hops.check: ${steps} groups passed`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    if (saved) await db.hubState.update({ where: { id: 1 }, data: { url: saved.url, installKey: saved.installKey, installId: saved.installId, scope: saved.scope } }).catch(() => {});
    else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => {});
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
