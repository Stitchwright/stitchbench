// Contract tests for contracts/ (the shared API between StitchBench/StitchShop, StitchHub and StitchFoundry). This repo
// carries a copy of the folder (its version is in contracts/VERSION; StitchHub's test/contract.mjs checks the same files
// against the real hub). Here: the files agree with each other, and Bench's REAL code agrees with them: the job.update it
// builds, the sender rules it applies to each message type, how it reads an order's lines and the inbox list.
// A change to Bench that breaks the contract, or a contract change Bench does not follow, fails here.
// Set STITCH_CONTRACTS_DIR to another copy of contracts/ (for example StitchHub's) to also fail when the two have drifted.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { check, loadExample, loadSchema } from "../../contracts/validate.mjs";
import { normalizeTerms } from "@/lib/partner-terms";

// partners.ts and decor-inbox.ts create the database client when they are imported, which wants a DATABASE_URL; nothing
// here connects to it.
process.env.DATABASE_URL ??= "postgresql://contract:contract@localhost:5432/contract";
const partners = () => import("@/lib/partners");
const inbox = () => import("@/lib/decor-inbox");

const C = path.resolve(import.meta.dirname, "../../contracts");
const list = (dir: string, ext = ".json") => fs.readdirSync(path.join(C, dir)).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length));
const messages = JSON.parse(fs.readFileSync(path.join(C, "messages.json"), "utf8")).types as Record<string, { from: string; schema: string }>;

test("every example passes its schema, and a copy missing a required field fails it", () => {
  for (const n of list("schemas")) {
    assert.ok(fs.existsSync(path.join(C, "examples", `${n}.json`)), `schema ${n} has an example`);
    assert.deepEqual(check(n, loadExample(n)), [], n);
    for (const r of (loadSchema(n).required ?? []) as string[]) {
      const broken = structuredClone(loadExample(n));
      delete broken[r];
      assert.ok(check(n, broken).length > 0, `${n} without "${r}" must fail`);
    }
  }
  assert.throws(() => check({ type: "object", minProperties: 1 }, {}), /does not support/);
});

test("the sender rule for each message type is the one the contract states", async () => {
  const { FROM } = await partners();
  for (const [type, m] of Object.entries(messages)) assert.equal(FROM[type], m.from, `${type}: Bench says ${FROM[type]}, the contract says ${m.from}`);
});

test("the job.update Bench builds from a ticket matches the contract", async () => {
  const { jobSnapshot } = await partners();
  const job = { id: "job_7f3a91c2", paidAt: null, totalCents: null, commissionPct: null, commissionCents: null, repairNote: "Needs a new bobbin case" };
  const ticket = {
    status: "WAITING_CUSTOMER_OK",
    number: 2217,
    taxRatePct: 7,
    readyAt: null,
    lines: [
      { description: "Tune-up and clean", qty: 1, unitPriceCents: 9500, kind: "LABOR", taxable: false },
      { description: "Hook timing parts", qty: 2, unitPriceCents: 1600, kind: "PART", taxable: true },
    ],
    payments: [],
  };
  const snap = jobSnapshot(job as never, ticket as never, normalizeTerms({}));
  assert.deepEqual(check("job.update", { ...snap, at: new Date().toISOString() }), []);
  assert.equal(snap.id, job.id, "the job id is the link between the two shops' records");
  assert.equal(snap.totalCents, 9500 + 3200 + Math.round(3200 * 0.07));
  assert.deepEqual(check("job.update", { ...snap, totalCents: "12" }).length > 0, true, "a bill total that is not a number is refused");
});

test("Bench reads an order's lines the way the contract describes them", async () => {
  const { orderLines } = await partners();
  const ex = loadExample("order.new");
  const lines = orderLines(ex.lines);
  assert.equal(lines.length, ex.lines.length);
  assert.deepEqual(lines.map((l) => l.itemKey), ex.lines.map((l: { itemKey: string }) => l.itemKey));
  assert.equal(lines[1].condition, "USED", "a label the sender sent is kept");
});

test("Bench accepts an inbox item as the contract describes it, and drops a broken one", async () => {
  const { cleanItem } = await inbox();
  const ex = loadExample("inbox-item");
  const item = cleanItem(ex);
  assert.ok(item, "the example is usable");
  assert.deepEqual([item.id, item.size, item.sha256, item.preview?.type], [ex.id, ex.size, ex.sha256, "image/png"]);
  assert.equal(item.meta.design, "Logo", "the newer meta keys are read");
  assert.equal(cleanItem({ ...ex, sha256: "nope" }), null, "a checksum that is not a SHA-256 is dropped");
  assert.equal(cleanItem({ ...ex, size: 99_999_999 }), null, "a size over the limit is dropped");
  assert.equal(cleanItem({ ...ex, preview: { ...ex.preview, type: "image/gif" } })?.preview, null, "a preview of another type is left out, the file is kept");
});

test("this copy of contracts/ has not drifted from another one (when STITCH_CONTRACTS_DIR is set)", { skip: !process.env.STITCH_CONTRACTS_DIR }, () => {
  const other = path.resolve(process.env.STITCH_CONTRACTS_DIR!);
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)).map((f) => path.join(e.name, f)) : [e.name]));
  const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  assert.deepEqual(walk(C).sort(), walk(other).sort(), "the same files");
  for (const f of walk(C)) assert.equal(sha(path.join(C, f)), sha(path.join(other, f)), `${f} differs`);
});
