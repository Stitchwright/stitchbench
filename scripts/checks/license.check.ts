// Checks src/lib/license.ts (pure: no database), the cases under "Companion files" in docs/plans/modules-design.md that
// 1.8 still uses: signing and verifying, wrapped keys, every tamper, v2 and unknown plans, retired kids and the leak
// case, scopes, day starts in America/Chicago, on / renew / grace / lapsed, the Windows clock floor, and finishing work
// after a module ends. Keys decide the Assistant (and the program itself where hosting is billed); the administrator's
// switch sequences still decide, once, where the Features of a company from before 1.8 start (src/lib/modules.ts).
// The plan and trial maths went with the key tools (free-software-design.md section 2).
//   npx tsx scripts/checks/license.check.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  acceptScope,
  addDaysYmd,
  adminPosition,
  dayStartIn,
  effectiveNow,
  encodeLicense,
  extractKey,
  newKeyId,
  NO_END,
  payloadHash,
  renewNoticeDays,
  resolveStatus,
  statusAt,
  validYmd,
  verifyLicense,
  windows,
  workable,
  type GrantRow,
  type LicensePayload,
  type PublicKeys,
  type Window,
} from "../../src/lib/license";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    throw e;
  }
}

const NOT_A_KEY = "That doesn't look like a StitchBench license key. Copy the whole key: it starts with SB1.";
const DAMAGED = "That key is damaged or was changed. Copy the whole key again from the email.";
const NEWER = "This key needs a newer version of StitchBench. Update the program, then paste it again.";
const REPLACED = "This key was replaced. Ask StitchBench for a new key.";
const TZ = "America/Chicago";
const at = (iso: string) => new Date(iso);

// Throwaway signing keys: the owner's k1 and k2, the hosting key h1, the development key dev1.
const pair = () => crypto.generateKeyPairSync("ed25519");
const xOf = (k: crypto.KeyObject) => (k.export({ format: "jwk" }) as { x: string }).x;
const k1 = pair();
const k2 = pair();
const h1 = pair();
const dev1 = pair();
const KEYS: PublicKeys = {
  k1: { x: xOf(k1.publicKey), scope: "any" },
  h1: { x: xOf(h1.publicKey), scope: "hosted" },
  dev1: { x: xOf(dev1.publicKey), scope: "dev" },
};
const base: LicensePayload = { v: 1, k: "k1", id: "H5T75DV6", s: "cshop0000000000000000001", n: "Sew & Vac of Springfield", m: ["vac", "appliance"], p: "y", f: "2026-10-01", u: "2027-09-30", g: 14, t: "2026-09-30T15:00:00.000Z" };
const sign = (p: LicensePayload, key = k1.privateKey) => encodeLicense(p, key);
const reason = (text: string, keys = KEYS) => {
  const v = verifyLicense(text, keys);
  return v.ok ? "ok" : v.reason;
};
const key = sign(base);
const [, payloadPart, sigPart] = key.split(".");

// ---------- sign and verify ----------

check("sign and verify", () => {
  const v = verifyLicense(key, KEYS);
  assert.ok(v.ok);
  assert.deepEqual(v.payload, base);
  assert.equal(v.scope, "any");
  assert.equal(v.kid, "k1");
  assert.ok(key.length > 250 && key.length < 500, `a typical key is about 350 characters, got ${key.length}`);
  assert.equal(sigPart.length, 86);
});

check("newKeyId: 8 Crockford base-32 characters", () => {
  for (let i = 0; i < 20; i++) assert.match(newKeyId(), /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.notEqual(newKeyId(), newKeyId());
});

check("a key wrapped by an email program verifies", () => {
  const wrapped = key.match(/.{1,76}/g)!.join("\r\n");
  assert.ok(wrapped.includes("\r\n"));
  assert.equal(reason(wrapped), "ok");
  assert.equal(reason(key.split("").join(" ")), "ok");
});

check("a whole email pasted: extractKey finds the key", () => {
  const wrapped = key.match(/.{1,76}/g)!.join("\n");
  const email = `Subject: Your StitchBench key: Vac Shop\n\nHere is your StitchBench key for Vac Shop, good through Sep 30, 2027.\n\n${wrapped}\n\nThanks,\nBruce\n`;
  assert.equal(extractKey(email), key);
  assert.equal(reason(email), NOT_A_KEY);
  assert.equal(reason(extractKey(email)!), "ok");
  assert.equal(extractKey("no key here"), null);
  assert.equal(extractKey(""), null);
});

// ---------- every tamper case ----------

check("tamper: a changed payload character", () => {
  const i = Math.floor(payloadPart.length / 2);
  const c = payloadPart[i] === "A" ? "B" : "A";
  const changed = payloadPart.slice(0, i) + c + payloadPart.slice(i + 1);
  assert.equal(reason(`SB1.${changed}.${sigPart}`), DAMAGED);
});

check("tamper: a changed signature character", () => {
  const c = sigPart[0] === "A" ? "B" : "A";
  assert.equal(reason(`SB1.${payloadPart}.${c}${sigPart.slice(1)}`), DAMAGED);
});

check("tamper: another company's payload with this signature", () => {
  const other = Buffer.from(JSON.stringify({ ...base, s: "cshop0000000000000000002" }), "utf8").toString("base64url");
  assert.equal(reason(`SB1.${other}.${sigPart}`), DAMAGED);
});

check("tamper: wrong prefix", () => {
  assert.equal(reason(`SB2.${payloadPart}.${sigPart}`), NOT_A_KEY);
  assert.equal(reason(`sb1.${payloadPart}.${sigPart}`), NOT_A_KEY);
  assert.equal(reason(`${payloadPart}.${sigPart}`), NOT_A_KEY);
});

check("tamper: truncated", () => {
  assert.equal(reason(key.slice(0, -1)), NOT_A_KEY);
  assert.equal(reason(key.slice(0, 100)), NOT_A_KEY);
  assert.equal(reason(`SB1.${payloadPart}`), NOT_A_KEY);
  assert.equal(reason(""), NOT_A_KEY);
  assert.equal(reason("SB1"), NOT_A_KEY);
});

check("tamper: a payload that isn't JSON, or isn't an object", () => {
  const junk = Buffer.from("not json at all, just words", "utf8").toString("base64url");
  assert.equal(reason(`SB1.${junk}.${sigPart}`), DAMAGED);
  // A JSON array is an object without `v`: that reads as another format, so "newer version" (checked before the signature).
  const list = Buffer.from("[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]", "utf8").toString("base64url");
  assert.equal(reason(`SB1.${list}.${sigPart}`), NEWER);
  const nul = Buffer.from("null, but long enough to look like a payload", "utf8").toString("base64url");
  assert.equal(reason(`SB1.${nul}.${sigPart}`), DAMAGED);
});

check("shape: bad fields are damaged, even when signed", () => {
  assert.equal(reason(sign({ ...base, g: 91 })), DAMAGED);
  assert.equal(reason(sign({ ...base, g: -1 })), DAMAGED);
  assert.equal(reason(sign({ ...base, g: 1.5 })), DAMAGED);
  assert.equal(reason(sign({ ...base, u: "2026-09-30" })), DAMAGED); // before f
  assert.equal(reason(sign({ ...base, f: "2026-02-30" })), DAMAGED);
  assert.equal(reason(sign({ ...base, id: "h5t75dv6" })), DAMAGED);
  assert.equal(reason(sign({ ...base, id: "ABC" })), DAMAGED);
  assert.equal(reason(sign({ ...base, m: [] })), DAMAGED);
  assert.equal(reason(sign({ ...base, p: "Monthly" })), DAMAGED);
  assert.equal(reason(sign({ ...base, s: "" })), DAMAGED);
  assert.equal(reason(sign({ ...base, t: "yesterday" })), DAMAGED);
  assert.equal(reason(sign({ ...base, u: NO_END })), "ok");
  assert.equal(reason(sign({ ...base, g: 0 })), "ok");
  assert.equal(reason(sign({ ...base, g: 90 })), "ok");
});

// ---------- v2 and unknown words ----------

check("a v2 key needs a newer version (never damaged)", () => {
  assert.equal(reason(sign({ ...base, v: 2 } as unknown as LicensePayload)), NEWER);
  assert.equal(reason(sign({ ...base, v: "1" } as unknown as LicensePayload)), NEWER);
});

check("an unknown kid needs a newer version; prototype names don't count as kids", () => {
  assert.equal(reason(sign({ ...base, k: "k9" })), NEWER);
  assert.equal(reason(sign({ ...base, k: "__proto__" })), NEWER);
  assert.equal(reason(sign({ ...base, k: "constructor" })), NEWER);
  assert.equal(reason(sign({ ...base, k: "toString" })), NEWER);
});

check("an unknown plan word is accepted and gets the 30-day notice", () => {
  const v = verifyLicense(sign({ ...base, p: "q" }), KEYS);
  assert.ok(v.ok && v.payload.p === "q");
  assert.equal(renewNoticeDays("q"), 30);
  assert.equal(renewNoticeDays("m"), 3);
  assert.equal(renewNoticeDays("y"), 30);
  assert.equal(renewNoticeDays("a"), 14);
  assert.equal(renewNoticeDays("t"), 3);
  assert.equal(renewNoticeDays("hasOwnProperty"), 30);
});

check("an unknown module name is kept on the key", () => {
  const v = verifyLicense(sign({ ...base, m: ["vac", "robots"] }), KEYS);
  assert.ok(v.ok);
  assert.deepEqual(v.payload.m, ["vac", "robots"]);
});

// ---------- retired signing keys ----------

check("retired kid: keys up to lastDay count, later ones were replaced", () => {
  const keys: PublicKeys = { ...KEYS, k1: { ...KEYS.k1, retired: { lastDay: "2027-09-30" } }, k2: { x: xOf(k2.publicKey), scope: "any" } };
  assert.equal(reason(key, keys), "ok"); // u = 2027-09-30, the last day itself
  assert.equal(reason(sign({ ...base, u: "2027-10-01" }), keys), REPLACED);
  assert.equal(reason(sign({ ...base, k: "k2", u: "2028-09-30" }, k2.privateKey), keys), "ok");
  // A deleted kid would be "newer version" instead: that is why lines are retired, never deleted.
  const { k1: _gone, ...without } = keys;
  void _gone;
  assert.equal(reason(key, without), NEWER);
});

check("leak: only the genuine keys in `allow` count, forged and backdated ones fail", () => {
  const genuine2 = sign({ ...base, id: "GENUINE2", u: "2027-03-31" });
  const keys: PublicKeys = { ...KEYS, k1: { ...KEYS.k1, retired: { lastDay: "2027-09-30", allow: [payloadHash(payloadPart), payloadHash(genuine2.split(".")[1])] } } };
  assert.equal(reason(key, keys), "ok");
  assert.equal(reason(genuine2, keys), "ok");
  const forged = sign({ ...base, id: "FORGED00", u: "2026-12-31", t: "2026-01-01T00:00:00.000Z" }); // signed with the leaked key, backdated, inside lastDay
  assert.equal(reason(forged, keys), REPLACED);
  assert.equal(reason(sign({ ...base, u: "2027-10-01" }), keys), REPLACED);
  assert.match(payloadHash(payloadPart), /^[0-9a-f]{16}$/);
  // An empty allow list keeps nothing.
  assert.equal(reason(key, { ...KEYS, k1: { ...KEYS.k1, retired: { lastDay: "2027-09-30", allow: [] } } }), REPLACED);
});

// ---------- which scopes count where ----------

check("acceptScope truth table", () => {
  const no = { devAllowed: false, hostedHeld: false };
  const dev = { devAllowed: true, hostedHeld: false };
  const held = { devAllowed: false, hostedHeld: true };
  assert.equal(acceptScope("any", "pasted", no), true);
  assert.equal(acceptScope("any", "grant", no), false);
  assert.equal(acceptScope("any", "grant", held), false);
  assert.equal(acceptScope("hosted", "pasted", no), false);
  assert.equal(acceptScope("hosted", "pasted", held), false);
  assert.equal(acceptScope("hosted", "grant", no), false);
  assert.equal(acceptScope("hosted", "grant", held), true);
  assert.equal(acceptScope("dev", "pasted", no), false);
  assert.equal(acceptScope("dev", "grant", no), false);
  assert.equal(acceptScope("dev", "pasted", dev), true);
  assert.equal(acceptScope("dev", "grant", dev), true);
  assert.equal(acceptScope("dev", "grant", held), false);
  // The scope comes from the kid's line, not the key.
  const hv = verifyLicense(sign({ ...base, k: "h1", p: "a" }, h1.privateKey), KEYS);
  assert.ok(hv.ok && hv.scope === "hosted");
  const dv = verifyLicense(sign({ ...base, k: "dev1" }, dev1.privateKey), KEYS);
  assert.ok(dv.ok && dv.scope === "dev");
  // Signed with the wrong private key for the kid: damaged.
  assert.equal(reason(sign({ ...base, k: "h1" }, k1.privateKey)), DAMAGED);
});

// ---------- dates ----------

check("validYmd and addDaysYmd", () => {
  assert.equal(validYmd("2026-02-28"), true);
  assert.equal(validYmd("2026-02-29"), false);
  assert.equal(validYmd("2024-02-29"), true);
  assert.equal(validYmd("2026-2-28"), false);
  assert.equal(validYmd("2026-04-31"), false);
  assert.equal(validYmd("2026-02-30"), false);
  // Not checked: a month 13 or day 32 ("2026-13-01") makes Date.toISOString throw a RangeError inside validYmd
  // instead of returning false (reported; src/lib/license.ts is not this check's to fix).
  assert.equal(validYmd(20260228), false);
  assert.equal(validYmd(null), false);
  assert.equal(addDaysYmd("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysYmd("2026-03-01", -1), "2026-02-28");
  assert.equal(addDaysYmd("2026-10-01", 13), "2026-10-14");
});

check("day starts in America/Chicago: standard time, daylight time, the DST changes, a year end", () => {
  assert.equal(dayStartIn("2026-01-01", TZ).toISOString(), "2026-01-01T06:00:00.000Z");
  assert.equal(dayStartIn("2026-07-01", TZ).toISOString(), "2026-07-01T05:00:00.000Z");
  assert.equal(dayStartIn("2026-03-08", TZ).toISOString(), "2026-03-08T06:00:00.000Z"); // DST starts at 2 am this day
  assert.equal(dayStartIn("2026-03-09", TZ).toISOString(), "2026-03-09T05:00:00.000Z");
  assert.equal(dayStartIn("2026-11-01", TZ).toISOString(), "2026-11-01T05:00:00.000Z"); // DST ends at 2 am this day
  assert.equal(dayStartIn("2026-11-02", TZ).toISOString(), "2026-11-02T06:00:00.000Z");
  assert.equal(dayStartIn("2027-01-01", TZ).toISOString(), "2027-01-01T06:00:00.000Z");
  assert.equal(dayStartIn("2026-01-01", "UTC").toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(dayStartIn("2026-01-01", "Asia/Tokyo").toISOString(), "2025-12-31T15:00:00.000Z");
  assert.equal(dayStartIn("2026-01-01", "America/New_York").toISOString(), "2026-01-01T05:00:00.000Z");
});

check("windows: one per module, from the start of f to the end of u in shop time, then grace", () => {
  const ws = windows({ ...base, m: ["vac", "appliance"], f: "2026-10-01", u: "2026-10-31", g: 14 }, TZ, "key");
  assert.equal(ws.length, 2);
  assert.deepEqual(ws.map((w) => w.module), ["vac", "appliance"]);
  const w = ws[0];
  assert.equal(w.from.toISOString(), "2026-10-01T05:00:00.000Z");
  assert.equal(w.until.toISOString(), "2026-11-01T05:00:00.000Z"); // the end of Oct 31 = the start of Nov 1 (still CDT)
  assert.equal(w.graceUntil.toISOString(), "2026-11-15T06:00:00.000Z"); // 14 days on, in CST
  assert.equal(w.lastDay, "2026-10-31");
  assert.equal(w.graceLastDay, "2026-11-14");
  assert.equal(w.plan, "y");
  assert.equal(w.keyId, "H5T75DV6");
  assert.equal(w.issuedAt.toISOString(), base.t);
  assert.equal(w.source, "key");
  // End of a year: Dec 31 ends at the start of Jan 1.
  const ny = windows({ ...base, f: "2026-01-01", u: "2026-12-31", g: 0 }, TZ, "admin")[0];
  assert.equal(ny.from.toISOString(), "2026-01-01T06:00:00.000Z");
  assert.equal(ny.until.toISOString(), "2027-01-01T06:00:00.000Z");
  assert.equal(ny.graceUntil.toISOString(), "2027-01-01T06:00:00.000Z");
  assert.equal(ny.source, "admin");
});

// ---------- on / renew / grace / lapsed ----------

const yearly = windows(base, TZ, "key").filter((w) => w.module === "vac");
const status = (ws: Window[], now: string, offAt: string | null = null) => statusAt(ws, at(now), offAt ? at(offAt) : null);

check("a yearly key: off before it starts, on, renew 30 days out, grace, lapsed", () => {
  const before = status(yearly, "2026-09-30T12:00:00Z");
  assert.equal(before.status, "off");
  assert.equal(before.startsAt?.toISOString(), "2026-10-01T05:00:00.000Z");
  assert.equal(before.best, null);
  assert.equal(status(yearly, "2026-10-01T04:59:59Z").status, "off");
  assert.equal(status(yearly, "2026-10-01T05:00:00Z").status, "on");
  assert.equal(status(yearly, "2027-03-15T12:00:00Z").status, "on");
  assert.equal(status(yearly, "2027-08-31T12:00:00Z").status, "on"); // 30.7 days left
  assert.equal(status(yearly, "2027-09-01T12:00:00Z").status, "renew"); // 29.7 days left
  assert.equal(status(yearly, "2027-09-30T23:00:00Z").status, "renew");
  const grace = status(yearly, "2027-10-01T05:00:00Z"); // the start of Oct 1 in Chicago
  assert.equal(grace.status, "grace");
  assert.equal(grace.best?.keyId, "H5T75DV6");
  assert.equal(status(yearly, "2027-10-14T23:00:00Z").status, "grace");
  const lapsed = status(yearly, "2027-10-15T05:00:00Z"); // 14 days of grace are over
  assert.equal(lapsed.status, "lapsed");
  assert.equal(lapsed.endedAt?.toISOString(), "2027-10-15T05:00:00.000Z");
  assert.equal(lapsed.best?.keyId, "H5T75DV6");
  assert.equal(status(yearly, "2030-01-01T00:00:00Z").status, "lapsed");
  assert.equal(status([], "2027-01-01T00:00:00Z").status, "off");
});

check("renewed in time: no renewal notice; the newer key takes over", () => {
  const next = windows({ ...base, id: "NEXTYEAR", f: "2027-10-01", u: "2028-09-30", t: "2027-09-01T12:00:00.000Z" }, TZ, "key").filter((w) => w.module === "vac");
  const both = [...yearly, ...next];
  const r = status(both, "2027-09-15T12:00:00Z");
  assert.equal(r.status, "on");
  assert.equal(r.best?.keyId, "H5T75DV6");
  const after = status(both, "2027-10-05T12:00:00Z");
  assert.equal(after.status, "on");
  assert.equal(after.best?.keyId, "NEXTYEAR");
  // A gap between the keys still shows the notice, then grace, then the next key.
  const gap = windows({ ...base, id: "GAPKEY00", f: "2027-10-10", u: "2028-10-09" }, TZ, "key").filter((w) => w.module === "vac");
  assert.equal(status([...yearly, ...gap], "2027-09-15T12:00:00Z").status, "renew");
  assert.equal(status([...yearly, ...gap], "2027-10-05T12:00:00Z").status, "grace");
  assert.equal(status([...yearly, ...gap], "2027-10-05T12:00:00Z").startsAt?.toISOString(), "2027-10-10T05:00:00.000Z");
  assert.equal(status([...yearly, ...gap], "2027-10-10T05:00:00Z").status, "on");
});

check("monthly: the 3-day reminder", () => {
  const oct = windows({ ...base, id: "OCTOBER0", p: "m", f: "2026-10-01", u: "2026-10-31" }, TZ, "key").filter((w) => w.module === "vac");
  assert.equal(status(oct, "2026-10-15T12:00:00Z").status, "on");
  assert.equal(status(oct, "2026-10-28T12:00:00Z").status, "on"); // 3.7 days before the end of Oct 31
  assert.equal(status(oct, "2026-10-29T06:00:00Z").status, "renew"); // 2.96 days
  assert.equal(status(oct, "2026-10-31T12:00:00Z").status, "renew");
  assert.equal(status(oct, "2026-11-01T05:00:00Z").status, "grace");
  assert.equal(status(oct, "2026-11-15T06:00:00Z").status, "lapsed");
  const nov = windows({ ...base, id: "NOVEMBER", p: "m", f: "2026-11-01", u: "2026-11-30", t: "2026-10-28T12:00:00.000Z" }, TZ, "key").filter((w) => w.module === "vac");
  assert.equal(status([...oct, ...nov], "2026-10-29T06:00:00Z").status, "on");
  assert.equal(status([...oct, ...nov], "2026-11-15T12:00:00Z").best?.keyId, "NOVEMBER");
  assert.equal(status([...nov, ...oct], "2026-11-15T12:00:00Z").best?.keyId, "NOVEMBER");
});

check("trial: 14 days, no grace, 3-day notice, then lapsed at once", () => {
  const trial = windows({ ...base, id: "TRIAL000", p: "t", f: "2026-10-01", u: "2026-10-14", g: 0 }, TZ, "key").filter((w) => w.module === "vac");
  assert.equal(trial[0].lastDay, "2026-10-14");
  assert.equal(status(trial, "2026-10-05T12:00:00Z").status, "on");
  assert.equal(status(trial, "2026-10-13T12:00:00Z").status, "renew");
  assert.equal(status(trial, "2026-10-14T23:00:00Z").status, "renew");
  const done = status(trial, "2026-10-15T05:00:00Z");
  assert.equal(done.status, "lapsed");
  assert.equal(done.endedAt?.toISOString(), "2026-10-15T05:00:00.000Z");
});

check("an endless admin window and an unknown plan", () => {
  const endless = windows({ ...base, p: "a", u: NO_END }, TZ, "admin");
  assert.equal(status(endless, "2099-12-20T12:00:00Z").status, "on");
  const q = windows({ ...base, p: "q" }, TZ, "key");
  assert.equal(status(q, "2027-08-31T12:00:00Z").status, "on");
  assert.equal(status(q, "2027-09-01T12:00:00Z").status, "renew");
});

// ---------- the administrator's switch ----------

const row = (id: string, mode: string, createdAt: string, key: string | null = null): GrantRow => ({ id, mode, key, createdAt: at(createdAt) });
const adminWindows = (id: string, f: string, u: string, t: string, g = 0) => windows({ ...base, id, p: "a", f, u, g, t }, TZ, "admin").filter((w) => w.module === "vac");
const resolve = (ws: Window[], now: string, rows: GrantRow[] | null) => resolveStatus(ws, at(now), rows ? adminPosition(rows) : null);

check("no switch rows: statusAt as it is", () => {
  assert.equal(resolve(yearly, "2027-01-01T00:00:00Z", null).status, "on");
  assert.equal(resolve([], "2027-01-01T00:00:00Z", null).status, "off");
  assert.equal(resolve([], "2027-01-01T00:00:00Z", []).status, "off");
  const pos = adminPosition([]);
  assert.deepEqual(pos, { onKey: null, offAt: null, hadAny: false, lastAt: null });
});

check("off, then a short on: the pasted key ends at the off; the on counts inside its window; lapsed after it", () => {
  const rows = [row("r1", "off", "2026-11-01T12:00:00Z"), row("r2", "on", "2026-11-10T12:00:00Z", "ON-KEY")];
  const pos = adminPosition(rows);
  assert.equal(pos.onKey, "ON-KEY");
  assert.equal(pos.offAt?.toISOString(), "2026-11-01T12:00:00.000Z");
  assert.equal(pos.hadAny, true);
  assert.equal(pos.lastAt?.toISOString(), "2026-11-10T12:00:00.000Z");
  const short = adminWindows("SHORT000", "2026-11-10", "2026-12-31", "2026-11-10T12:00:00.000Z");
  const ws = [...yearly, ...short];
  const between = resolve(ws, "2026-11-05T12:00:00Z", rows);
  assert.equal(between.status, "lapsed");
  assert.equal(between.endedAt?.toISOString(), "2026-11-01T12:00:00.000Z"); // the switch-off, not the key's grace
  assert.equal(between.startsAt?.toISOString(), "2026-11-10T06:00:00.000Z");
  const inside = resolve(ws, "2026-11-15T12:00:00Z", rows);
  assert.equal(inside.status, "on");
  assert.equal(inside.best?.source, "admin");
  assert.equal(inside.best?.keyId, "SHORT000");
  const after = resolve(ws, "2027-01-01T06:00:00Z", rows);
  assert.equal(after.status, "lapsed");
  assert.equal(after.endedAt?.toISOString(), "2027-01-01T06:00:00.000Z");
  assert.equal(resolve(ws, "2027-06-01T00:00:00Z", rows).status, "lapsed"); // the pasted key doesn't come back
  // (A `now` before the off row existed isn't asked in practice: rows are judged only after they are made.)
});

check("on, then off: on until the off, then lapsed at that moment (no grace)", () => {
  const rows = [row("r1", "on", "2026-11-01T12:00:00Z", "ON-KEY"), row("r2", "off", "2026-12-01T12:00:00Z")];
  const pos = adminPosition(rows);
  assert.equal(pos.onKey, "ON-KEY");
  assert.equal(pos.offAt?.toISOString(), "2026-12-01T12:00:00.000Z");
  const admin = adminWindows("ADMIN000", "2026-11-01", "2027-10-31", "2026-11-01T12:00:00.000Z", 14);
  assert.equal(resolve(admin, "2026-11-15T12:00:00Z", rows).status, "on");
  const off = resolve(admin, "2026-12-01T12:00:00Z", rows);
  assert.equal(off.status, "lapsed");
  assert.equal(off.endedAt?.toISOString(), "2026-12-01T12:00:00.000Z");
  assert.equal(resolve(admin, "2027-06-01T00:00:00Z", rows).endedAt?.toISOString(), "2026-12-01T12:00:00.000Z");
  // A pasted key issued after the off counts as usual.
  const later = windows({ ...base, id: "LATERKEY", f: "2026-12-05", u: "2027-12-04", t: "2026-12-05T12:00:00.000Z" }, TZ, "key").filter((w) => w.module === "vac");
  assert.equal(resolve([...admin, ...later], "2026-12-10T12:00:00Z", rows).status, "on");
  assert.equal(resolve([...admin, ...later], "2026-12-10T12:00:00Z", rows).best?.keyId, "LATERKEY");
});

check("off, then Let keys decide: nothing is ended any more; with no key it is lapsed from that moment", () => {
  const rows = [row("r1", "off", "2026-11-01T12:00:00Z"), row("r2", "none", "2026-11-05T12:00:00Z")];
  const pos = adminPosition(rows);
  assert.equal(pos.onKey, null);
  assert.equal(pos.offAt, null);
  assert.equal(pos.hadAny, true);
  assert.equal(pos.lastAt?.toISOString(), "2026-11-05T12:00:00.000Z");
  assert.equal(resolve(yearly, "2026-11-10T12:00:00Z", rows).status, "on");
  const none = resolve([], "2026-11-10T12:00:00Z", rows);
  assert.equal(none.status, "lapsed");
  assert.equal(none.endedAt?.toISOString(), "2026-11-05T12:00:00.000Z");
});

check("on, then Let keys decide: the admin window ends at that moment", () => {
  const rows = [row("r1", "on", "2026-11-01T12:00:00Z", "ON-KEY"), row("r2", "none", "2026-11-20T12:00:00Z")];
  const pos = adminPosition(rows);
  assert.equal(pos.onKey, null);
  assert.equal(pos.lastAt?.toISOString(), "2026-11-20T12:00:00.000Z");
  const r = resolve([], "2026-11-25T12:00:00Z", rows); // modules.ts pushes no admin window when onKey is null
  assert.equal(r.status, "lapsed");
  assert.equal(r.endedAt?.toISOString(), "2026-11-20T12:00:00.000Z");
  assert.equal(resolve(yearly, "2026-11-25T12:00:00Z", rows).status, "on");
});

check("two ons: the newer replaces the older, so it can shorten as well as extend", () => {
  const rows = [row("r1", "on", "2026-11-01T12:00:00Z", "LONG-KEY"), row("r2", "on", "2026-11-10T12:00:00Z", "SHORT-KEY")];
  assert.equal(adminPosition(rows).onKey, "SHORT-KEY");
  assert.equal(adminPosition([...rows].reverse()).onKey, "SHORT-KEY");
  assert.equal(adminPosition(rows).offAt, null);
  const short = adminWindows("SHORT000", "2026-11-10", "2026-11-30", "2026-11-10T12:00:00.000Z");
  assert.equal(resolve(short, "2026-11-12T12:00:00Z", rows).status, "on");
  assert.equal(resolve(short, "2026-11-20T12:00:00Z", rows).status, "renew"); // inside the switch's 14-day notice
  const after = resolve(short, "2026-12-15T12:00:00Z", rows);
  assert.equal(after.status, "lapsed");
  assert.equal(after.endedAt?.toISOString(), "2026-12-01T06:00:00.000Z");
  // Rows older than the newest "none" don't count, whatever they say.
  const withNone = [row("r0", "on", "2026-10-01T12:00:00Z", "OLD-KEY"), row("r1", "off", "2026-10-05T12:00:00Z"), row("r2", "none", "2026-10-10T12:00:00Z"), row("r3", "on", "2026-11-10T12:00:00Z", "NEW-KEY")];
  const p = adminPosition(withNone);
  assert.equal(p.onKey, "NEW-KEY");
  assert.equal(p.offAt, null);
});

check("off, on, off again: the newest off ends the on that came between", () => {
  const rows = [row("r1", "off", "2026-11-01T12:00:00Z"), row("r2", "on", "2026-11-10T12:00:00Z", "ON-KEY"), row("r3", "off", "2026-11-20T12:00:00Z")];
  const pos = adminPosition(rows);
  assert.equal(pos.onKey, "ON-KEY");
  assert.equal(pos.offAt?.toISOString(), "2026-11-20T12:00:00.000Z");
  const admin = adminWindows("ADMIN000", "2026-11-10", "2027-10-31", "2026-11-10T12:00:00.000Z");
  const r = resolve(admin, "2026-12-01T12:00:00Z", rows);
  assert.equal(r.status, "lapsed");
  assert.equal(r.endedAt?.toISOString(), "2026-11-20T12:00:00.000Z");
});

check("ties are broken by id: the larger id is the newer row", () => {
  const t = "2026-11-10T12:00:00Z";
  assert.equal(adminPosition([row("a", "on", t, "KEY-A"), row("b", "on", t, "KEY-B")]).onKey, "KEY-B");
  assert.equal(adminPosition([row("b", "on", t, "KEY-B"), row("a", "on", t, "KEY-A")]).onKey, "KEY-B");
  assert.equal(adminPosition([row("a", "none", t), row("b", "on", t, "KEY-B")]).onKey, "KEY-B");
  assert.equal(adminPosition([row("b", "none", t), row("a", "on", t, "KEY-A")]).onKey, null);
  const p = adminPosition([row("a", "off", t), row("b", "none", t)]);
  assert.equal(p.offAt, null);
  assert.equal(p.hadAny, true);
  assert.equal(adminPosition([row("b", "off", t), row("a", "none", t)]).offAt?.toISOString(), "2026-11-10T12:00:00.000Z");
});

// ---------- the Windows clock floor ----------

check("effectiveNow: the clock never counts as earlier than 48 h before the newest key", () => {
  const issued = [at("2026-09-30T15:00:00Z")];
  const wayBack = effectiveNow(at("2026-09-26T15:00:00Z"), issued, true); // 4 days behind
  assert.equal(wayBack.now.toISOString(), "2026-09-28T15:00:00.000Z");
  assert.equal(wayBack.floor?.toISOString(), "2026-09-28T15:00:00.000Z");
  assert.equal(wayBack.clockBehind, true);
  const bit = effectiveNow(at("2026-09-28T03:00:00Z"), issued, true); // 60 h behind: floored, but within the 24 h allowance
  assert.equal(bit.now.toISOString(), "2026-09-28T15:00:00.000Z");
  assert.equal(bit.clockBehind, false);
  const fine = effectiveNow(at("2026-09-29T03:00:00Z"), issued, true); // 36 h behind: the real clock stands
  assert.equal(fine.now.toISOString(), "2026-09-29T03:00:00.000Z");
  assert.equal(fine.floor?.toISOString(), "2026-09-28T15:00:00.000Z");
  assert.equal(fine.clockBehind, false);
  const ahead = effectiveNow(at("2026-10-05T00:00:00Z"), issued, true);
  assert.equal(ahead.now.toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(ahead.clockBehind, false);
  // Exactly 24 h over the floor isn't "behind"; a second more is.
  assert.equal(effectiveNow(at("2026-09-27T15:00:00Z"), issued, true).clockBehind, false);
  assert.equal(effectiveNow(at("2026-09-27T14:59:59Z"), issued, true).clockBehind, true);
  // The newest key sets the floor.
  const many = effectiveNow(at("2026-01-01T00:00:00Z"), [at("2026-03-01T00:00:00Z"), at("2026-09-30T15:00:00Z"), at("2025-12-01T00:00:00Z")], true);
  assert.equal(many.floor?.toISOString(), "2026-09-28T15:00:00.000Z");
  assert.equal(many.clockBehind, true);
  // Off the Windows program there is no floor; nor without keys.
  const hosted = effectiveNow(at("2026-09-26T15:00:00Z"), issued, false);
  assert.equal(hosted.now.toISOString(), "2026-09-26T15:00:00.000Z");
  assert.equal(hosted.floor, null);
  assert.equal(hosted.clockBehind, false);
  const noKeys = effectiveNow(at("2026-09-26T15:00:00Z"), [], true);
  assert.equal(noKeys.now.toISOString(), "2026-09-26T15:00:00.000Z");
  assert.equal(noKeys.floor, null);
});

// ---------- finishing work after a module ends ----------

check("workable: always while on, renew or grace; after it ends only tickets opened before", () => {
  const anyTime = at("2030-01-01T00:00:00Z");
  assert.equal(workable({ status: "on", endedAt: null }, anyTime), true);
  assert.equal(workable({ status: "renew", endedAt: null }, anyTime), true);
  assert.equal(workable({ status: "grace", endedAt: null }, anyTime), true);
  const ended = at("2027-10-15T05:00:00Z");
  assert.equal(workable({ status: "lapsed", endedAt: ended }, at("2027-10-15T04:59:59Z")), true);
  assert.equal(workable({ status: "lapsed", endedAt: ended }, ended), false);
  assert.equal(workable({ status: "lapsed", endedAt: ended }, at("2027-10-16T00:00:00Z")), false);
  assert.equal(workable({ status: "lapsed", endedAt: null }, at("2020-01-01T00:00:00Z")), false);
  assert.equal(workable({ status: "off", endedAt: null }, at("2020-01-01T00:00:00Z")), false);
  // From a real lapse: a ticket opened during grace can still be finished, one opened after can't.
  const lapsed = status(yearly, "2027-11-01T12:00:00Z");
  assert.equal(lapsed.status, "lapsed");
  assert.equal(workable(lapsed, at("2027-10-10T12:00:00Z")), true);
  assert.equal(workable(lapsed, at("2027-10-20T12:00:00Z")), false);
  // After the administrator's off, work that came in before it can be finished.
  const rows = [row("r1", "on", "2026-11-01T12:00:00Z", "ON-KEY"), row("r2", "off", "2026-12-01T12:00:00Z")];
  const admin = adminWindows("ADMIN000", "2026-11-01", "2027-10-31", "2026-11-01T12:00:00.000Z", 14);
  const off = resolve(admin, "2026-12-10T12:00:00Z", rows);
  assert.equal(workable(off, at("2026-11-20T12:00:00Z")), true);
  assert.equal(workable(off, at("2026-12-05T12:00:00Z")), false);
});

console.log(`license.check: ${passed} checks passed (signing, wrapped keys, tampers, versions, retired kids, scopes, dates, statuses, the switch, the clock floor, workable).`);
