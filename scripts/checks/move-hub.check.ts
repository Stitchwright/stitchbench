// The hub's part of moving a company (company-move-design.md section 5 and 7, package move-hub), against a mock StitchHub
// in this process (a tiny HTTP server, as base-license.check.ts has; the hub's own side is stitchhub test/move.mjs):
//   1. export: the owner's confirm asks the hub for a move token, kept sealed on the move's row; every download carries
//      the same one in meta.hub with the install's places in the feeds; the Settings card says so
//   2. import onto an install already on the hub: POST /v1/shops/move with its key; the standing applied; the partner
//      catch-up from the old install's place, this company's messages only, one already applied skipped; the token
//      dropped from the row
//   3. the hub down after the import: the import stands, the summary says "Re-point the hub", the token stays sealed;
//      "Re-point the hub" then succeeds; again says it's done; another company's owner can't
//   4. import onto an install on no hub yet: the hub makes it an install (no key sent), HubState written, the partner
//      feed carries on from the old install's place
//   5. the old install learns: its sync's claim answers 410 moved → Shop.movedOutAt / movedTo, still read-only with the
//      moved message; not claimed again; a second move refused
//   6. "The move is done" by hand on an install on no hub, only after a download
//   7. the old copy deleted: refused before 30 days, for a company that didn't move, by a non-administrator, with the
//      wrong name; allowed after, with PartnerSeen, PartnerFailure, Listing and MarketOrder rows (no foreign key) gone;
//      the tray's door (/api/move/remove): shut without the program's one-use token
//   8. a cancel while the hub is down: the hub is told at the next sync
//   9. the hub down at the confirm: the file says so (no token); a later download gets one
//  10. an install on another hub (refused, token kept), a copy made without the freeze (no token)
//  11. tenant: company B learns and changes nothing of the others' moves
//   npm run check scripts/checks/move-hub.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the HubState row and every company's
// hub fields are put back as they were.
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadable } from "node:stream/web";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/user-error";
import { requireBaseWritable } from "@/lib/base-gate";
import { hubState, syncHub } from "@/lib/hub";
import { unseal } from "@/lib/messaging/secrets";
import { cancelMove, confirmMovedOut, exportCompany, moveView, startMove, type Mover } from "@/lib/move/export";
import { MOVE_CANCEL_PENDING, parseLine, type MoveMeta } from "@/lib/move/format";
import { hubMoveView, repointHubFor } from "@/lib/move/hub-step";
import { importCompany, type ImportSummary } from "@/lib/move/import";
import { moveToken } from "@/lib/move/local";
import { deleteMovedCompany } from "@/lib/move/old-copy";
import { POST as removeRoute } from "@/app/api/move/remove/route";
import { checkShop, cleanup, linkPair, type CheckShop } from "./lib";
import { assertUnchanged, removeCompany, RUN, snapshot } from "./tenant";

const DAY = 86_400_000;
let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "move-hub-check-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// ---------- the mock hub ----------

type Call = { method: string; path: string; auth: string | null; shop: string | undefined; body: Record<string, unknown> };
type Install = { id: string; name: string; scope: string };
type Token = { ref: string; from: string; used: string | null; cancelled: boolean };
type Msg = { seq: string; id: string; linkId: string; fromSide: string; toSide: string; toShopRef: string; type: string; data: Record<string, unknown>; createdAt: string };
type Mock = {
  url: string;
  down: boolean;
  installs: Map<string, Install>; // by key
  tokens: Map<string, Token>;
  shops: Map<string, string>; // company → the install it is on
  moved: Map<string, { to: string; at: string }>; // "<from install>|<company>" → where it went
  links: Map<string, string[]>; // company → its partner links
  messages: Msg[];
  calls: Call[];
  close(): Promise<void>;
};

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

async function startMock(): Promise<Mock> {
  const m = {
    down: false,
    installs: new Map([
      ["key-old", { id: "inst_old", name: "Old PC", scope: "member" }],
      ["key-new", { id: "inst_new", name: "New PC", scope: "member" }],
    ]),
    tokens: new Map(),
    shops: new Map(),
    moved: new Map(),
    links: new Map(),
    messages: [],
    calls: [],
  } as unknown as Mock;
  const lastDay = new Date(Date.now() + 29 * DAY).toISOString().slice(0, 10);
  const standing = (ref: string, name: unknown) => ({
    shop: { id: `hs_${ref}`, shopRef: ref, name: name ?? null, kind: "repair" },
    account: null,
    standing: "trial",
    lastDay,
    message: `Free trial through ${lastDay}.`,
    key: null,
    revokeKeyIds: [],
  });
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const auth = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const shop = typeof req.headers["x-shop-ref"] === "string" ? req.headers["x-shop-ref"] : undefined;
    const body = req.method === "POST" || req.method === "PUT" ? await readJson(req) : {};
    if (m.down) return send(503, { error: "The hub is down for a moment." });
    if (p === "/health") return send(200, { ok: true });
    m.calls.push({ method: req.method ?? "GET", path: p, auth, shop, body });
    const caller = auth ? m.installs.get(auth) : undefined;
    if (p === "/v1/shops/move" && req.method === "POST") {
      if (auth && !caller) return send(401, { error: "This install isn't known to the hub." });
      const t = m.tokens.get(String(body.token));
      if (!t || t.ref !== body.shopRef) return send(404, { error: "That move token isn't right for this company." });
      if (t.cancelled) return send(410, { error: "That move token was replaced by a newer move file, or the move was cancelled." });
      if (t.used && (!caller || t.used !== caller.id)) return send(409, { error: "That move token was used already." });
      let to = caller;
      let made: { key: string; install: Install } | null = null;
      if (!to && !t.used) {
        const key = `key-fresh-${crypto.randomBytes(6).toString("hex")}`;
        to = { id: `inst_fresh_${m.installs.size}`, name: String(body.shopName ?? "Fresh"), scope: "member" };
        m.installs.set(key, to);
        made = { key, install: to };
      }
      t.used = to!.id;
      m.shops.set(t.ref, to!.id);
      m.moved.set(`${t.from}|${t.ref}`, { to: to!.name, at: new Date().toISOString() });
      return send(200, {
        ok: true,
        moved: { shops: 1 },
        ...standing(t.ref, body.shopName),
        partner: { shopRef: t.ref, links: m.links.get(t.ref) ?? [] },
        hubName: "Mock hub",
        ...(made ? { installId: made.install.id, installKey: made.key, scope: made.install.scope } : {}),
      });
    }
    if (!caller) return send(401, { error: "Join the hub first (Settings → Community hub)." });
    const tokenRoute = /^\/v1\/shops\/([^/]+)\/move-token$/.exec(p);
    if (tokenRoute && req.method === "POST") {
      const ref = decodeURIComponent(tokenRoute[1]);
      for (const t of m.tokens.values()) if (t.ref === ref && !t.used) t.cancelled = true;
      const token = `shm_${crypto.randomBytes(32).toString("base64url")}`;
      m.tokens.set(token, { ref, from: caller.id, used: null, cancelled: false });
      if (!m.shops.has(ref)) m.shops.set(ref, caller.id);
      return send(200, { token, expiresAt: new Date(Date.now() + 14 * DAY).toISOString(), shopRef: ref, hubName: "Mock hub" });
    }
    if (tokenRoute && req.method === "DELETE") {
      const ref = decodeURIComponent(tokenRoute[1]);
      let n = 0;
      for (const t of m.tokens.values()) {
        if (t.ref !== ref || t.from !== caller.id || t.used || t.cancelled) continue;
        t.cancelled = true;
        n += 1;
      }
      return send(200, { ok: true, cancelled: n });
    }
    if (p === "/v1/shops/claim" && req.method === "POST") {
      const ref = String(body.shopRef);
      const gone = m.moved.get(`${caller.id}|${ref}`);
      if (gone && m.shops.get(ref) !== caller.id) return send(410, { error: `This company moved to ${gone.to}.`, moved: true, to: gone.to, at: gone.at });
      if (!m.shops.has(ref)) m.shops.set(ref, caller.id);
      return send(200, { ok: true, listings: 0, ...standing(ref, body.shopName) });
    }
    if (p === "/v1/me") return send(200, { installId: caller.id, name: caller.name, scope: caller.scope, hubName: "Mock hub", discordInvite: null });
    if (p === "/v1/partners/messages") {
      const since = BigInt(url.searchParams.get("since") ?? "0");
      const ref = url.searchParams.get("shopRef");
      const list = m.messages.filter((x) => BigInt(x.seq) > since && (!ref || x.toShopRef === ref));
      return send(200, { messages: list, next: list.length ? list[list.length - 1].seq : String(since), more: false });
    }
    if (p === "/v1/partners/links") return send(200, []);
    if (p === "/v1/changes") return send(200, { links: [], posts: [], figures: [], xparts: [], listings: [], next: "0", more: false });
    if (p === "/v1/orders") return send(200, { orders: [], next: "0" });
    if (p === "/v1/usage") return send(200, { ok: true, items: 0, shopRef: body.shopRef ?? null });
    return send(404, { error: "Not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  m.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  m.close = () => new Promise<void>((r) => server.close(() => r()));
  return m;
}

// ---------- helpers ----------

/** This install's hub connection, as one of the mock's installs (or none). */
async function setHub(m: Mock, which: "old" | "new" | "none" | { url: string; key: string }) {
  const data =
    which === "none"
      ? {
          url: null,
          hubName: null,
          installId: null,
          installKey: null,
          cursor: null,
          orderCursor: null,
          partnerCursor: null,
          scope: "member",
          formerUrl: null,
          formerInstallId: null,
          formerInstallKey: null,
        }
      : typeof which === "object"
        ? { url: which.url, hubName: "Another hub", installId: "inst_other", installKey: which.key, cursor: "5", orderCursor: "5", partnerCursor: "5", scope: "member" }
        : which === "old"
          ? { url: m.url, hubName: "Mock hub", installId: "inst_old", installKey: "key-old", cursor: "10", orderCursor: "20", partnerCursor: "30", scope: "member" }
          : { url: m.url, hubName: "Mock hub", installId: "inst_new", installKey: "key-new", cursor: "40", orderCursor: "50", partnerCursor: "100", scope: "member" };
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: { ...data, partnerLockUntil: null } });
}

/** The hub answers again: the program's "out of reach" memory (15 s) is let go, as if the time had passed. */
function hubBack(m: Mock) {
  m.down = false;
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
}

const owner = (c: CheckShop): Mover => ({ id: c.user.id, shopId: c.shopId, role: "OWNER", email: c.user.email, name: c.user.name });

/** A move's file on disk and its header: the download read to the end. */
async function download(c: CheckShop, moveId: string | null): Promise<{ file: string; meta: MoveMeta }> {
  const ex = await exportCompany(owner(c), c.shopId, moveId ? { moveId } : {});
  const chunks: Buffer[] = [];
  for await (const ch of Readable.fromWeb(ex.stream as unknown as WebReadable)) chunks.push(Buffer.from(ch as Uint8Array));
  const raw = Buffer.concat(chunks);
  const file = path.join(DIR, `${c.shopId}-${crypto.randomBytes(4).toString("hex")}.stitchmove.ndjson.gz`);
  fs.writeFileSync(file, raw);
  const first = zlib.gunzipSync(raw).toString("utf8").split("\n")[0];
  if (moveId) {
    // The move record is marked done once the download's pipeline has finished.
    for (let i = 0; i < 100 && (await db.companyMove.findUniqueOrThrow({ where: { id: moveId } })).status !== "done"; i += 1) await sleep(50);
  }
  return { file, meta: parseLine(first, 1) as MoveMeta };
}

/** The old copy goes (one database stands in for both installs; a move never merges), with its rows that have no foreign key. */
async function dropCompany(shopId: string) {
  await db.partnerSeen.deleteMany({ where: { shopId } });
  await db.partnerFailure.deleteMany({ where: { shopId } });
  await removeCompany(shopId);
}

async function moveRow(shopId: string, direction: "export" | "import") {
  const rows = await db.companyMove.findMany({ where: { shopId, direction }, orderBy: { startedAt: "desc" } });
  return direction === "import" ? rows.find((r) => r.hubCursors != null)! : rows[0];
}

const HUB_FIELDS = ["hubAccountEmail", "hubAccountVerified", "hubStanding", "hubStandingAt", "hubStandingUntil", "hubStandingNote"] as const;

async function main() {
  const savedHub = await hubState();
  const savedShops = await db.shop.findMany({
    select: { id: true, hubAccountEmail: true, hubAccountVerified: true, hubStanding: true, hubStandingAt: true, hubStandingUntil: true, hubStandingNote: true },
  });
  const savedAdmins = process.env.PLATFORM_ADMIN_EMAILS;
  const savedSecret = process.env.MOVE_LOCAL_SECRET;
  const ADMIN = `move-hub-admin-${RUN}@stitchbench.test`;
  process.env.PLATFORM_ADMIN_EMAILS = [savedAdmins, ADMIN].filter(Boolean).join(",");
  const mock = await startMock();
  const made: string[] = [];
  const company = async (o: { retail?: boolean } = {}) => {
    const c = await checkShop(o.retail ? { retail: true } : {});
    made.push(c.shopId);
    return c;
  };
  try {
    const a = await company();
    const b = await company({ retail: true });
    const linkId = await linkPair(a.shopId, b.shopId);
    // A message A applied before the move (its PartnerSeen row travels in the file).
    const oldKey = `${linkId}:retail:old-${RUN}:repair`;
    await db.partnerSeen.create({ data: { shopId: a.shopId, key: oldKey } });
    const snapB = await snapshot(b.shopId, ["PartnerLink", "PartnerOutbox", "Customer", "Ticket"]);
    const seenB = async () => (await db.partnerSeen.findMany({ where: { shopId: b.shopId }, select: { key: true }, orderBy: { key: "asc" } })).map((x) => x.key);
    const seenBefore = await seenB();
    const admin = { shopId: b.shopId, email: ADMIN };

    // ---------- 1. export: the token, kept sealed, in every download ----------
    await setHub(mock, "old");
    const aMove = await startMove(owner(a), a.shopId, { to: "the new PC", agreed: true });
    const mints = () => mock.calls.filter((c) => c.method === "POST" && /move-token$/.test(c.path));
    assert.equal(mints().length, 1, "the confirm asks the hub for a token");
    assert.deepEqual([mints()[0].path, mints()[0].auth, mints()[0].shop, mints()[0].body.shopName], [`/v1/shops/${a.shopId}/move-token`, "key-old", a.shopId, a.name]);
    const tokenA = [...mock.tokens.entries()].find(([, t]) => t.ref === a.shopId)![0];
    const rowA = await moveRow(a.shopId, "export");
    assert.equal(rowA.hubUrl, mock.url);
    assert.notEqual(rowA.hubTokenSealed, tokenA, "kept sealed, not in the clear");
    assert.equal(unseal(rowA.hubTokenSealed, a.shopId, `moveToken:${aMove}`)?.plain, tokenA);
    const fileA = await download(a, aMove);
    assert.deepEqual(fileA.meta.hub, { url: mock.url, installId: "inst_old", moveToken: tokenA, cursor: "10", orderCursor: "20", partnerCursor: "30" });
    assert.ok(!fileA.meta.warnings.some((w) => /move token/.test(w)), "no hub warning when the file has its token");
    const again = await download(a, aMove);
    assert.equal(again.meta.hub?.moveToken, tokenA, "a second download carries the same token");
    assert.equal(mints().length, 1, "and asks the hub for none");
    const view = await moveView(owner(a), a.shopId);
    assert.deepEqual(view.hub, { onHub: true, hasToken: true, error: null });
    ok("export: the confirm gets a move token (sealed on the move's row); every download carries it with the install's places in the feeds");

    // ---------- 2. import onto an install already on the hub ----------
    mock.links.set(a.shopId, [linkId]);
    const now = new Date().toISOString();
    const msg = (seq: string, to: string, id: string, features: string[]): Msg => ({
      seq,
      id,
      linkId,
      fromSide: to === a.shopId ? "retail" : "repair",
      toSide: to === a.shopId ? "repair" : "retail",
      toShopRef: to,
      type: "caps.update",
      data: { features },
      createdAt: now,
    });
    mock.messages.push(msg("25", a.shopId, `old-${RUN}`, ["stale"]), msg("31", a.shopId, `new-${RUN}`, ["pickup", "x-moved"]), msg("32", b.shopId, `for-b-${RUN}`, ["for-b"]));
    await dropCompany(a.shopId);
    await setHub(mock, "new");
    const sumA: ImportSummary = await importCompany(fileA.file, { by: "operator" });
    assert.equal(sumA.hub.status, "done", sumA.hub.message);
    assert.match(sumA.hub.message, /has the company here now/);
    assert.equal(sumA.hub.caughtUp, 1, "one partner message after the file was made");
    assert.ok(sumA.notes.includes(sumA.hub.message), "said in the summary");
    const redeem = mock.calls.filter((c) => c.path === "/v1/shops/move");
    assert.equal(redeem.length, 1);
    assert.deepEqual([redeem[0].auth, redeem[0].shop, redeem[0].body.shopRef, redeem[0].body.token, redeem[0].body.shopName], ["key-new", a.shopId, a.shopId, tokenA, a.name]);
    assert.equal(mock.shops.get(a.shopId), "inst_new", "the hub has the company on the new install");
    const pull = mock.calls.find((c) => c.path === "/v1/partners/messages");
    assert.ok(pull && pull.auth === "key-new" && pull.shop === a.shopId);
    const inRow = await moveRow(a.shopId, "import");
    assert.ok(inRow.hubDoneAt, "hubDoneAt set");
    assert.equal(inRow.hubTokenSealed, null, "the token is dropped once used");
    assert.deepEqual(inRow.hubCursors, { cursor: "10", orderCursor: "20", partnerCursor: "30" });
    const linkA = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: a.shopId, id: linkId } } });
    assert.deepEqual(linkA.features, ["pickup", "x-moved"], "the message after the file was applied");
    assert.ok(await db.partnerSeen.findUnique({ where: { shopId_key: { shopId: a.shopId, key: `${linkId}:retail:new-${RUN}:repair` } } }));
    assert.ok(await db.partnerSeen.findUnique({ where: { shopId_key: { shopId: a.shopId, key: oldKey } } }), "the one applied before came in the file");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).hubStanding, "trial", "the standing the hub answered");
    assert.equal((await hubState())?.partnerCursor, "100", "this install's own place in the partner feed doesn't move");
    assert.deepEqual(await hubMoveView(a.shopId).then((v) => v && { done: !!v.doneAt, canRetry: v.canRetry }), { done: true, canRetry: false });
    await dropCompany(a.shopId); // its old install's sync (below) would otherwise take this copy for the one that left
    ok("import onto an install on the hub: redeemed with its key, standing applied, the partner backlog caught up once (this company's only), the token dropped");

    // ---------- 3. the hub down after the import: Re-point the hub ----------
    const c = await company();
    await setHub(mock, "old");
    const cMove = await startMove(owner(c), c.shopId, { agreed: true });
    const fileC = await download(c, cMove);
    assert.ok(fileC.meta.hub?.moveToken);
    await dropCompany(c.shopId);
    await setHub(mock, "new");
    mock.down = true;
    const sumC = await importCompany(fileC.file, { by: "operator" });
    assert.equal(sumC.hub.status, "failed");
    assert.match(sumC.hub.message, /Re-point the hub/);
    assert.ok(await db.shop.findUnique({ where: { id: c.shopId } }), "the import stands");
    const cRow = await moveRow(c.shopId, "import");
    assert.ok(cRow.hubTokenSealed && !cRow.hubDoneAt && cRow.hubError);
    const cView = await hubMoveView(c.shopId);
    assert.equal(cView?.canRetry, true, "Settings and Companies offer Re-point the hub");
    await expectError("Re-point while still down", () => repointHubFor(c.user, c.shopId), /Re-point the hub|No connection/);
    hubBack(mock);
    await expectError("tenant: B's owner re-points C", () => repointHubFor(b.user, c.shopId), /^Company not found\.$/);
    await expectError("tenant: C's tech", () => repointHubFor({ ...c.user, role: "TECH" }, c.shopId), /^Company not found\.$/);
    const step = await repointHubFor(c.user, c.shopId);
    assert.equal(step.status, "done");
    assert.equal(mock.shops.get(c.shopId), "inst_new");
    const cDone = await moveRow(c.shopId, "import");
    assert.ok(cDone.hubDoneAt && cDone.hubTokenSealed === null && cDone.hubError === null);
    assert.equal((await repointHubFor(c.user, c.shopId)).message, "StitchHub already has the company here.");
    // The administrator can re-point any company (Companies).
    assert.equal((await repointHubFor({ shopId: b.shopId, role: "OWNER", email: ADMIN }, c.shopId)).status, "done");
    await dropCompany(c.shopId);
    ok("the hub down after the import: the import stands, Re-point the hub (owner or administrator) succeeds once it answers; nobody else can");

    // ---------- 4. import onto an install on no hub yet ----------
    const d = await company();
    await setHub(mock, "old");
    const dMove = await startMove(owner(d), d.shopId, { agreed: true });
    const fileD = await download(d, dMove);
    await dropCompany(d.shopId);
    await setHub(mock, "none");
    const sumD = await importCompany(fileD.file, { by: "operator" });
    assert.equal(sumD.hub.status, "done", sumD.hub.message);
    assert.match(sumD.hub.message, /this install joined it/);
    const keyless = mock.calls.filter((x) => x.path === "/v1/shops/move").at(-1)!;
    assert.equal(keyless.auth, null, "no install key sent");
    const hs = await hubState();
    assert.equal(hs?.url, mock.url);
    assert.match(hs?.installKey ?? "", /^key-fresh-/);
    assert.equal(mock.installs.get(hs!.installKey!)?.id, hs?.installId);
    assert.deepEqual([hs?.scope, hs?.cursor, hs?.orderCursor, hs?.partnerCursor], ["member", "0", null, "30"], "the partner feed carries on from the old install's place");
    await dropCompany(d.shopId);
    ok("import onto an install on no hub: the hub makes it an install, HubState written, the partner feed from the old place");

    // ---------- 5. the old install learns the company moved ----------
    const e = await company();
    await setHub(mock, "old");
    const eMove = await startMove(owner(e), e.shopId, { to: "the hosted service", agreed: true });
    const fileE = await download(e, eMove);
    // The new install (elsewhere) redeems the token.
    const r = await fetch(`${mock.url}/v1/shops/move`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-new" },
      body: JSON.stringify({ shopRef: e.shopId, token: fileE.meta.hub!.moveToken, shopName: e.name }),
    });
    assert.equal(r.status, 200);
    hubBack(mock);
    await syncHub();
    const eShop = await db.shop.findUniqueOrThrow({ where: { id: e.shopId } });
    assert.ok(eShop.movedOutAt && Date.now() - eShop.movedOutAt.getTime() < 60_000, "Shop.movedOutAt from the hub's answer");
    assert.equal(eShop.movedTo, "New PC", "the hub's name for the install it went to");
    assert.ok(eShop.movingAt, "still read-only");
    assert.ok(
      mock.calls.some((x) => x.path === "/v1/shops/claim" && x.body.shopRef === b.shopId),
      "the other companies were claimed as usual",
    );
    await expectError("the old copy refuses writes", () => requireBaseWritable(e.user), /^This company moved to New PC on .+\. This copy is read-only; delete it after .+\.$/);
    assert.equal((await moveRow(e.shopId, "export")).hubTokenSealed, null, "the token isn't kept any more");
    await expectError("a second move", () => startMove(owner(e), e.shopId, { agreed: true }), /already moved/);
    const claimsE = () => mock.calls.filter((x) => x.path === "/v1/shops/claim" && x.body.shopRef === e.shopId).length;
    const before = claimsE();
    await syncHub();
    assert.equal(claimsE(), before, "a company that moved isn't claimed again");
    ok("the old install's sync: 410 moved → movedOutAt and movedTo, still read-only with the moved notice; not claimed again");

    // ---------- 6. "The move is done" by hand (no hub) ----------
    const f = await company();
    await setHub(mock, "none");
    const callsBefore = mock.calls.length;
    const fMove = await startMove(owner(f), f.shopId, { agreed: true });
    assert.equal(mock.calls.length, callsBefore, "an install on no hub asks no hub");
    await expectError("before a download", () => confirmMovedOut(owner(f), f.shopId), /hasn't been downloaded/);
    const fileF = await download(f, fMove);
    assert.equal(fileF.meta.hub, null, "on no hub: no hub part");
    await expectError("tenant: B's owner", () => confirmMovedOut(owner(b), f.shopId), /^Company not found\.$/);
    await confirmMovedOut(owner(f), f.shopId);
    const fShop = await db.shop.findUniqueOrThrow({ where: { id: f.shopId } });
    assert.ok(fShop.movedOutAt && fShop.movingAt);
    await expectError("read-only, moved", () => requireBaseWritable(f.user), /^This company moved/);
    ok('"The move is done": only after a download, owner only; the same moved notice');

    // ---------- 7. the old copy deleted, 30 days on ----------
    await db.partnerSeen.create({ data: { shopId: e.shopId, key: `${linkId}:x:${RUN}:e` } });
    await db.partnerFailure.create({ data: { shopId: e.shopId, key: `${linkId}:y:${RUN}:e`, linkId, type: "job.update", data: {}, error: "test" } });
    await db.listing.create({
      data: { id: `chk-l-${RUN}`, shopId: e.shopId, shopName: e.name, title: "Old foot", priceCents: 100, qty: 1, status: "ACTIVE", photoIds: [], createdAt: new Date(), updatedAt: new Date() },
    });
    await db.marketOrder.create({ data: { id: `chk-o-${RUN}`, shopId: e.shopId, number: "SH-1", role: "seller", status: "PAID", data: {}, updatedAt: new Date() } });
    const later = new Date(eShop.movedOutAt!.getTime() + 31 * DAY);
    await expectError("before 30 days", () => deleteMovedCompany(admin, e.shopId, e.name), /can be deleted from/);
    await expectError("a company that didn't move", () => deleteMovedCompany(admin, b.shopId, b.name, later), /hasn't moved/);
    await expectError("not the administrator", () => deleteMovedCompany({ shopId: b.shopId, email: b.user.email }, e.shopId, e.name, later), /^Company not found\.$/);
    await expectError("the wrong name", () => deleteMovedCompany(admin, e.shopId, "not it", later), /Type the company's name/);
    await expectError("the administrator's own", () => deleteMovedCompany({ shopId: e.shopId, email: ADMIN }, e.shopId, e.name, later), /signed in to this company/);
    assert.deepEqual(await deleteMovedCompany(admin, e.shopId, ` ${e.name} `, later), { name: e.name });
    assert.equal(await db.shop.count({ where: { id: e.shopId } }), 0);
    for (const [what, n] of [
      ["PartnerSeen", await db.partnerSeen.count({ where: { shopId: e.shopId } })],
      ["PartnerFailure", await db.partnerFailure.count({ where: { shopId: e.shopId } })],
      ["Listing", await db.listing.count({ where: { shopId: e.shopId } })],
      ["MarketOrder", await db.marketOrder.count({ where: { shopId: e.shopId } })],
      ["CompanyMove", await db.companyMove.count({ where: { shopId: e.shopId } })],
    ] as const)
      assert.equal(n, 0, `${what} rows of the deleted company`);
    // The tray's door: the program's own one-use token for that company, on the PC itself.
    process.env.MOVE_LOCAL_SECRET = crypto.randomBytes(32).toString("base64url");
    await db.shop.update({ where: { id: f.shopId }, data: { movedOutAt: new Date(Date.now() - 31 * DAY) } });
    const post = (token: string | null, forwardedHost?: string) =>
      removeRoute(
        new Request("http://127.0.0.1:3100/api/move/remove", {
          method: "POST",
          headers: { "content-type": "application/json", ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}), ...(token ? { "x-move-token": token } : {}) },
          body: JSON.stringify({ shopId: f.shopId, name: f.name }),
        }),
      );
    assert.equal((await post(null)).status, 403, "no token");
    assert.equal((await post(moveToken(process.env.MOVE_LOCAL_SECRET, `remove:${b.shopId}`))).status, 403, "a token for another company");
    assert.equal((await post(moveToken(process.env.MOVE_LOCAL_SECRET, `remove:${f.shopId}`), "shop-pc.example:3100")).status, 403, "not addressed to the PC itself");
    const good = moveToken(process.env.MOVE_LOCAL_SECRET, `remove:${f.shopId}`);
    const res = await post(good);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(await db.shop.count({ where: { id: f.shopId } }), 0);
    assert.equal((await post(good)).status, 403, "a token is good once");
    ok("the old copy: refused before 30 days, unmoved, by others, with the wrong name, for the administrator's own; then deleted with its loose rows; the tray's door shut without its token");

    // ---------- 8. a cancel while the hub is down is told at the next sync ----------
    const g = await company();
    await setHub(mock, "old");
    await startMove(owner(g), g.shopId, { agreed: true });
    mock.down = true;
    await cancelMove(owner(g), g.shopId);
    assert.equal((await moveRow(g.shopId, "export")).hubError, MOVE_CANCEL_PENDING);
    hubBack(mock);
    await syncHub();
    assert.ok(
      mock.calls.some((x) => x.method === "DELETE" && x.path === `/v1/shops/${g.shopId}/move-token`),
      "the hub was told",
    );
    assert.equal((await moveRow(g.shopId, "export")).hubError, null);
    assert.ok(
      [...mock.tokens.values()].filter((t) => t.ref === g.shopId).every((t) => t.cancelled),
      "the token works no more",
    );
    ok("a cancel while the hub is down: the hub is told at the next sync");

    // ---------- 9. the hub down at the confirm ----------
    const h = await company();
    await setHub(mock, "old");
    mock.down = true;
    const hMove = await startMove(owner(h), h.shopId, { agreed: true });
    assert.ok((await db.shop.findUniqueOrThrow({ where: { id: h.shopId } })).movingAt, "the move goes on");
    const hRow = await moveRow(h.shopId, "export");
    assert.ok(hRow.hubError && !hRow.hubTokenSealed);
    const fileH = await download(h, hMove);
    assert.deepEqual(fileH.meta.hub, { url: mock.url, installId: "inst_old", moveToken: null, cursor: "10", orderCursor: "20", partnerCursor: "30" });
    assert.ok(
      fileH.meta.warnings.some((w) => /StitchHub couldn't give a move token/.test(w)),
      "the file says so",
    );
    assert.equal((await moveView(owner(h), h.shopId)).hub.hasToken, false);
    hubBack(mock);
    const fileH2 = await download(h, hMove);
    assert.match(fileH2.meta.hub?.moveToken ?? "", /^shm_/, "a later download gets one");
    assert.equal((await moveView(owner(h), h.shopId)).hub.error, null);
    ok("the hub down at the confirm: the move goes on, the file says it has no token; a later download gets one");

    // ---------- 10. another hub; a copy without the freeze ----------
    const i = await company();
    await setHub(mock, "old");
    const iMove = await startMove(owner(i), i.shopId, { agreed: true });
    const fileI = await download(i, iMove);
    await dropCompany(i.shopId);
    await setHub(mock, { url: "http://127.0.0.1:9", key: "key-x" });
    const movesBefore = mock.calls.filter((x) => x.path === "/v1/shops/move").length;
    const sumI = await importCompany(fileI.file, { by: "operator" });
    assert.equal(sumI.hub.status, "other-hub");
    assert.match(sumI.hub.message, /another hub/);
    assert.equal((await hubMoveView(i.shopId))?.canRetry, true, "the token is kept, for after joining that hub");
    await dropCompany(i.shopId);
    const j = await company();
    await setHub(mock, "old");
    const fileJ = await download(j, null);
    assert.equal(fileJ.meta.hub?.moveToken, null, "a copy carries no token");
    assert.ok(fileJ.meta.warnings.some((w) => /a copy, not a move/.test(w)));
    await dropCompany(j.shopId);
    await setHub(mock, "new");
    const sumJ = await importCompany(fileJ.file, { by: "operator" });
    assert.equal(sumJ.hub.status, "no-token");
    assert.match(sumJ.hub.message, /Move this shop/);
    assert.equal((await hubMoveView(j.shopId))?.canRetry, false);
    assert.equal(mock.calls.filter((x) => x.path === "/v1/shops/move").length, movesBefore, "neither asked the hub");
    await dropCompany(j.shopId);
    ok("another hub: refused and said, the token kept; a copy made without the freeze: no token, the admin's door said");

    // ---------- 11. tenant ----------
    const bView = await moveView(owner(b), b.shopId);
    assert.equal(bView.movedIn, null);
    assert.equal(bView.move, null);
    await expectError("B re-points A's (gone) company", () => repointHubFor(b.user, a.shopId), /^Company not found\.$/);
    assertUnchanged("company B", snapB, await snapshot(b.shopId, ["PartnerLink", "PartnerOutbox", "Customer", "Ticket"]));
    assert.deepEqual(await seenB(), seenBefore, "B applied none of the messages pulled for the others");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: b.shopId } })).movedOutAt, null);
    ok("tenant: B's rows unchanged through every move; B sees and reaches nothing of the others'");

    console.log(`move-hub.check: ${steps} groups passed (run ${RUN}; mock hub ${mock.url})`);
  } finally {
    if (savedAdmins === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = savedAdmins;
    if (savedSecret === undefined) delete process.env.MOVE_LOCAL_SECRET;
    else process.env.MOVE_LOCAL_SECRET = savedSecret;
    if (savedHub) {
      const { id: _id, ...data } = savedHub;
      void _id;
      await db.hubState.update({ where: { id: 1 }, data }).catch((e) => console.error("restoring HubState:", e));
    } else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    for (const s of savedShops) {
      const { id, ...fields } = s;
      await db.shop.updateMany({ where: { id }, data: Object.fromEntries(HUB_FIELDS.map((k) => [k, fields[k]])) }).catch(() => undefined);
    }
    for (const id of made) {
      await db.partnerSeen.deleteMany({ where: { shopId: id } }).catch(() => undefined);
      await db.partnerFailure.deleteMany({ where: { shopId: id } }).catch(() => undefined);
    }
    await cleanup();
    await mock.close();
    fs.rmSync(DIR, { recursive: true, force: true });
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
