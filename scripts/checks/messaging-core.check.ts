// The messaging core's pure functions (scheduling-messaging-design.md section 16.2, scheduling-foundation acceptance
// item 3). No database, no network: phone and email tables, quiet hours, zoned time, the consent gate, sealed secrets,
// templates, finalize and the ticket status dates.
//   npm run check scripts/checks/messaging-core.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { TicketStatus } from "@/generated/prisma/enums";
import { isUserError } from "@/lib/action";
import { SKIP_REASON_LABEL } from "@/lib/constants";
import { allowed, type ConsentCustomer, type SupMap } from "@/lib/messaging/consent";
import { nextTextTime, type QuietRules } from "@/lib/messaging/quiet";
import { finalize } from "@/lib/messaging/queue";
import { seal, unseal } from "@/lib/messaging/secrets";
import { consentCode, consentWording } from "@/lib/messaging/settings";
import { checkTemplate, cleanSubject, cleanText, DEFAULT_TEMPLATES, firstName, FIELDS, plainText, render, renderKind, smsParts, templateFor, textToHtml } from "@/lib/messaging/templates";
import type { SkipReason } from "@/lib/messaging/types";
import { MAINLAND_ZONES, recipientZones, toE164, usMarketingNumber, validEmail } from "@/lib/phone";
import { statusData, type TicketForStatus } from "@/lib/ticket-status";
import { addDays, dayStart, ymdOf, zonedTime } from "@/lib/zoned";

let steps = 0;
const ok = (label: string) => {
  steps += 1;
  console.log(`  ok  ${label}`);
};

const NY = "America/New_York";
const iso = (d: Date) => d.toISOString();
const RULES: QuietRules = { quietStart: 540, quietEnd: 1200, noSundayMarketing: true };

function phoneAndEmail() {
  const phones: [string | null | undefined, string | null][] = [
    ["(212) 555-0100", "+12125550100"],
    ["212-555-0100", "+12125550100"],
    ["212.555.0100", "+12125550100"],
    ["2125550100", "+12125550100"],
    ["1 212 555 0100", "+12125550100"],
    ["+1 (212) 555-0100", "+12125550100"],
    ["+12125550100", "+12125550100"],
    [" 212 555 0100 ", "+12125550100"],
    ["+44 20 7123 4567", "+442071234567"],
    ["+442071234567", "+442071234567"],
    ["555-0100", null],
    ["212-555-010", null],
    ["212-155-0100", null], // exchange starts with 1
    ["112-555-0100", null], // area code starts with 1
    ["+1 111 555 0100", null],
    ["+123", null],
    ["+1234567890123456", null],
    ["call me", null],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
  ];
  for (const [raw, want] of phones) assert.equal(toE164(raw), want, `toE164(${JSON.stringify(raw)})`);
  ok("toE164 table");

  const emails: [string | null | undefined, string | null][] = [
    ["a@b.com", "a@b.com"],
    ["  Mary.Smith+tag@Example.COM ", "mary.smith+tag@example.com"],
    ["o'brien@x.co.uk", "o'brien@x.co.uk"],
    ["a,b@x.com", null],
    ["a@b.com, c@d.com", null],
    ["a@b.com\r\nBcc: x", null],
    ["a@b.com\nBcc: x@y.com", null],
    ['"Mary Smith" <m@x.com>', null],
    ["Mary <m@x.com>", null],
    ["<m@x.com>", null],
    ['"quoted name"@x.com', null],
    ["a b@x.com", null],
    ["a@b", null],
    ["a@@b.com", null],
    ["@b.com", null],
    ["a@", null],
    [`${"a".repeat(250)}@b.com`, null],
    ["", null],
    [null, null],
    [undefined, null],
  ];
  for (const [raw, want] of emails) assert.equal(validEmail(raw), want, `validEmail(${JSON.stringify(raw)})`);
  ok("validEmail table (lists, CR/LF injection and quoted names rejected)");
}

function usNumbersAndZones() {
  assert.equal(usMarketingNumber("+14165550100"), false, "Toronto");
  assert.equal(usMarketingNumber("+12125550100"), true);
  assert.equal(usMarketingNumber("+18765550100"), false, "Jamaica");
  assert.equal(usMarketingNumber("+442071234567"), false);
  assert.equal(usMarketingNumber("+1212555010"), false, "too short");
  ok("usMarketingNumber");

  assert.deepEqual(recipientZones("+19075550100"), ["America/Anchorage"], "907");
  assert.deepEqual(recipientZones("+18085550100"), ["Pacific/Honolulu"], "808");
  assert.deepEqual(recipientZones("+14155550100"), MAINLAND_ZONES, "other US");
  assert.deepEqual(recipientZones("+12125550100"), MAINLAND_ZONES);
  assert.deepEqual(recipientZones("+14165550100"), [], "Canada");
  assert.deepEqual(recipientZones("+442071234567"), [], "not NANP");
  ok("recipientZones (907, 808, other)");
}

function zoned() {
  // Spring forward 2026-03-08, fall back 2026-11-01 (America/New_York).
  assert.equal(iso(zonedTime("2026-03-07", 9 * 60, NY)), "2026-03-07T14:00:00.000Z", "EST");
  assert.equal(iso(zonedTime("2026-03-08", 60, NY)), "2026-03-08T06:00:00.000Z", "01:00 EST before the change");
  assert.equal(iso(zonedTime("2026-03-08", 9 * 60, NY)), "2026-03-08T13:00:00.000Z", "09:00 EDT after the change");
  assert.equal(iso(zonedTime("2026-03-08", 150, NY)), "2026-03-08T07:00:00.000Z", "02:30 does not exist: moves forward to 03:00 EDT");
  assert.equal(iso(zonedTime("2026-03-08", 0, NY)), "2026-03-08T05:00:00.000Z", "midnight is still EST");
  assert.equal(iso(zonedTime("2026-10-31", 9 * 60, NY)), "2026-10-31T13:00:00.000Z", "EDT");
  assert.equal(iso(zonedTime("2026-11-01", 0, NY)), "2026-11-01T04:00:00.000Z", "midnight is still EDT");
  assert.equal(iso(zonedTime("2026-11-01", 9 * 60, NY)), "2026-11-01T14:00:00.000Z", "09:00 EST after the change");
  assert.ok(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"].includes(iso(zonedTime("2026-11-01", 90, NY))), "01:30 happens twice: either is fine");
  assert.equal(iso(zonedTime("2026-11-02", 9 * 60, NY)), "2026-11-02T14:00:00.000Z");
  assert.equal(+dayStart("2026-03-09", NY) - +dayStart("2026-03-08", NY), 23 * 3_600_000, "spring-forward day is 23 h");
  assert.equal(+dayStart("2026-11-02", NY) - +dayStart("2026-11-01", NY), 25 * 3_600_000, "fall-back day is 25 h");
  assert.equal(ymdOf(new Date("2026-03-08T06:59:00Z"), NY), "2026-03-08");
  assert.equal(ymdOf(new Date("2026-03-08T04:59:00Z"), NY), "2026-03-07");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(iso(zonedTime("2026-07-01", 9 * 60, "America/Phoenix")), "2026-07-01T16:00:00.000Z", "Phoenix has no DST");
  assert.equal(iso(zonedTime("2026-07-01", 9 * 60, "America/Los_Angeles")), "2026-07-01T16:00:00.000Z");
  ok("zonedTime across both DST changes");
}

function quiet() {
  const at = (ymd: string, hm: string, tz = NY) => {
    const [h, m] = hm.split(":").map(Number);
    return zonedTime(ymd, h * 60 + m, tz);
  };
  const next = (now: Date, marketing: boolean, to: string, rules: QuietRules = RULES, tz = NY) => nextTextTime(now, tz, rules, marketing, to);
  const NYC = "+12125550100";

  // A notice at 19:59 goes now; at 20:00 it waits for 09:00 the next day.
  const t1959 = at("2026-10-06", "19:59");
  assert.equal(+next(t1959, false, NYC), +t1959, "19:59 shop time: now");
  const t2000 = at("2026-10-06", "20:00");
  assert.equal(iso(next(t2000, false, NYC)), iso(at("2026-10-07", "09:00")), "20:00 shop time: 09:00 next day");
  assert.equal(iso(next(at("2026-10-06", "08:59"), false, NYC)), iso(at("2026-10-06", "09:00")), "08:59: 09:00 same day");
  assert.equal(+next(at("2026-10-06", "09:00"), false, NYC), +at("2026-10-06", "09:00"), "09:00 exactly: now");
  assert.equal(iso(next(at("2026-10-06", "21:30"), false, NYC)), iso(at("2026-10-07", "09:00")), "21:30: 09:00 next day");

  // A marketing text to a 415 number from a New York shop at 09:00 ET waits until 12:00 ET (09:00 Pacific).
  const m0900 = at("2026-10-06", "09:00");
  assert.equal(iso(next(m0900, true, "+14155550100")), iso(at("2026-10-06", "12:00")), "marketing to 415 at 09:00 ET: 12:00 ET");
  assert.equal(+next(at("2026-10-06", "12:00"), true, "+14155550100"), +at("2026-10-06", "12:00"), "12:00 ET: now");
  assert.equal(iso(next(at("2026-10-06", "19:59"), true, "+14155550100")), iso(at("2026-10-06", "19:59")), "19:59 ET: still fine in every zone");
  assert.equal(+next(m0900, false, "+14155550100"), +m0900, "a notice only looks at the shop's own clock");
  // Canada has no recipient zones: the shop's clock only (and not_us blocks it before this anyway).
  assert.equal(+next(m0900, true, "+14165550100"), +m0900);
  // Alaska 907: 09:00 ET is 05:00 AKDT, so wait for 13:00 ET.
  assert.equal(iso(next(m0900, true, "+19075550100")), iso(at("2026-10-06", "13:00")), "907: Anchorage window");
  // Hawaii 808: 09:00 ET is 03:00 HST, so wait for 15:00 ET.
  assert.equal(iso(next(m0900, true, "+18085550100")), iso(at("2026-10-06", "15:00")), "808: Honolulu window");

  // Sunday, 2026-10-04: marketing waits for Monday (every zone's Monday window), a notice goes.
  const sun = at("2026-10-04", "12:00");
  assert.equal(+next(sun, false, NYC), +sun, "a notice on Sunday goes");
  assert.equal(iso(next(sun, true, NYC)), iso(at("2026-10-05", "12:00")), "Sunday marketing with noSundayMarketing: Monday 12:00 ET");
  assert.equal(+next(sun, true, NYC, { ...RULES, noSundayMarketing: false }), +sun, "Sunday marketing allowed when the shop says so");
  // A Saturday evening marketing text rolls over Sunday.
  assert.equal(iso(next(at("2026-10-03", "20:30"), true, NYC)), iso(at("2026-10-05", "12:00")), "Saturday 20:30 ET: Monday");

  // Both DST change days.
  assert.equal(iso(next(at("2026-03-07", "20:30"), false, NYC)), "2026-03-08T13:00:00.000Z", "notice after quiet on the eve of spring forward: 09:00 EDT");
  assert.equal(iso(next(new Date("2026-03-08T12:00:00Z"), false, NYC)), "2026-03-08T13:00:00.000Z", "08:00 EDT on the change day: 09:00 EDT");
  assert.equal(+next(new Date("2026-03-08T13:00:00Z"), false, NYC), +new Date("2026-03-08T13:00:00Z"), "09:00 EDT on the change day: now");
  assert.equal(iso(next(at("2026-03-08", "20:00"), false, NYC)), iso(at("2026-03-09", "09:00")), "20:00 on the change day: next 09:00");
  assert.equal(iso(next(at("2026-10-31", "20:30"), false, NYC)), "2026-11-01T14:00:00.000Z", "notice after quiet on the eve of fall back: 09:00 EST");
  assert.equal(iso(next(new Date("2026-11-01T13:00:00Z"), false, NYC)), "2026-11-01T14:00:00.000Z", "08:00 EST on the change day: 09:00 EST");
  assert.equal(iso(next(new Date("2026-11-01T13:30:00Z"), true, "+12125550100", { ...RULES, noSundayMarketing: false })), "2026-11-01T17:00:00.000Z", "marketing 08:30 EST on the change day: 09:00 PST = 17:00Z");
  // 2026-11-01 is a Sunday: with noSundayMarketing marketing moves to Monday 12:00 ET (17:00Z).
  assert.equal(iso(next(new Date("2026-11-01T17:00:00Z"), true, NYC)), "2026-11-02T17:00:00.000Z", "Sunday fall-back day, marketing: Monday");
  ok("nextTextTime (19:59 / 20:00, 415 at 09:00 ET -> 12:00 ET, 907 / 808, Sunday, both DST days)");
}

type Cust = Partial<ConsentCustomer>;
const cust = (o: Cust = {}): ConsentCustomer => ({
  id: "c1",
  kind: "RETAIL",
  phone: "(212) 555-0100",
  email: "mary@example.com",
  notifyBy: "both",
  smsConsentAt: new Date("2026-09-01T12:00:00Z"),
  smsConsentPhone: "+12125550100",
  ...o,
});

function gate() {
  const on = { emailReady: true, smsReady: true };
  const seen = new Set<SkipReason>();
  const sup = (...e: [string, "marketing" | "all"][]): SupMap => new Map(e);
  type Row = { label: string; c: ConsentCustomer | null; channel: "email" | "sms"; purpose: "notice" | "marketing"; ms?: { emailReady: boolean; smsReady: boolean }; sup?: SupMap; explicit?: string; want: string };
  const rows: Row[] = [
    // channel_off
    { label: "email off", c: cust(), channel: "email", purpose: "notice", ms: { emailReady: false, smsReady: true }, want: "channel_off" },
    { label: "sms off", c: cust(), channel: "sms", purpose: "notice", ms: { emailReady: true, smsReady: false }, want: "channel_off" },
    { label: "sms off, marketing", c: cust(), channel: "sms", purpose: "marketing", ms: { emailReady: true, smsReady: false }, want: "channel_off" },
    { label: "email off, explicit", c: null, channel: "email", purpose: "notice", ms: { emailReady: false, smsReady: false }, explicit: "a@b.com", want: "channel_off" },
    { label: "email on while sms off", c: cust(), channel: "email", purpose: "notice", ms: { emailReady: true, smsReady: false }, want: "ok" },
    // no_address
    { label: "no email", c: cust({ email: null }), channel: "email", purpose: "notice", want: "no_address" },
    { label: "bad email", c: cust({ email: "not an email" }), channel: "email", purpose: "notice", want: "no_address" },
    { label: "no phone", c: cust({ phone: null }), channel: "sms", purpose: "notice", want: "no_address" },
    { label: "bad phone", c: cust({ phone: "555-0100" }), channel: "sms", purpose: "marketing", want: "no_address" },
    { label: "no customer, no address", c: null, channel: "sms", purpose: "notice", want: "no_address" },
    // opted_out / unsubscribed
    { label: "text STOP blocks a notice", c: cust(), channel: "sms", purpose: "notice", sup: sup(["sms:+12125550100", "all"]), want: "opted_out" },
    { label: "text STOP blocks marketing", c: cust(), channel: "sms", purpose: "marketing", sup: sup(["sms:+12125550100", "all"]), want: "opted_out" },
    { label: "any text suppression blocks every kind", c: cust(), channel: "sms", purpose: "notice", sup: sup(["sms:+12125550100", "marketing"]), want: "opted_out" },
    { label: "email 'all' blocks a notice", c: cust(), channel: "email", purpose: "notice", sup: sup(["email:mary@example.com", "all"]), want: "opted_out" },
    { label: "email 'all' blocks marketing", c: cust(), channel: "email", purpose: "marketing", sup: sup(["email:mary@example.com", "all"]), want: "opted_out" },
    { label: "email unsubscribe blocks marketing", c: cust(), channel: "email", purpose: "marketing", sup: sup(["email:mary@example.com", "marketing"]), want: "unsubscribed" },
    { label: "email unsubscribe leaves a notice alone", c: cust(), channel: "email", purpose: "notice", sup: sup(["email:mary@example.com", "marketing"]), want: "ok" },
    { label: "a text opt-out leaves email alone", c: cust(), channel: "email", purpose: "marketing", sup: sup(["sms:+12125550100", "all"]), want: "ok" },
    { label: "another address' suppression", c: cust(), channel: "email", purpose: "marketing", sup: sup(["email:other@example.com", "all"]), want: "ok" },
    // explicit address: suppression only
    { label: "explicit address ok", c: null, channel: "sms", purpose: "notice", explicit: "+12125550100", want: "ok" },
    { label: "explicit email ok", c: null, channel: "email", purpose: "notice", explicit: "x@y.com", want: "ok" },
    { label: "explicit address suppressed", c: null, channel: "sms", purpose: "notice", explicit: "+12125550100", sup: sup(["sms:+12125550100", "all"]), want: "opted_out" },
    // no_messages
    { label: "notifyBy none, notice email", c: cust({ notifyBy: "none" }), channel: "email", purpose: "notice", want: "no_messages" },
    { label: "notifyBy none, notice sms", c: cust({ notifyBy: "none" }), channel: "sms", purpose: "notice", want: "no_messages" },
    { label: "notifyBy none blocks marketing", c: cust({ notifyBy: "none" }), channel: "email", purpose: "marketing", want: "no_messages" },
    { label: "notifyBy none blocks marketing text", c: cust({ notifyBy: "none" }), channel: "sms", purpose: "marketing", want: "no_messages" },
    // notice: how they want to be told
    { label: "notice text, notifyBy ''", c: cust({ notifyBy: "" }), channel: "sms", purpose: "notice", want: "not_asked" },
    { label: "notice text, notifyBy email", c: cust({ notifyBy: "email" }), channel: "sms", purpose: "notice", want: "prefers_other" },
    { label: "notice text, notifyBy sms", c: cust({ notifyBy: "sms" }), channel: "sms", purpose: "notice", want: "ok" },
    { label: "notice text, notifyBy both", c: cust({ notifyBy: "both" }), channel: "sms", purpose: "notice", want: "ok" },
    { label: "notice email, notifyBy sms", c: cust({ notifyBy: "sms" }), channel: "email", purpose: "notice", want: "prefers_other" },
    { label: "notice email, notifyBy ''", c: cust({ notifyBy: "" }), channel: "email", purpose: "notice", want: "ok" },
    { label: "notice email, notifyBy email", c: cust({ notifyBy: "email" }), channel: "email", purpose: "notice", want: "ok" },
    { label: "notice email, notifyBy both", c: cust({ notifyBy: "both" }), channel: "email", purpose: "notice", want: "ok" },
    { label: "a trade account still gets notices", c: cust({ kind: "TRADE" }), channel: "email", purpose: "notice", want: "ok" },
    { label: "notice text needs no marketing consent", c: cust({ smsConsentAt: null, smsConsentPhone: null }), channel: "sms", purpose: "notice", want: "ok" },
    { label: "notice text to a Canadian number is fine", c: cust({ phone: "416-555-0100", smsConsentAt: null, smsConsentPhone: null }), channel: "sms", purpose: "notice", want: "ok" },
    // marketing
    { label: "marketing to a trade account (email)", c: cust({ kind: "TRADE" }), channel: "email", purpose: "marketing", want: "trade" },
    { label: "marketing to a trade account (text)", c: cust({ kind: "TRADE" }), channel: "sms", purpose: "marketing", want: "trade" },
    { label: "marketing email ok", c: cust(), channel: "email", purpose: "marketing", want: "ok" },
    { label: "marketing email, notifyBy ''", c: cust({ notifyBy: "" }), channel: "email", purpose: "marketing", want: "ok" },
    { label: "marketing text, consent for this number", c: cust(), channel: "sms", purpose: "marketing", want: "ok" },
    { label: "marketing text, Canadian number", c: cust({ phone: "416-555-0100", smsConsentPhone: "+14165550100" }), channel: "sms", purpose: "marketing", want: "not_us" },
    { label: "marketing text, Jamaican number without consent", c: cust({ phone: "+1 876 555 0100", smsConsentAt: null, smsConsentPhone: null }), channel: "sms", purpose: "marketing", want: "not_us" },
    { label: "marketing text, foreign number", c: cust({ phone: "+442071234567", smsConsentPhone: "+442071234567" }), channel: "sms", purpose: "marketing", want: "not_us" },
    { label: "marketing text, no consent", c: cust({ smsConsentAt: null, smsConsentPhone: null }), channel: "sms", purpose: "marketing", want: "no_text_consent" },
    { label: "marketing text, consent date but no number", c: cust({ smsConsentPhone: null }), channel: "sms", purpose: "marketing", want: "no_text_consent" },
    { label: "a changed phone voids consent", c: cust({ phone: "(212) 555-0199" }), channel: "sms", purpose: "marketing", want: "no_text_consent" },
    { label: "marketing text, notifyBy email is fine with consent", c: cust({ notifyBy: "email" }), channel: "sms", purpose: "marketing", want: "ok" },
  ];
  for (const r of rows) {
    const res = allowed(r.c, r.channel, r.purpose, r.ms ?? on, r.sup ?? new Map(), r.explicit);
    if (res.ok) assert.equal("ok", r.want, `${r.label}: allowed, wanted ${r.want}`);
    else {
      assert.equal(res.reason, r.want, `${r.label}: ${res.reason}, wanted ${r.want}`);
      seen.add(res.reason);
    }
  }
  // The address allowed() returns: the normalised one, or the explicit one.
  const a1 = allowed(cust({ phone: "212 555 0100" }), "sms", "notice", on, new Map());
  assert.deepEqual(a1, { ok: true, address: "+12125550100" });
  const a2 = allowed(cust({ email: " MARY@Example.com " }), "email", "notice", on, new Map());
  assert.deepEqual(a2, { ok: true, address: "mary@example.com" });
  const a3 = allowed(null, "email", "notice", on, new Map(), "me@shop.com");
  assert.deepEqual(a3, { ok: true, address: "me@shop.com" });

  // Every reason allowed() can give was seen; the rest belong to the queue and the worker but still have words.
  const fromGate: SkipReason[] = ["channel_off", "no_address", "opted_out", "unsubscribed", "no_text_consent", "not_asked", "prefers_other", "no_messages", "trade", "not_us"];
  for (const r of fromGate) assert.ok(seen.has(r), `skip reason ${r} never produced by allowed()`);
  assert.deepEqual([...seen].sort(), [...fromGate].sort(), "allowed() produced a reason outside its list");
  const others: SkipReason[] = ["changed", "not_wanted", "too_often", "unread_reply", "staff_cap"];
  for (const r of [...fromGate, ...others]) assert.ok(SKIP_REASON_LABEL[r], `no label for ${r}`);
  assert.equal(Object.keys(SKIP_REASON_LABEL).length, fromGate.length + others.length, "SKIP_REASON_LABEL has a reason this check doesn't know");
  ok(`allowed() truth table (${rows.length} rows, every skip reason, trade, not_us, a changed phone voids consent)`);
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(vars).map((k) => [k, env[k]] as const);
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

function secrets() {
  withEnv({ SETTINGS_KEY: "check-settings-key-one", SETTINGS_KEY_PREVIOUS: undefined, AUTH_SECRET: "check-auth-secret", NODE_ENV: "test" }, () => {
    const s = seal("hunter2", "shopA", "smtpPass");
    assert.match(s, /^v1\.[0-9a-f]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(!s.includes("hunter2"));
    assert.deepEqual(unseal(s, "shopA", "smtpPass"), { plain: "hunter2", stale: false }, "round trip");
    assert.notEqual(seal("hunter2", "shopA", "smtpPass"), s, "a fresh IV every time");
    assert.equal(unseal(s, "shopB", "smtpPass"), null, "another shop's AAD");
    assert.equal(unseal(s, "shopA", "twilioToken"), null, "another field's AAD");
    assert.equal(unseal(null, "shopA", "smtpPass"), null);
    assert.equal(unseal("", "shopA", "smtpPass"), null);
    assert.equal(unseal("garbage", "shopA", "smtpPass"), null);
    const t = seal("tok", "shopA", "estimateToken:abc");
    assert.equal(unseal(t, "shopA", "estimateToken:abc")?.plain, "tok");
    assert.equal(unseal(t, "shopA", "estimateToken:abd"), null, "token bound to its link");

    const parts = s.split(".");
    const shortTag = [...parts.slice(0, 4), Buffer.alloc(12, 7).toString("base64url")].join(".");
    assert.equal(unseal(shortTag, "shopA", "smtpPass"), null, "a 12-byte tag");
    const badTag = [...parts.slice(0, 4), Buffer.alloc(16, 7).toString("base64url")].join(".");
    assert.equal(unseal(badTag, "shopA", "smtpPass"), null, "a wrong 16-byte tag");
    const badKid = ["v1", "00000000", ...parts.slice(2)].join(".");
    assert.equal(unseal(badKid, "shopA", "smtpPass"), null, "an unknown key id");
    const badIv = [parts[0], parts[1], Buffer.alloc(8).toString("base64url"), parts[3], parts[4]].join(".");
    assert.equal(unseal(badIv, "shopA", "smtpPass"), null, "a short IV");
    const flipped = [parts[0], parts[1], parts[2], Buffer.from(Buffer.from(parts[3], "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url"), parts[4]].join(".");
    assert.equal(unseal(flipped, "shopA", "smtpPass"), null, "tampered ciphertext");
    assert.equal(unseal(["v2", ...parts.slice(1)].join("."), "shopA", "smtpPass"), null, "an unknown version");
    assert.equal(unseal(`${s}.x`, "shopA", "smtpPass"), null, "six parts");

    // A value sealed with the previous key opens with stale: true.
    const old = seal("old-secret", "shopA", "twilioToken");
    withEnv({ SETTINGS_KEY: "check-settings-key-two", SETTINGS_KEY_PREVIOUS: "check-settings-key-one" }, () => {
      assert.deepEqual(unseal(old, "shopA", "twilioToken"), { plain: "old-secret", stale: true }, "sealed with SETTINGS_KEY_PREVIOUS");
      const fresh = seal("new-secret", "shopA", "twilioToken");
      assert.deepEqual(unseal(fresh, "shopA", "twilioToken"), { plain: "new-secret", stale: false });
      assert.equal(unseal(old, "shopB", "twilioToken"), null, "still bound to the shop");
    });
    withEnv({ SETTINGS_KEY: "check-settings-key-two", SETTINGS_KEY_PREVIOUS: undefined }, () => {
      assert.equal(unseal(old, "shopA", "twilioToken"), null, "the previous key is gone: unreadable");
    });
    // The Windows program's AUTH_SECRET key still opens values after SETTINGS_KEY is introduced.
    const viaAuth = withEnv({ SETTINGS_KEY: undefined }, () => seal("auth-sealed", "shopA", "smtpPass"));
    assert.deepEqual(unseal(viaAuth, "shopA", "smtpPass"), { plain: "auth-sealed", stale: true }, "sealed under AUTH_SECRET, opened under SETTINGS_KEY");
  });
  ok("seal / unseal (round trip, other shop's AAD, 12-byte tag, SETTINGS_KEY_PREVIOUS -> stale)");
}

function templates() {
  // render is single pass.
  const vars = { name: "{estimate_link}", first_name: "{shop_name}", shop_name: "Quilt Shop", estimate_link: "https://shop.example/e/TOKEN" };
  assert.equal(render("Hi {name}, see {estimate_link}", vars), "Hi {estimate_link}, see https://shop.example/e/TOKEN", "a name of {estimate_link} stays literal");
  assert.equal(render("{first_name} / {shop_name}", vars), "{shop_name} / Quilt Shop");
  assert.equal(render("a {nope} b", vars), "a  b", "an unknown field is empty");
  assert.equal(render("x\n\n\n\ny", {}), "x\n\ny", "runs of blank lines collapse");
  assert.equal(render("ready to pick up.{amount_line} Questions?", { amount_line: " Balance: $145.00." }), "ready to pick up. Balance: $145.00. Questions?", "a _line field keeps the space it starts with");
  assert.equal(render("on {when}.{location_line}{supplies_line}", { when: "Tue", location_line: " At Back room.", supplies_line: "\n\nBring: scissors" }), "on Tue. At Back room.\n\nBring: scissors", "and the blank line before Bring:");
  assert.equal(render("Hi {name}", { name: "  spaced  " }), "Hi   spaced", "at most two leading separators are kept, the rest is cleaned");
  assert.equal(render("Hi {name}", { name: "Mary\r\nBcc: x@y.com" }), "Hi Mary Bcc: x@y.com", "CR/LF out of a customer-supplied value");
  assert.equal(render("Hi {name}", { name: "see http://evil.example/x or www.evil.example" }), "Hi see [link removed] or [link removed]", "links out of untrusted values");
  assert.equal(render("{review_link}", { review_link: "https://g.page/r/x" }), "https://g.page/r/x", "trusted fields keep their links");

  // cleanText.
  assert.equal(cleanText("a\r\nb\tc\u0000d"), "a b c d", "CR, LF, tab and NUL become spaces");
  assert.equal(cleanText("  a    b  "), "a b");
  assert.equal(cleanText("go to https://evil.example/path?x=1 now"), "go to [link removed] now");
  assert.equal(cleanText("HTTP://EVIL.EXAMPLE and www.x.org"), "[link removed] and [link removed]");
  assert.equal(cleanText("x".repeat(600)).length, 500);
  assert.equal(cleanText("x".repeat(600), 10), "xxxxxxxxxx");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.ok(!/[\r\n]/.test(cleanText("a\r\n\r\nb\nc")));

  // Subjects are cleaned after the merge.
  const ms = { templates: { "ready.subject": "Ready: {name}\r\nBcc: spy@x.com\u0007", "ready.email": "Body {name}" } };
  const c1 = renderKind(ms, "ready", "email", { name: "Mary\r\nBcc: x", shop_name: "S" });
  assert.ok(c1.subject && !/[\r\n\t\u0000-\u001f\u007f]/.test(c1.subject), `subject still has control characters: ${JSON.stringify(c1.subject)}`);
  assert.equal(c1.subject, "Ready: Mary Bcc: x Bcc: spy@x.com");
  const c2 = renderKind({ templates: { "ready.subject": "Hello {shop_name}" } }, "ready", "email", { shop_name: "Quilts\r\nand\tmore" });
  assert.equal(c2.subject, "Hello Quilts and more", "a trusted field's newline is removed after the merge");
  const c3 = renderKind({ templates: { "ready.subject": "{name}" } }, "ready", "email", { name: "y".repeat(400) });
  assert.equal(c3.subject?.length, 150, "at most 150 characters");
  assert.equal(cleanSubject("  a \r\n\t b  "), "a b");
  assert.equal(cleanSubject("x".repeat(200)).length, 150);
  assert.equal(renderKind({ templates: {} }, "ready", "sms", { first_name: "Mary", machine: "Janome", shop_phone: "555", amount_line: "" }).subject, undefined, "texts have no subject");
  assert.equal(templateFor({ templates: { "ready.sms": "  " } }, "ready.sms"), DEFAULT_TEMPLATES["ready.sms"], "a blank saved wording falls back to the default");
  assert.equal(templateFor({ templates: { "ready.sms": "Custom" } }, "ready.sms"), "Custom");
  assert.equal(templateFor({ templates: null }, "ready.sms"), DEFAULT_TEMPLATES["ready.sms"]);
  assert.equal(templateFor({ templates: [] }, "ready.sms"), DEFAULT_TEMPLATES["ready.sms"]);

  // checkTemplate.
  checkTemplate("Hi {first_name}, call {shop_phone}", FIELDS.ready);
  checkTemplate("no fields at all", FIELDS.ready);
  assert.throws(
    () => checkTemplate("Hi {first_name} {bogus}", FIELDS.ready),
    (e: unknown) => isUserError(e) && /^Unknown field \{bogus\}\. You can use: \{first_name\}, \{name\}/.test((e as Error).message),
    "an unknown field is a UserError naming the fields you can use",
  );
  assert.throws(() => checkTemplate("{estimate_link}", FIELDS.reminder), (e: unknown) => isUserError(e), "a field the kind doesn't have");
  for (const [key, text] of Object.entries(DEFAULT_TEMPLATES)) {
    const kind = key.split(".")[0];
    checkTemplate(text, FIELDS[kind]);
  }
  ok("render is single pass; cleanText; subjects cleaned after merge; checkTemplate (every default fits its kind)");

  // smsParts.
  const parts = (s: string) => smsParts(s);
  assert.deepEqual(parts("a".repeat(160)), { parts: 1, unicode: false }, "GSM 160");
  assert.deepEqual(parts("a".repeat(161)), { parts: 2, unicode: false }, "GSM 161");
  assert.deepEqual(parts("a".repeat(306)), { parts: 2, unicode: false }, "GSM 2 x 153");
  assert.deepEqual(parts("a".repeat(307)), { parts: 3, unicode: false }, "GSM 3 parts");
  assert.deepEqual(parts(""), { parts: 0, unicode: false });
  assert.deepEqual(parts("[".repeat(80)), { parts: 1, unicode: false }, "extension characters count double: 160 units");
  assert.deepEqual(parts("[".repeat(81)), { parts: 2, unicode: false }, "162 units");
  assert.deepEqual(parts("ж".repeat(70)), { parts: 1, unicode: true }, "UCS-2 70");
  assert.deepEqual(parts("ж".repeat(71)), { parts: 2, unicode: true }, "UCS-2 71");
  assert.deepEqual(parts("ж".repeat(134)), { parts: 2, unicode: true }, "UCS-2 2 x 67");
  assert.deepEqual(parts("ж".repeat(135)), { parts: 3, unicode: true }, "UCS-2 3 parts");
  assert.deepEqual(parts(`${"a".repeat(69)}ж`), { parts: 1, unicode: true }, "one Cyrillic letter makes the whole text UCS-2");
  assert.deepEqual(parts(`${"a".repeat(70)}ж`), { parts: 2, unicode: true });
  assert.deepEqual(parts("\u{1F600}".repeat(35)), { parts: 1, unicode: true }, "an emoji is two units: 70");
  assert.deepEqual(parts("\u{1F600}".repeat(36)), { parts: 2, unicode: true }, "72 units");
  ok("smsParts (GSM 160 / 153, UCS-2 70 / 67)");

  // plainText.
  assert.deepEqual(plainText("“Hi” — it’s… – ok now • x"), { text: '"Hi" - it\'s... - ok now * x', changed: true });
  assert.deepEqual(plainText("Plain 'text' - fine."), { text: "Plain 'text' - fine.", changed: false });
  assert.equal(smsParts(plainText(`${"’".repeat(160)}`).text).unicode, false, "after plainText a curly-quote text is GSM again");
  ok("plainText");
}

function finalizing() {
  const ctx = { shopName: "Quilt Shop", shopPhone: "(555) 123-4567", postal: "1 Main St, Springfield", unsubscribeUrl: "https://links.example.com/u/TOK", replyWord: true };
  const delivered = (s: string, sub: string) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in ${JSON.stringify(s)}`);
  const not = (s: string, sub: string) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)} in ${JSON.stringify(s)}`);
  withEnv({ STITCH_DESKTOP: undefined }, () => {
    // Texts: the shop prefix once.
    const t = finalize("sms", "ready", "Your machine is ready.", ctx);
    assert.equal(t, "Quilt Shop: Your machine is ready.");
    assert.equal(finalize("sms", "ready", t, ctx), t, "prefixing twice adds nothing");
    assert.equal(finalize("sms", "ready", "quilt shop: hi", ctx), "quilt shop: hi", "case-insensitive prefix check");
    assert.equal((t.match(/Quilt Shop/g) ?? []).length, 1);
    not(t, "Reply STOP");
    // STOP line: marketing and staff-typed notices.
    for (const kind of ["service_due", "review", "campaign", "bags_due"] as const) {
      const m = finalize("sms", kind, "Time for a tune-up?", ctx);
      assert.equal(m, "Quilt Shop: Time for a tune-up? Reply STOP to opt out.", kind);
      assert.equal(finalize("sms", kind, m, ctx), m, `${kind}: the STOP line only once`);
    }
    assert.equal(finalize("sms", "campaign", "Sale! Reply STOP to opt out.", ctx), "Quilt Shop: Sale! Reply STOP to opt out.", "an existing STOP line is not repeated");
    for (const kind of ["class_notice", "booking_notice"] as const) assert.ok(finalize("sms", kind, "Class moved to 7.", ctx).endsWith(" Reply STOP to opt out."), `${kind} text ends with the STOP line`);
    for (const kind of ["ready", "reminder", "estimate", "abandon", "consent_confirm", "help_reply", "test"] as const) not(finalize("sms", kind, "x", ctx), "Reply STOP to opt out.");

    // Notice emails: a signature, no advertisement.
    const n = finalize("email", "ready", "Hello\n\nReady.", ctx);
    assert.equal(n, "Hello\n\nReady.\n\nQuilt Shop · (555) 123-4567");
    not(n, "advertisement");
    assert.equal(finalize("email", "ready", "Hi", { ...ctx, shopPhone: null }), "Hi\n\nQuilt Shop");
    not(finalize("email", "class_notice", "Hi", ctx), "advertisement");

    // Marketing emails, hosted: advertisement and postal footer, the link first.
    const h = finalize("email", "campaign", "Sale on thread.", ctx);
    delivered(h, "\n--\n");
    delivered(h, "This is an advertisement from Quilt Shop, 1 Main St, Springfield.");
    delivered(h, "To stop getting these emails: https://links.example.com/u/TOK");
    delivered(h, "Or reply with the word UNSUBSCRIBE.");
    assert.ok(h.indexOf("https://links.example.com/u/TOK") < h.indexOf("UNSUBSCRIBE"), "hosted: the link comes first");
    const hNoUrl = finalize("email", "service_due", "Hi", { ...ctx, unsubscribeUrl: null });
    delivered(hNoUrl, "reply to this email with the word UNSUBSCRIBE.");
    not(hNoUrl, "http");
    delivered(finalize("email", "review", "Hi", { ...ctx, postal: null }), "This is an advertisement from Quilt Shop.");
    for (const kind of ["review", "bags_due", "service_due", "campaign"] as const) delivered(finalize("email", kind, "x", ctx), "This is an advertisement from Quilt Shop");
  });
  withEnv({ STITCH_DESKTOP: "1" }, () => {
    // Windows program: the reply is the mechanism; a link only as an extra.
    const w = finalize("email", "campaign", "Sale on thread.", ctx);
    delivered(w, "This is an advertisement from Quilt Shop, 1 Main St, Springfield.");
    delivered(w, "To stop getting these emails, reply to this email with the word UNSUBSCRIBE. Or use https://links.example.com/u/TOK");
    assert.ok(w.indexOf("UNSUBSCRIBE") < w.indexOf("https://links.example.com"), "Windows: the reply comes first");
    const wNoUrl = finalize("email", "campaign", "Sale.", { ...ctx, unsubscribeUrl: null });
    delivered(wNoUrl, "To stop getting these emails, reply to this email with the word UNSUBSCRIBE.");
    not(wNoUrl, "Or use");
    not(wNoUrl, "http");
    // Texts are the same on both.
    assert.equal(finalize("sms", "campaign", "Hi", ctx), "Quilt Shop: Hi Reply STOP to opt out.");
  });
  withEnv({ STITCH_DESKTOP: undefined }, () => {
    const back = finalize("email", "campaign", "Sale.", ctx);
    delivered(back, "To stop getting these emails: https://links.example.com/u/TOK");
  });
  ok("finalize (shop prefix once, STOP line, advertisement + postal footer, hosted vs Windows unsubscribe wording)");

  // textToHtml escapes.
  const html = textToHtml('Hi <script>alert(1)</script> & "quotes"\n\nSecond <b>para</b>\nline two\n\nSee https://shop.example/e/abc now\n--\nThis is an advertisement <i>x</i>');
  assert.ok(!html.includes("<script"), "no raw <script>");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&amp;") && html.includes("&quot;quotes&quot;"));
  assert.ok(!html.includes("<b>") && !html.includes("<i>"), "every tag from the text is escaped");
  assert.ok(html.includes("<p>Second &lt;b&gt;para&lt;/b&gt;<br>line two</p>"), "paragraphs on blank lines, <br> inside");
  assert.ok(html.includes('<a href="https://shop.example/e/abc">https://shop.example/e/abc</a>'), "URLs are linked");
  assert.ok(html.includes("font-size:12px") && html.includes("advertisement &lt;i&gt;x&lt;/i&gt;"), "the -- footer is small grey, escaped");
  const attack = textToHtml('x https://a.example/"><img src=x onerror=alert(1)> y');
  assert.ok(!attack.includes("<img"), "a quote can't break out of the href");
  assert.match(textToHtml("plain"), /^<!doctype html><html><body[^>]*><p>plain<\/p><\/body><\/html>$/);
  ok("textToHtml escapes <script>, tags and quotes");
}

function names() {
  const table: [string, string][] = [
    ["SMITH, MARY", "Mary"],
    ["Mrs. Jones", "Jones"],
    ["", "there"],
    ["   ", "there"],
    ["Mary Smith", "Mary"],
    ["mary smith", "mary"],
    ["MARY ANN JONES", "Mary"],
    ["Dr Who", "Who"],
    ["Ms Mary Jones", "Mary"],
    ["Smith, Mary Ann", "Mary"],
    ["O'Brien, Pat", "Pat"],
    ["Mary-Jo Smith", "Mary-Jo"],
    ["1234", "there"],
    ["Mary\r\nBcc: x", "Mary"],
  ];
  for (const [raw, want] of table) assert.equal(firstName(raw), want, `firstName(${JSON.stringify(raw)})`);
  assert.equal(firstName(null as unknown as string), "there");
  ok('firstName ("SMITH, MARY" -> Mary, "Mrs. Jones" -> Jones, "" -> there)');
}

function ticketDates() {
  const T = (n: number) => new Date(Date.UTC(2026, 9, n, 15, 0, 0));
  const base = (o: Partial<TicketForStatus> = {}): TicketForStatus => ({ id: "t1", shopId: "s1", status: "ON_BENCH", readyAt: null, pickupReadyAt: null, closedAt: null, warrantyUntil: null, customerId: null, viaAccountId: null, ...o });
  const go = (t: TicketForStatus, to: TicketStatus, at: Date) => statusData(t, to, at, 90);

  // Entering READY_FOR_PICKUP sets pickupReadyAt and the first readyAt.
  const a = go(base(), "READY_FOR_PICKUP", T(1));
  assert.equal(+(a.pickupReadyAt as Date), +T(1));
  assert.equal(+(a.readyAt as Date), +T(1), "the first ready date");
  // Leaving it clears pickupReadyAt, and the shelf clock restarts on re-entry.
  const afterA = base({ status: "READY_FOR_PICKUP", readyAt: T(1), pickupReadyAt: T(1) });
  const b = go(afterA, "READY_IN_TRUCK", T(2));
  assert.equal(b.pickupReadyAt, null, "leaving READY_FOR_PICKUP clears pickupReadyAt");
  assert.equal(b.readyAt, undefined, "readyAt is kept (not written) moving between ready states");
  const afterB = base({ status: "READY_IN_TRUCK", readyAt: T(1), pickupReadyAt: null });
  const c = go(afterB, "READY_FOR_PICKUP", T(3));
  assert.equal(+(c.pickupReadyAt as Date), +T(3), "re-entering starts the clock again");
  assert.equal(c.readyAt, undefined, "and the first readyAt stays");
  // READY_IN_TRUCK first (readyAt T1) then pickup: readyAt stays the first.
  const d = go(base({ status: "READY_IN_TRUCK", readyAt: T(1) }), "READY_FOR_PICKUP", T(5));
  assert.equal(d.readyAt, undefined);
  assert.equal(+(d.pickupReadyAt as Date), +T(5));
  // Back to the bench: neither ready date survives (the next ready-call restarts the storage clock).
  const e = go(afterA, "ON_BENCH", T(4));
  assert.equal(e.pickupReadyAt, null);
  assert.equal(e.readyAt, null);
  // Collected: pickupReadyAt cleared, closedAt and warranty set; readyAt untouched.
  const f = go(afterA, "COLLECTED", T(6));
  assert.equal(f.pickupReadyAt, null);
  assert.equal(+(f.closedAt as Date), +T(6));
  assert.equal(+(f.warrantyUntil as Date), +T(6) + 90 * 86_400_000);
  assert.equal(f.readyAt, undefined);
  // The same status again keeps an existing pickupReadyAt (nothing is rewritten) and fills a missing one.
  assert.equal(go(afterA, "READY_FOR_PICKUP", T(7)).pickupReadyAt, undefined, "already set: untouched");
  assert.equal(+(go(base({ status: "READY_FOR_PICKUP", readyAt: T(1), pickupReadyAt: null }), "READY_FOR_PICKUP", T(7)).pickupReadyAt as Date), +T(7), "missing: filled in");
  // Reopening a closed ticket straight into READY_FOR_PICKUP: both dates are fresh.
  const g = go(base({ status: "COLLECTED", readyAt: T(1), closedAt: T(2), warrantyUntil: T(30) }), "READY_FOR_PICKUP", T(8));
  assert.equal(+(g.pickupReadyAt as Date), +T(8));
  assert.equal(g.closedAt, null);
  assert.equal(g.warrantyUntil, null);
  ok("statusData: pickupReadyAt set on entering and cleared on leaving READY_FOR_PICKUP, first readyAt kept");
}

function codes() {
  assert.equal(consentCode("abc"), "A9993E", "sha1('abc') starts a9993e36");
  assert.equal(consentCode("  abc \n"), "A9993E", "surrounding whitespace doesn't change it");
  const w = consentWording({ smsConsentText: null }, "Quilt Shop");
  assert.equal(consentCode(w), consentCode(w), "stable");
  assert.match(consentCode(w), /^[0-9A-F]{6}$/);
  assert.equal(consentCode(w), crypto.createHash("sha1").update(w.trim()).digest("hex").slice(0, 6).toUpperCase());
  assert.notEqual(consentCode(w), consentCode(consentWording({ smsConsentText: null }, "Other Shop")), "the shop's name is part of the wording");
  assert.notEqual(consentCode(w), consentCode(`${w} Extra.`));
  assert.ok(w.includes("Quilt Shop") && w.includes("STOP") && /not a condition/i.test(w), "default wording names the shop, STOP and not-a-condition");
  assert.ok(!w.includes("{shop_name}"));
  assert.equal(consentWording({ smsConsentText: "  Custom {shop_name} STOP  " }, "Q"), "Custom Q STOP", "custom wording, trimmed");
  ok("consentCode is stable");
}

function main() {
  const t0 = Date.now();
  phoneAndEmail();
  usNumbersAndZones();
  zoned();
  quiet();
  gate();
  secrets();
  templates();
  finalizing();
  names();
  ticketDates();
  codes();
  void MAINLAND_ZONES;
  console.log(`messaging-core.check: ${steps} groups passed in ${Date.now() - t0} ms`);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
