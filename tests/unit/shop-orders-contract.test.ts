// The MakerFoundry order messages against the fixtures shared with StitchHub (tests/fixtures/shop-orders), and the rules for applying them in order.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileRefs, parseBody, UNDERSTOOD, type OrderPlaced } from "../../src/lib/shop-orders/contract";
import { GAP_MS, parseEnvelope, planApply } from "../../src/lib/shop-orders/protocol";

const dir = path.join(import.meta.dirname, "..", "fixtures", "shop-orders");
const fixture = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
const FROM: Record<string, "service" | "shop" | "hub"> = { catalog: "shop", "order.placed": "service", "order.status": "shop", "proof.sent": "shop", "proof.answer": "service", "order.cancel": "shop", "message.expired": "hub" };

test("every valid fixture is accepted and comes out unchanged", () => {
  for (const [type, from] of Object.entries(FROM)) {
    const body = fixture(`${type}.v1.valid.json`);
    const p = parseBody(type, 1, body, from);
    assert.ok(p.ok, `${type}: ${p.ok ? "" : p.error}`);
    assert.deepEqual(p.body, body, type);
    assert.deepEqual(p.dropped, [], type);
  }
});

test("every invalid fixture is refused with its code", () => {
  for (const f of fixture("invalid.json") as { name: string; type: string; from: "service" | "shop" | "hub"; code: string; body: unknown }[]) {
    const p = parseBody(f.type, 1, f.body, f.from);
    assert.equal(p.ok, false, `${f.name}: should have been refused`);
    if (!p.ok) assert.equal(p.code, f.code, `${f.name}: ${p.error}`);
  }
});

test("a field outside the version is left out and noted; an unknown version or type is refused", () => {
  const u = fixture("unknown-fields.v1.json");
  const p = parseBody(u.type, 1, u.body, "shop");
  assert.ok(p.ok);
  if (p.ok) {
    assert.deepEqual(p.dropped, u.dropped);
    assert.equal((p.body as Record<string, unknown>).internal_cost, undefined);
  }
  assert.equal(parseBody("order.placed", 2, {}, "service").ok, false);
  assert.equal(parseBody("order.refund", 1, {}, "service").ok, false);
});

test("a customer cancel has to come from the service, a shop cancel from the shop", () => {
  assert.ok(parseBody("order.cancel", 1, { by: "customer", why: "Changed my mind" }, "service").ok);
  assert.equal(parseBody("order.cancel", 1, { by: "customer", why: "x" }, "shop").ok, false);
  assert.equal(parseBody("order.cancel", 1, { by: "shop", why: "x" }, "service").ok, false);
});

test("the files an order points at are listed once each, art then the preview", () => {
  const body = fixture("order.placed.v1.valid.json") as OrderPlaced;
  body.lines.push(structuredClone(body.lines[0]));
  const refs = fileRefs(body);
  assert.deepEqual(refs.map((r) => r.kind), ["art", "mockup"]);
});

test("what this program says it understands has a body rule for each", () => {
  for (const [type, versions] of Object.entries(UNDERSTOOD)) for (const v of versions) assert.ok(fixture(`${type}.v${v}.valid.json`));
});

test("an envelope from the hub is read, a damaged one is not", () => {
  const good = { id: "6f1f6bde-6b1a-4f6e-9a5e-0c2a0f2d9a11", from: "service:makerfoundry", to: "shop:abc", type: "order.placed", version: 1, conversation: "mf-1", seq: 1, created_at: "2026-11-02T10:00:00Z", expires_at: "2026-11-09T10:00:00Z", body: {}, delivery_seq: "12" };
  const e = parseEnvelope(good);
  assert.equal(e?.conversation, "mf-1");
  assert.equal(e?.deliverySeq, "12");
  for (const bad of [{ ...good, id: "nope" }, { ...good, seq: 0 }, { ...good, from: "someone" }, { ...good, delivery_seq: "x" }, { ...good, created_at: "yesterday" }, null, []]) assert.equal(parseEnvelope(bad), null);
});

test("messages are applied in seq order; a gap waits, and is given up on after 24 hours", () => {
  const t0 = 1_000_000;
  const w = (id: string, seq: number, at = t0) => ({ id, seq, receivedAt: at });
  // in order
  assert.deepEqual(planApply(1, [w("a", 1), w("b", 2)], t0).due.map((x) => x.id), ["a", "b"]);
  // out of order arrival: the sort fixes it
  assert.deepEqual(planApply(1, [w("b", 2), w("a", 1)], t0).due.map((x) => x.id), ["a", "b"]);
  // a gap: seq 3 waits for seq 2
  const gap = planApply(1, [w("a", 1), w("c", 3)], t0);
  assert.deepEqual(gap.due.map((x) => x.id), ["a"]);
  assert.equal(gap.next, 2);
  // an old copy is stale, not applied twice
  const old = planApply(3, [w("a", 1), w("c", 3)], t0);
  assert.deepEqual(old.stale.map((x) => x.id), ["a"]);
  assert.deepEqual(old.due.map((x) => x.id), ["c"]);
  // the gap is given up on after a day, and says so
  const late = planApply(2, [w("c", 3, t0)], t0 + GAP_MS + 1);
  assert.deepEqual(late.due.map((x) => x.id), ["c"]);
  assert.equal(late.gapped, true);
  // two different messages claiming one seq: the first is applied, the other is stale
  const dup = planApply(1, [w("a", 1), w("z", 1, t0 + 5)], t0 + 10);
  assert.deepEqual(dup.due.map((x) => x.id), ["a"]);
  assert.deepEqual(dup.stale.map((x) => x.id), ["z"]);
});
