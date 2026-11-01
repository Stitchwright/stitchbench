// Package hosted-provisioning (hub-accounts-billing-design.md 4.3.2, 4.3.4 and 4.4):
//   1. reset by email: the request answered, the mail through PLATFORM_SMTP_URL (the SMTP sink) with a /reset?t= link
//      on APP_URL, the link checked and used: the password set, sessionVersion + 1, only the hash kept
//   2. limits: 3 emails an hour to one address (more answered the same, not sent), 10 requests an hour from one address
//   3. an unknown or switched-off address answers the same and sends nothing
//   4. expired, used, replaced and wrong links refused; the passwords' rules
//   5. Windows and no mail: the tray words, the administrator's reset link from Companies (shown once through safe()),
//      nobody else's; the reset actions on the lapse allow-list; /reset and the platform route never on the links address
//   6. provisioning: POST /api/platform/companies off without a token of 32+ characters and on Windows, https only, a
//      missing or wrong token 401, wrong tokens limited per address, a company and its owner made ("Started from
//      StitchHub") with a 24-hour set-password link and no password, the hub's place answered, a reserved
//      email 409 (an address that owns another company is fine), nothing secret in the log
//   7. the hub's reset grant on the Windows program, with a mock hub and a throwaway key: not fetched until opted in (and
//      the claim says so), refused when the signature, company, install, life or owner is wrong, refused outside the
//      program's own window, allowed once in it (a new password shown once, sessionVersion + 1, the window known for
//      the owner's login again at the new version, the hub told), refused on request, refused after the opt-in went;
//      nothing verifies with the compiled keys while the hub1 line is a placeholder
//   8. tenant: company A's links, grants and the administrator's link never touch company B
//   npm run check scripts/checks/hosted-provisioning.check.ts
// Shares the dev database: throwaway companies "Check <run>" (removed at the end); the HubState row and the variables
// are put back as they were.
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { safe, shownOnce } from "@/lib/action";
import { isUserError } from "@/lib/user-error";
import { lapseUserFrom } from "@/lib/lapse-guard";
import { WHILE_LAPSED } from "@/lib/lapse-allow";
import { LICENSE_PUBLIC_KEYS } from "@/lib/license-keys";
import type { PublicKeys } from "@/lib/license";
import { linksHostDecision } from "@/lib/links-host";
import { hubState } from "@/lib/hub";
import { setResetOptInFor } from "@/lib/hub-account";
import { answerResetGrant, GRANT_CONTEXT, grantHash, grantKeysForChecks, inProgramWindow, pendingResetGrants, pullResetGrants, verifyResetGrant, WINDOW_HEADER } from "@/lib/hub-reset-grants";
import { knownDeviceCookieName, knownDeviceFor, knownDeviceValue, withKnownDevice } from "@/lib/known-device";
import { checkSignIn } from "@/lib/sign-in";
import { checkResetLink, finishReset, issueResetLink, ownerResetLinkFor, requestResetFor, resetByEmailProblem, SAME_ANSWER, tokenHash, TRAY_WORDS } from "@/lib/password-reset";
import { forgetWrongTokens, handlePlatformCompanies, platformToken } from "@/lib/platform-api";
import type { CurrentUser } from "@/lib/session";
import { gateDecision } from "../../desktop/links-gate.mjs";
import { checkShop, cleanup, withSink } from "./lib";
import { assertUnchanged, RUN, snapshot } from "./tenant";

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

const APP = "http://127.0.0.1:3999";
const ENV_KEYS = [
  "STITCH_DESKTOP",
  "STITCH_WINDOW_SECRET",
  "PLATFORM_SMTP_URL",
  "PLATFORM_MAIL_FROM",
  "PLATFORM_API_TOKEN",
  "PLATFORM_ADMIN_EMAILS",
  "APP_URL",
  "PUBLIC_URL",
  "PUBLIC_LINKS_ONLY",
  "RAILWAY_PUBLIC_DOMAIN",
  "TRUST_PROXY",
] as const;

/** The text of a message the sink kept, quoted-printable undone. */
const bodyOf = (raw: string) => raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const linkIn = (raw: string) => /(https?:\/\/\S+\/reset\?t=([A-Za-z0-9_-]{30,100}))/.exec(bodyOf(raw));

// ---------- the mock hub (reset grants and claims) ----------

type Mock = {
  url: string;
  grants: Map<string, { id: string; grant: string }[]>;
  asked: string[];
  done: { shopRef: string; id: string; body: Record<string, unknown> }[];
  claims: Record<string, unknown>[];
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
  const m = { grants: new Map(), asked: [], done: [], claims: [] } as unknown as Mock;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.headers.authorization !== "Bearer key-win") return send(401, { error: "Join the hub first." });
    if (p === "/v1/shops/claim" && req.method === "POST") {
      m.claims.push(await readJson(req));
      return send(200, { ok: true, standing: "trial" });
    }
    const list = /^\/v1\/shops\/([^/]+)\/reset-grants$/.exec(p);
    if (list && req.method === "GET") {
      m.asked.push(list[1]);
      return send(200, { grants: m.grants.get(list[1]) ?? [] });
    }
    const done = /^\/v1\/shops\/([^/]+)\/reset-grants\/([^/]+)\/done$/.exec(p);
    if (done && req.method === "POST") {
      m.done.push({ shopRef: done[1], id: done[2], body: await readJson(req) });
      return send(200, { ok: true });
    }
    return send(404, { error: "Not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  m.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  m.close = () => new Promise<void>((r) => server.close(() => r()));
  return m;
}

// ---------- main ----------

async function main() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const savedHub = await hubState();
  const sink = await withSink();
  const mock = await startMock();
  lapseUserFrom(async () => null);
  const logged: string[] = [];
  const realLog = { info: console.info, warn: console.warn, error: console.error };
  const capture = () => {
    for (const k of ["info", "warn", "error"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  };
  const release = () => Object.assign(console, realLog);
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PLATFORM_SMTP_URL = `smtp://check-user:check-pass@127.0.0.1:${sink.smtpPort}`;
    process.env.PLATFORM_MAIL_FROM = "accounts@stitchbench.test";
    process.env.APP_URL = APP;

    const a = await checkShop();
    const b = await checkShop();
    const userOf = (id: string) => db.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true, sessionVersion: true, email: true } });
    const mailsTo = (email: string) => sink.messages.filter((m: { to: string[] }) => m.to.includes(email));

    // ---------- 1. reset by email ----------
    assert.equal(resetByEmailProblem(), null, "mail and the address are set");
    const before = await userOf(a.user.id);
    const r1 = requestResetFor(` ${a.user.email.toUpperCase()} `, "198.51.100.1");
    assert.equal(r1.message, SAME_ANSWER);
    await r1.work;
    const sent = mailsTo(a.user.email);
    assert.equal(sent.length, 1, "one email to the owner");
    assert.match(sent[0].raw, /Subject: Reset your Stitch(Bench|Shop) password/);
    assert.match(sent[0].raw, /From: .*accounts@stitchbench\.test/);
    const found = linkIn(sent[0].raw);
    assert.ok(found, "the email carries the link");
    assert.ok(found[1].startsWith(`${APP}/reset?t=`), `the link is on APP_URL: ${found[1]}`);
    const token = found[2];
    assert.equal(await db.passwordReset.count({ where: { tokenHash: token } }), 0, "the token itself is never stored");
    const row = await db.passwordReset.findUniqueOrThrow({ where: { tokenHash: tokenHash(token) } });
    assert.equal(row.kind, "reset");
    const life = row.expiresAt.getTime() - row.createdAt.getTime();
    assert.ok(life > 59 * 60_000 && life <= 60 * 60_000 + 1000, `an hour (${life} ms)`);
    const state = await checkResetLink(token);
    assert.ok(state.ok && state.email === a.user.email && state.kind === "reset");
    const done = await finishReset(token, "New-pass-1234", "New-pass-1234");
    assert.equal(done.email, a.user.email);
    const after = await userOf(a.user.id);
    assert.ok(await bcrypt.compare("New-pass-1234", after.passwordHash), "the new password works");
    assert.equal(after.sessionVersion, before.sessionVersion + 1, "every session of that login ends");
    assert.ok((await db.passwordReset.findUniqueOrThrow({ where: { tokenHash: tokenHash(token) } })).usedAt);
    await expectError("a link works once", () => finishReset(token, "Other-pass-1234", "Other-pass-1234"), /used already/);
    ok("forgot your password: one email through PLATFORM_SMTP_URL, a link on APP_URL, used once, sessionVersion + 1, only the hash kept");

    // ---------- 2. limits ----------
    for (let i = 0; i < 3; i++) await requestResetFor(a.user.email, `198.51.100.${10 + i}`).work;
    assert.equal(mailsTo(a.user.email).length, 3, "3 emails an hour to one address");
    const quiet = requestResetFor(a.user.email, "198.51.100.20");
    assert.equal(quiet.message, SAME_ANSWER, "the fourth is answered the same");
    await quiet.work;
    assert.equal(mailsTo(a.user.email).length, 3, "and isn't sent");
    for (let i = 0; i < 10; i++) await requestResetFor(`nobody-${RUN}-${i}@stitchbench.test`, "198.51.100.99").work;
    await expectError("the 11th from one address", async () => requestResetFor(`nobody-${RUN}-x@stitchbench.test`, "198.51.100.99"), /Too many reset requests from here/);
    ok("limits: 3 emails an hour to one address (answered the same), 10 requests an hour from one address");

    // ---------- 3. unknown and switched-off addresses ----------
    const rows0 = await db.passwordReset.count();
    const unknown = requestResetFor(`nobody-${RUN}@stitchbench.test`, "198.51.100.30");
    assert.equal(unknown.message, SAME_ANSWER, "the same answer");
    await unknown.work;
    assert.equal(mailsTo(`nobody-${RUN}@stitchbench.test`).length, 0);
    const tech = await db.user.create({ data: { shopId: b.shopId, email: `check-${RUN}-off@stitchbench.test`, name: "Off", role: "TECH", passwordHash: "x", active: false }, select: { id: true } });
    const off = requestResetFor(`check-${RUN}-off@stitchbench.test`, "198.51.100.30");
    assert.equal(off.message, SAME_ANSWER);
    await off.work;
    assert.equal(mailsTo(`check-${RUN}-off@stitchbench.test`).length, 0, "a switched-off login gets nothing");
    assert.equal(await db.passwordReset.count(), rows0, "no link made for either");
    await expectError("not an email", async () => requestResetFor("not an email", null), /name@something/);
    ok("an unknown or switched-off address: the same answer, no email, no link");

    // ---------- 4. expired, used, replaced, wrong ----------
    const l1 = await issueResetLink(a.user.id, "reset", 1);
    const l2 = await issueResetLink(a.user.id, "reset", 1);
    const t1 = new URL(l1.link).searchParams.get("t")!;
    const t2 = new URL(l2.link).searchParams.get("t")!;
    const s1 = await checkResetLink(t1);
    assert.ok(!s1.ok && /newer one replaced it/.test(s1.reason), "a newer link cancels the older");
    await db.passwordReset.update({ where: { tokenHash: tokenHash(t2) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const s2 = await checkResetLink(t2);
    assert.ok(!s2.ok && /expired/.test(s2.reason));
    await expectError("an expired link", () => finishReset(t2, "New-pass-5678", "New-pass-5678"), /expired/);
    const s3 = await checkResetLink("x".repeat(43));
    assert.ok(!s3.ok && /isn't right/.test(s3.reason));
    assert.equal((await checkResetLink("short")).ok, false);
    const l3 = await issueResetLink(a.user.id, "reset", 1);
    const t3 = new URL(l3.link).searchParams.get("t")!;
    await expectError("short", () => finishReset(t3, "short", "short"), /at least 8/);
    await expectError("not the same", () => finishReset(t3, "Long-enough-1", "Long-enough-2"), /aren't the same/);
    await expectError("too long", () => finishReset(t3, "x".repeat(201), "x".repeat(201)), /too long/);
    assert.ok((await checkResetLink(t3)).ok, "a refused try doesn't use the link");
    ok("expired, used, replaced and wrong links refused; 8 to 200 characters, typed twice");

    // A reset the person asks for replaces only their own older reset links: an administrator's link and a 24-hour setup link stay.
    for (const kind of ["admin", "setup"] as const) {
      const other = await issueResetLink(a.user.id, kind, 24);
      const to = new URL(other.link).searchParams.get("t")!;
      const r1 = await issueResetLink(a.user.id, "reset", 1);
      const r2 = await issueResetLink(a.user.id, "reset", 1);
      const kept = await checkResetLink(to);
      assert.ok(kept.ok && kept.kind === kind, `a reset request leaves the ${kind} link working`);
      const old = await checkResetLink(new URL(r1.link).searchParams.get("t")!);
      assert.ok(!old.ok && /newer one replaced it/.test(old.reason), "the older reset link is replaced");
      assert.ok((await checkResetLink(new URL(r2.link).searchParams.get("t")!)).ok);
    }
    ok("a reset request voids only older reset links, not an administrator's link or a setup link");

    // ---------- 5. Windows, no mail, the administrator's link ----------
    process.env.STITCH_DESKTOP = "1";
    assert.equal(resetByEmailProblem(), TRAY_WORDS);
    await expectError("Windows", async () => requestResetFor(a.user.email, null), /Windows program/);
    assert.equal((await checkResetLink(t3)).ok, false, "no link works on the Windows program");
    await expectError("Windows link", () => finishReset(t3, "Long-enough-1", "Long-enough-1"), /Windows program/);
    delete process.env.STITCH_DESKTOP;
    delete process.env.PLATFORM_SMTP_URL;
    assert.match(resetByEmailProblem() ?? "", /PLATFORM_SMTP_URL/);
    await expectError("no mail", async () => requestResetFor(a.user.email, null), /administrator.*Companies/);
    const adminEmail = `check-${RUN}-platform@stitchbench.test`;
    process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
    const platformAdmin: CurrentUser = { id: "platform", shopId: a.shopId, role: "OWNER", name: "Admin", email: adminEmail };
    await expectError("an owner isn't the administrator", () => ownerResetLinkFor(a.user, b.shopId), /administrator/);
    const adminLink = await ownerResetLinkFor(platformAdmin, b.shopId);
    const ta = new URL(adminLink).searchParams.get("t")!;
    const sa = await checkResetLink(ta);
    assert.ok(sa.ok && sa.kind === "admin" && sa.email === b.user.email, "the link is for B's owner");
    // Through safe(): what shownOnce() made reaches the page; anything else an action returns doesn't.
    assert.deepEqual(await safe.whileLapsed("makeOwnerResetLink")(async () => shownOnce(adminLink))(), { ok: true, shown: adminLink });
    assert.deepEqual(await safe(async () => ({ note: "a row", shown: "not this" }))(), { ok: true });
    for (const name of ["requestPasswordReset", "finishPasswordReset", "makeOwnerResetLink", "allowHubReset", "refuseHubReset"]) {
      assert.ok((WHILE_LAPSED as readonly string[]).includes(name), `${name} works while lapsed`);
    }
    for (const [m, path] of [
      ["GET", "/reset"],
      ["POST", "/api/platform/companies"],
    ] as const) {
      assert.equal(linksHostDecision(m, path, new Headers()), "404", `${path} isn't on the public links address`);
      assert.equal(gateDecision(m, path, {}), "404", `${path} doesn't pass the Windows links gate`);
    }
    process.env.PLATFORM_SMTP_URL = `smtp://check-user:check-pass@127.0.0.1:${sink.smtpPort}`;
    ok("Windows: the tray; no mail: the administrator's reset link for an owner (shown once through safe()); the allow-list; not on the links address");

    // ---------- 6. provisioning ----------
    // This install on the (mock) hub: the answer names its place there. The sync a new company starts in the background
    // only reaches the mock.
    await db.hubState.upsert({
      where: { id: 1 },
      create: { id: 1, url: mock.url, hubName: "Mock hub", installId: "inst_win", installKey: "key-win", scope: "member" },
      update: { url: mock.url, hubName: "Mock hub", installId: "inst_win", installKey: "key-win", scope: "member", partnerLockUntil: null },
    });
    const TOKEN = `ptk_${crypto.randomBytes(30).toString("base64url")}`;
    const req = (o: { token?: string | null; body?: unknown; url?: string; headers?: Record<string, string> } = {}) =>
      new Request(o.url ?? "http://127.0.0.1:3999/api/platform/companies", {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
        body: typeof o.body === "string" ? o.body : JSON.stringify(o.body ?? {}),
      });
    const hostedEmail = `check-${RUN}-hosted@stitchbench.test`;
    const good = { shopName: `Check ${RUN} Hosted`, kind: "retail", ownerName: "Hosted Owner", ownerEmail: hostedEmail, timeZone: "America/Chicago", hubAccountId: "acct_check" };
    assert.equal((await handlePlatformCompanies(req({ token: TOKEN, body: good }))).status, 404, "no token set: no route");
    process.env.PLATFORM_API_TOKEN = "too-short-a-token";
    assert.equal(platformToken(), null);
    assert.equal((await handlePlatformCompanies(req({ token: "too-short-a-token", body: good }))).status, 404, "a short token: no route");
    process.env.PLATFORM_API_TOKEN = TOKEN;
    process.env.STITCH_DESKTOP = "1";
    assert.equal((await handlePlatformCompanies(req({ token: TOKEN, body: good }))).status, 404, "never on the Windows program");
    delete process.env.STITCH_DESKTOP;
    forgetWrongTokens();
    capture();
    try {
      assert.equal((await handlePlatformCompanies(req({ token: TOKEN, body: good, url: "http://stitchshop.example/api/platform/companies" }))).status, 403, "plain http to another machine");
      assert.equal((await handlePlatformCompanies(req({ body: good }))).status, 401, "no token");
      assert.equal((await handlePlatformCompanies(req({ token: `${TOKEN}x`, body: good }))).status, 401, "a wrong token");
      assert.equal((await handlePlatformCompanies(req({ token: TOKEN, body: "not json" }))).status, 400);
      assert.equal((await handlePlatformCompanies(req({ token: TOKEN, body: { ...good, kind: "zoo" } }))).status, 400);
      assert.equal((await handlePlatformCompanies(req({ token: TOKEN, body: { ...good, ownerEmail: "nope" } }))).status, 400);
      const made = await handlePlatformCompanies(req({ token: TOKEN, body: good, url: "https://stitchshop.example/api/platform/companies" }));
      const out = (await made.json()) as Record<string, unknown>;
      assert.equal(made.status, 201, JSON.stringify(out));
      assert.equal(out.password, undefined, "no password in the answer");
      const shop = await db.shop.findUniqueOrThrow({ where: { id: String(out.shopId) }, include: { users: true } });
      assert.equal(shop.name, good.shopName);
      assert.deepEqual([shop.sellsRetail, shop.doesRepair], [true, false], "a retail company");
      assert.ok(shop.startedFromHubAt, "Started from StitchHub");
      assert.deepEqual(
        shop.users.map((u) => [u.email, u.role]),
        [[hostedEmail, "OWNER"]],
      );
      const setup = String(out.setPasswordUrl);
      assert.ok(setup.startsWith(`${APP}/reset?t=`), setup);
      const ts = new URL(setup).searchParams.get("t")!;
      const ss = await checkResetLink(ts);
      assert.ok(ss.ok && ss.kind === "setup" && ss.email === hostedEmail);
      const setupLife = Date.parse(String(out.expiresAt)) - Date.now();
      assert.ok(setupLife > 23.9 * 3600_000 && setupLife <= 24 * 3600_000, "24 hours");
      assert.deepEqual(out.hub, { url: mock.url, installId: "inst_win" }, "this install's place on the hub");
      await finishReset(ts, "Hosted-pass-1", "Hosted-pass-1");
      assert.ok(await bcrypt.compare("Hosted-pass-1", (await db.user.findFirstOrThrow({ where: { email: hostedEmail } })).passwordHash), "the owner chose a password");
      const again = await handlePlatformCompanies(req({ token: TOKEN, body: { ...good, shopName: `Check ${RUN} Again` } }));
      // Round 3 W1: an email is unique inside one company, so an owner address used by another company is no longer a 409
      // (and no longer a way to find out which addresses exist elsewhere): it makes a second company with its own owner login.
      assert.equal(again.status, 201, "an address that owns another company is fine: the new company is its own");
      const firstShopId = (await db.user.findFirstOrThrow({ where: { email: hostedEmail }, orderBy: { createdAt: "asc" }, select: { shopId: true } })).shopId;
      assert.equal(await db.user.count({ where: { email: hostedEmail } }), 2);
      const reserved = await handlePlatformCompanies(req({ token: TOKEN, body: { ...good, shopName: `Check ${RUN} Reserved`, ownerEmail: adminEmail } }));
      assert.equal(reserved.status, 409, "never the administrator's address");
      assert.equal(await db.shop.count({ where: { name: `Check ${RUN} Reserved` } }), 0);
      // Wrong tokens from one address are limited (the right one too, from there, for the hour); other addresses carry on.
      process.env.TRUST_PROXY = "true";
      const from = (ip: string, token: string) => req({ token, body: good, headers: { "x-forwarded-for": ip } });
      for (let i = 0; i < 10; i++) assert.equal((await handlePlatformCompanies(from("203.0.113.7", "wrong-token"))).status, 401);
      assert.equal((await handlePlatformCompanies(from("203.0.113.7", TOKEN))).status, 429, "that address is held for the hour");
      assert.equal((await handlePlatformCompanies(from("203.0.113.8", TOKEN))).status, 201, "another address isn't (a company again, now that an owner address can repeat)");
      await db.shop.deleteMany({ where: { users: { some: { email: hostedEmail } }, id: { not: firstShopId } } });
      delete process.env.TRUST_PROXY;
      forgetWrongTokens();
      const text = logged.join("\n");
      assert.ok(text.includes(`[platform] company ${String(out.shopId)} (retail) made from StitchHub`), "the log names the company");
      assert.ok(!text.includes(TOKEN) && !text.includes(ts) && !text.includes("wrong-token"), "and never a token or the link");
    } finally {
      release();
    }
    ok(
      "provisioning: off without a token or on Windows, https only, 401 for a missing or wrong token (limited per address), a company and owner made with a 24-hour link and no password, 409 for a reserved email (an owner address used elsewhere is fine), nothing secret logged",
    );

    // ---------- 7. the hub's reset grant on the Windows program ----------
    const pair = crypto.generateKeyPairSync("ed25519");
    const other = crypto.generateKeyPairSync("ed25519");
    const keys: PublicKeys = { hubt: { x: (pair.publicKey.export({ format: "jwk" }) as { x: string }).x, scope: "hub" } };
    const sign = (p: Record<string, unknown>, key = pair.privateKey, context = GRANT_CONTEXT) => {
      const bytes = Buffer.from(JSON.stringify({ v: 1, k: "hubt", ...p }), "utf8");
      return `SBG1.${bytes.toString("base64url")}.${crypto.sign(null, Buffer.concat([Buffer.from(context, "utf8"), bytes]), key).toString("base64url")}`;
    };
    let n = 0;
    const grant = (o: Record<string, unknown> = {}, key?: crypto.KeyObject, context?: string) => {
      n += 1;
      const id = `grant${RUN}${n}`;
      const now = Date.now();
      const p = {
        id,
        shopRef: a.shopId,
        installId: "inst_win",
        email: a.user.email,
        nonce: crypto.randomBytes(24).toString("base64url"),
        iat: new Date(now).toISOString(),
        exp: new Date(now + 3600_000).toISOString(),
        ...o,
      };
      return { id: String(p.id), grant: sign(p, key, context), nonce: p.nonce as string };
    };
    // While the compiled hub1 line is a placeholder, nothing verifies.
    const g0 = grant();
    if (!Object.values(LICENSE_PUBLIC_KEYS).some((k) => k.scope === "hub")) assert.equal(verifyResetGrant(g0.grant).ok, false, "no compiled hub key: no grant verifies");
    assert.equal(verifyResetGrant(g0.grant, keys).ok, true);
    grantKeysForChecks(keys);
    const secret = crypto.randomBytes(32).toString("base64url");
    process.env.STITCH_WINDOW_SECRET = secret;
    const win = new Headers({ host: "localhost:3100", [WINDOW_HEADER]: secret });
    process.env.STITCH_DESKTOP = "1";
    const run = { installId: "inst_win" };

    // Not opted in: not even asked.
    mock.grants.set(a.shopId, [g0]);
    assert.equal(await pullResetGrants(run), 0);
    assert.ok(!mock.asked.includes(a.shopId), "the hub isn't asked for a company that doesn't allow it");
    assert.deepEqual(await pendingResetGrants(), []);
    await setResetOptInFor(a.user, true);
    assert.equal(mock.claims.at(-1)?.shopRef, a.shopId);
    assert.equal(mock.claims.at(-1)?.resetOptIn, true, "the claim tells the hub at once");
    ok("not fetched until the owner opts in on the PC; the claim says so");

    // Grants that don't count.
    const techA = await db.user.create({ data: { shopId: a.shopId, email: `check-${RUN}-techa@stitchbench.test`, name: "Tech A", role: "TECH", passwordHash: "x" }, select: { id: true } });
    const bad = [
      grant({}, other.privateKey), // another key
      grant({}, undefined, ""), // signed as a license would be (no context)
      grant({ installId: "inst_other" }), // another install
      grant({ shopRef: b.shopId }), // another company
      grant({ exp: new Date(Date.now() - 1000).toISOString() }), // expired
      grant({ exp: new Date(Date.now() + 3 * 3600_000).toISOString() }), // too long-lived
    ];
    const noOwner = grant({ email: `check-${RUN}-techa@stitchbench.test` }); // a login, but not the owner
    mock.grants.set(a.shopId, [...bad, noOwner]);
    assert.equal(await pullResetGrants(run), 0, "none of them counts");
    assert.deepEqual(
      mock.done.filter((d) => d.id === noOwner.id).map((d) => d.body),
      [{ result: "refused", why: "no-owner" }],
      "the hub hears that no owner login has that email",
    );
    assert.ok(!mock.done.some((d) => bad.some((x) => x.id === d.id)), "a grant that doesn't verify isn't answered");
    void techA;
    ok("refused: another key, a license-style signature, another install, another company, expired, too long, not the owner");

    // A good grant: shown only in the program's window, answered once there.
    const g = grant();
    mock.grants.set(a.shopId, [g]);
    assert.equal(await pullResetGrants(run), 1);
    assert.deepEqual(
      (await pendingResetGrants()).map((x) => [x.id, x.email, x.shopName]),
      [[g.id, a.user.email, a.name]],
    );
    const ownerBefore = await userOf(a.user.id);
    for (const [label, h] of [
      ["no window mark", new Headers({ host: "localhost:3100" })],
      ["a wrong mark", new Headers({ host: "localhost:3100", [WINDOW_HEADER]: "x".repeat(43) })],
      ["another device on the network", new Headers({ host: "192.168.1.20:3100", [WINDOW_HEADER]: secret })],
      ["through a proxy or tunnel", new Headers({ host: "localhost:3100", [WINDOW_HEADER]: secret, "x-forwarded-for": "203.0.113.9" })],
    ] as const) {
      assert.equal(inProgramWindow(h), false, label);
      await expectError(label, () => answerResetGrant(g.id, true, h), /program's own window/);
    }
    delete process.env.STITCH_DESKTOP;
    assert.equal(inProgramWindow(win), false, "the hosted service has no program window");
    process.env.STITCH_DESKTOP = "1";
    assert.equal(inProgramWindow(win), true);
    assert.deepEqual((await userOf(a.user.id)).passwordHash, ownerBefore.passwordHash, "nothing changed yet");
    const allowed = await answerResetGrant(g.id, true, win);
    const password = allowed?.password;
    assert.match(password ?? "", /^[a-km-zA-HJ-NP-Z2-9]{12}$/, "12 characters, none easily misread");
    const ownerAfter = await userOf(a.user.id);
    assert.ok(await bcrypt.compare(password!, ownerAfter.passwordHash), "the owner signs in with it");
    assert.equal(ownerAfter.sessionVersion, ownerBefore.sessionVersion + 1, "every device signed in as the owner signs in again");
    // The program's window had signed in as the owner before: the reset ends its standing like every other browser's,
    // and allowHubReset makes it known again for the login answered here, at the new sessionVersion (rememberThisDevice
    // sets knownDeviceValue's value), so the owner gets in there during a flood (as signin.check group 5 shows).
    assert.equal(allowed?.userId, a.user.id, "the owner's login comes back with the password");
    const windowBefore = withKnownDevice(null, a.user.id, Date.now() - 86_400_000, ownerBefore.sessionVersion);
    assert.ok(windowBefore, "AUTH_SECRET (from .env) is needed: the known-device cookie is keyed from it");
    assert.equal(knownDeviceFor(windowBefore, a.user.id, Date.now(), ownerAfter.sessionVersion), null, "the reset ends the window's standing too");
    const windowAfter = await knownDeviceValue(windowBefore, allowed!.userId);
    assert.ok(knownDeviceFor(windowAfter, a.user.id, Date.now(), ownerAfter.sessionVersion), "known again at the new sessionVersion");
    const fromWindow = new Request("http://localhost:3100/api/auth/callback/credentials", { method: "POST", headers: { cookie: `${knownDeviceCookieName()}=${encodeURIComponent(windowAfter!)}` } });
    assert.equal((await checkSignIn({ email: a.user.email, password }, fromWindow))?.id, a.user.id, "and signs in there with the new password");
    assert.equal((await db.passwordReset.findUniqueOrThrow({ where: { tokenHash: grantHash(g.nonce) } })).kind, "hub");
    assert.deepEqual(mock.done.at(-1), { shopRef: a.shopId, id: g.id, body: { result: "allowed" } }, "the hub is told");
    await expectError("used once", () => answerResetGrant(g.id, true, win), /expired or was answered/);
    // The hub lists it again (it missed the answer): not shown, and told again.
    const doneBefore = mock.done.length;
    assert.equal(await pullResetGrants(run), 0);
    assert.deepEqual(await pendingResetGrants(), []);
    assert.deepEqual(
      mock.done.slice(doneBefore).map((d) => [d.id, d.body.result]),
      [[g.id, "allowed"]],
    );
    ok("a good grant: refused outside the program's window, allowed once in it (12 characters, sessionVersion + 1, the window known for the owner again, the hub told), never again");

    // Refuse: nothing changes. The opt-in gone before the answer: refused.
    const gr = grant();
    mock.grants.set(a.shopId, [gr]);
    await pullResetGrants(run);
    assert.equal(await answerResetGrant(gr.id, false, win), null);
    assert.equal((await userOf(a.user.id)).passwordHash, ownerAfter.passwordHash, "refused: the password stays");
    assert.equal((await db.passwordReset.findUniqueOrThrow({ where: { tokenHash: grantHash(gr.nonce) } })).kind, "hub-refused");
    assert.deepEqual(mock.done.at(-1)?.body, { result: "refused" });
    const go = grant();
    mock.grants.set(a.shopId, [go]);
    await pullResetGrants(run);
    await db.shop.update({ where: { id: a.shopId }, data: { hubResetOptIn: false } });
    await expectError("opt-in gone", () => answerResetGrant(go.id, true, win), /doesn't allow a reset/);
    assert.equal((await userOf(a.user.id)).passwordHash, ownerAfter.passwordHash);
    ok("Refuse changes nothing; a grant whose company stopped allowing resets is refused");

    // ---------- 8. tenant ----------
    const snapB = await snapshot(b.shopId, ["Shop", "User"]);
    const bResets = await db.passwordReset.findMany({ where: { user: { shopId: b.shopId } }, orderBy: { id: "asc" } });
    await db.shop.update({ where: { id: a.shopId }, data: { hubResetOptIn: true } });
    const forB = grant({ shopRef: b.shopId, email: b.user.email });
    mock.grants.set(a.shopId, [forB]);
    assert.equal(await pullResetGrants(run), 0, "B's grant served under A is ignored");
    await expectError("B's grant id", () => answerResetGrant(forB.id, true, win), /expired or was answered/);
    delete process.env.STITCH_DESKTOP; // the links are the hosted service's
    const la = await issueResetLink(a.user.id, "reset", 1);
    await finishReset(new URL(la.link).searchParams.get("t"), "Tenant-pass-1", "Tenant-pass-1");
    await expectError("A's owner can't make B a link", () => ownerResetLinkFor(a.user, b.shopId), /administrator/);
    await requestResetFor(a.user.email, null).work;
    assertUnchanged("company B", snapB, await snapshot(b.shopId, ["Shop", "User"]));
    assert.deepEqual(await db.passwordReset.findMany({ where: { user: { shopId: b.shopId } }, orderBy: { id: "asc" } }), bResets, "B's links untouched");
    void tech;
    ok("tenant: A's links, grants and requests never touch company B");

    console.log(`hosted-provisioning.check: ${steps} steps passed (run ${RUN})`);
  } finally {
    release();
    grantKeysForChecks(null);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedHub) {
      const { id: _id, ...data } = savedHub;
      void _id;
      await db.hubState.update({ where: { id: 1 }, data }).catch((e) => console.error("restoring HubState:", e));
    } else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
    await db.user.deleteMany({ where: { email: `check-${RUN}-hosted@stitchbench.test` } }).catch(() => undefined);
    await cleanup();
    await mock.close();
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
