# Free software: hosting, support and YouTube (design, 11 Oct 2026)

**Owner decision, 11 Oct 2026:** StitchBench, StitchShop and StitchHub become free and open source (AGPL-3.0-only),
published by SiteSentrix under the GitHub organization SiteSentrix. Every feature is free for everyone, the add-on
modules included, on Windows, self-hosted and hosted. Money comes from **hosting** (shops on the owner's hosted
service pay for it), **support** (paid help) and **YouTube**. The hub stays free. This replaces the price list of
3 Oct and its 7 Oct review (HANDOFF section 4), `pricing-recommendation.md`, `pricing-review-2026-10.md`, the selling
parts of `modules-design.md` and `hub-accounts-billing-design.md`, and the add-on pricing in `assistant-design.md`.

Nothing has been charged yet: Stripe was never switched on (HUB `src/billing.mjs:515,533,535-538`). The only keys in
the field are the comps the hub signed on 9 Oct for the owner's own shops (the PC on 1.7.1 and the two hosted
services); k1 and h1 were never compiled in (SB `src/lib/license-keys.ts:12-13`).

Paths: SB = stitchbench, HUB = stitchhub, SITE = stitchsite.

## 1. The one risk, and the safe order

1.7.x enforces any key it holds: once a held hub key's last day plus 14 days passes, the company goes read-only and
its add-ons lock (SB `src/lib/base-gate.ts`, `lapse-guard.ts`). A comp "until <date>" would therefore break an
install in the field one day. So:

1. **Owner, now:** /admin → each shop → Comp → `forever`, and OK to "the five add-ons too". **Don't do "Stripe day"**
   (LAUNCH_CHECKLIST, Day 6-7) on the current code: setting the price variables would start trials that later lapse.
2. The hub makes "free forever, everything" its answer for every shop. It keeps sending `key`/`moduleKeys`, never
   revokes them and never retires `hub1` (that key also signs password-reset grants, SB `hub-reset-grants.ts:25,49`).
3. Ship the program version that ignores keys (1.8).
4. Only then remove key code from the hub. Keep the `License` and `ModuleGrant` tables: older move files carry them
   (SB `src/lib/move/format.ts:150-151`).

## 2. StitchBench

Gates:
- `src/lib/modules.ts:148-217` (`loadModulesMany`) turns keys into each module's state and ~100 files read it.
  **Turn on for everyone**, changed here only, driven by a per-shop Features choice (question 6); the call sites stay.
- `src/lib/equipment/shop.ts:15-30`, `components/nav.tsx:62-70,155-173`: check-in kinds and nav follow the module.
  Keep, minus the read-only lock.
- `lib/module-info.ts`: `MODULE_SALES`, `salesMailto`, "key by email" (129-138, 153) and `planLabel` (195-213): remove.
  "Renew in Settings → Add-ons" (173-186): reword.
- `lib/license.ts` key verification: keep for hosting. Its Solo login plan (16-27) and trial and period maths
  (30, 129-136): remove. `lib/license-keys.ts:10-16`: keep as is (hub1 checks reset grants).
- Key paste (`lib/licenses.ts`, `actions/licenses.ts`), the hosted Companies module switch (`lib/license-signing.ts`,
  `lib/modules-admin.ts:18-65`, `app/(app)/companies/page.tsx:27-60,160-177,211-309`) and the owner key tools
  (`scripts/license/{cli,issue,keygen,resign-grants}.ts`, `package.json:19-20`): remove. Keep `scripts/license/dev.ts`
  while tests use it.

Base license, standing, plans:
- `lib/hub-standing.ts:48-85` (the hub's words, account email, terms): keep. Its add-on keys (118-164) and
  `partnershipNotice` (36-44): remove.
- The read-only gate (`lib/base-gate.ts`, `lapse-guard.ts`, `lapse-allow.ts`, `action.ts:58-87`): keep, it also
  freezes a company being moved. Its lapsed branch: only on the owner's hosted services, behind an environment flag
  (`HOSTING_BILLING=on`), never on Windows or self-hosted.
- Solo's two-login limit (`lib/plan.ts`, `people.ts:10,40,52`, `hub-account.ts:14,221-279`,
  `settings/page.tsx:200-201,676-700`): remove.
- Banners (`app/(app)/layout.tsx:55-84,130,174-178`, `module-banner.tsx`, `module-notice.tsx`): renew pills, grace
  banner and partnership notice go; LapsedBar stays for hosting, reworded; MovingBar stays.
- `settings/modules/page.tsx` becomes Settings → Features (keep the setup checks; drop the pills, the Company ID for
  keys, "paid monthly or yearly" and the key box). `settings/page.tsx:177-190,270-283` and
  `settings/account/page.tsx:17-57,85-120,206`: reword; keep the account, terms and reset opt-in.
- "$25 a month" per extra store (`settings/stores/page.tsx:4,164,366`, `actions/stores.ts:123`): remove.
- Assistant: `lib/assistant/client.ts:36-56` needs the module and sends its key to the hub; `features.ts:62-67` sets
  300 calls. Depends on question 4; the hub's metering stays.
- Docs: `INSTALL.md:405-434,551-646` ("Paid modules"), `README.md:42-45`: reword.
- A "Source code" link in the app (AGPL section 13, for the hosted service).

Tests: remove `scripts/checks/plans.check.ts`, `partnership-rule.check.ts`, `tests/modules-basics.spec.ts`,
`modules-lapse.spec.ts`; reword `license.check.ts`, `base-license.check.ts`, `modules.check.ts`,
`modules-tenant.check.ts`, `modules-crossover.check.ts`, `tests/account.spec.ts`; make `scripts/checks/lib.ts:37`
(`grantDevLicense`, ~30 checks), `tests/helpers/modules.ts:11` (`setModule`, 17 specs) and
`scripts/demo/seed-demo.ts:137-138` no-ops first, delete later.

## 3. StitchHub

- `src/billing.mjs`: trial, Solo/Shop, founding and the plan price variables (57-263) and `waiverRule` (378-456): remove.
  `standingOf` (457-543): every shop not on the owner's hosting is free forever. `keyFor`/`claimAnswer` (546-632): keep
  the answer shape and sign forever keys (plan `c`, last day 2099-12-31, base plus add-ons). Checkout, switch, add-on,
  Assistant and top-up routes (680-898) and founding (1560-1578): remove. Portal (899), webhook (1499), refunds and
  disputes, Lapse now (1528-1544), dunning (1579-): keep for hosting.
- `src/addons.mjs`: remove, after its comp path (187-225) is made the rule for every shop. `src/assistant-billing.mjs`:
  question 4. `src/assistant.mjs` metering and caps (6-27, 220-305): keep; "Settings → Modules" (270, 290): reword.
- `src/license.mjs`: keep (reset grants 65-78, the forever keys). `src/db.mjs:26-33` `paysOwnWay` (backup quotas,
  `backups.mjs:27-34,75,123`, and the free plate-read limit): reword to mean "hosting customer".
  `src/repository.mjs:127` refuses lapsed shops: remove. `src/provisioning.mjs:1-145` "Start a hosted shop": keep for
  hosting, plus a payment step.
- `src/accounts.mjs:204-236` (standing, waiver, claim answer), `:398-461` (billing for the account page): reword; the
  comp route (715-740) stays. `public/account.html:84-85,182-327,439-440` (plans, founding, add-ons, Assistant
  purchase): remove; keep the shops table, hosted start (91-100), resets and restore codes. `public/admin.html:89-97,
  463-522`: reword.
- Variables to delete (none are set): `STRIPE_PRICE_{SOLO,SHOP}_{MONTHLY,YEARLY}[_FOUNDING]`, the old
  `STRIPE_PRICE_MONTHLY/YEARLY`, `STRIPE_PRICE_{VAC,APPLIANCE,SCHEDULING,MARKETING,MAKER,BUNDLE,STORE}_*`, and
  `ASSISTANT_*` depending on question 4. Keep `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `HUB_LICENSE_*`; add
  `STRIPE_PRICE_HOSTING_*`. Migrations 014, 018-022, 027 and 032 stay; no table is dropped.
- README 261-264, 273-416 (Billing), 418-427, 461-508: reword. Tests: `test/billing.mjs` rewritten for hosting,
  `addons-billing.mjs` removed, `assistant-billing.mjs` per question 4; touch `accounts.mjs`, `terms.mjs`, `move.mjs`,
  `provisioning.mjs`, `backup.mjs`, `package.json:11-33`.

## 4. Website

- `src/lib/site.ts:33-90` (`PLANS`, `SOLO_LOGINS`, `FOUNDING_*`, `TRIAL_DAYS`, `GRACE_DAYS`, `MODULE_PRICES`,
  `BUNDLE_PRICE`, `ASSISTANT_*`, `moduleMailto`): remove. `SETUP_HELP_PRICE`: keep; `DEDICATED_HOSTED_APPROX`: reword.
  16-23 ("sells the subscription", "the code repos are private"): reword; add the hosting price, the source link and
  the YouTube channel.
- `app/pricing/page.tsx:25-28,123-311,331-366`: rewrite as Free / Hosting / Help; setup help (313-329) stays.
  `faq/page.tsx:39-40,66,83-117,119,147`: reword; add "Is it open source?" and "What do you charge for?".
- Reword `page.tsx:11,35,42,80-85,144-148,186-196`, `signup/page.tsx:7-24,78,90-123`,
  `stitchbench/page.tsx:29,35,137-149`, `stitchshop/page.tsx:30,37,86-88,98,150,163`,
  `features/page.tsx:28,110,123,170-171,218-225`, `download/page.tsx:13,225,238`,
  `content/guides.tsx:54,78,145,162,246,380-381,393,419,473`, `README.md`.

## 5. Legal drafts

The hub's `legal/terms-2026-10-03-draft.md` and SB's `docs/legal/terms-of-service-DRAFT.md` are identical. Section 4
(58-79, hosting "included in your subscription", self-hosting licence undecided): the code is AGPL, hosting is paid.
Section 5 (81-98, price): hosting plus support. Section 6 (100-132): keep renewal, tax and failed payment for hosting;
drop trial and partnered text. Sections 7 (read-only when lapsed) and 8 (refunds): keep for hosting. Section 9
(181-198, limited licence, "get around licence keys", no reverse engineering): AGPL governs the code, the terms
govern the services. Sections 14 and 16: reword. Privacy 5.1 and 5.8: reword (the two privacy copies have drifted:
only the hub's has 5.2a). SB `docs/legal/README.md:81-118`: rewrite. The lawyer reviews all of it.

## 6. Packages

0. **Owner, 15 minutes, no code:** comp every shop forever with everything; keep Stripe closed.
1. **Hub: free for all** (about half a day): every shop free forever and every claim carries forever keys; trial,
   waiver, founding and plans go. Once deployed, installs in the field become free at their next sync, no update needed.
2. **StitchBench: free for all** (about 2 days): Settings → Features instead of keys; the key screens, Solo limit,
   banners, store fee, Companies switch and key tools go; checks and specs updated; release 1.8.
3. **Hub: plan and add-on billing removed** (about 1 day): checkout routes, account and admin screens, variables,
   `addons.mjs` and its tests, the README.
4. **Hosting billing** (about 2 days, after questions 1-2): mark the owner's hosted installs; one hosting price through
   the existing Checkout, Portal, webhook and dunning; read-only only where `HOSTING_BILLING=on`. Support sold through a
   Stripe Payment Link or a one-time Checkout.
5. **Website and legal** (about 1.5 days, plus the owner and the lawyer): rewrite the site and the drafts; HANDOFF
   section 4 gets this decision, and the superseded pricing and billing designs are marked as such.

Order: 0, 1, 2, then 3 and 5 side by side, then 4. The open-source switch itself (new repositories, private notes and
data) is separate: the kit on branch `open-source-kit`.

## 7. Questions for the owner (recommended answers first)

1. **Hosting price.** Recommended: one price per location, $25 a month or $250 a year, every login and every feature,
   30 days free without a card. A dedicated copy stays "at cost, about $10 extra".
2. **Unpaid hosting.** Recommended: as today: 14 days' grace, then read-only, with export and "move to the Windows
   program" always open (the program is free, so nobody is stuck); the data is deleted 90 days after it lapses, after
   two emails.
3. **Support.** Recommended: the Help button stays free (best effort). Paid: setup and import help $99 once (as today)
   and help sessions by the hour for any shop, Windows, self-hosted or hosted; email help included with hosting. Sold
   with Stripe Payment Links on the website, no new code.
4. **The Assistant** (about $1-2 a shop a month at 300 calls). Recommended: included with hosting; other shops buy it as
   before ($15 a month for 300 calls through the hub, $10 top-ups); later, an option to use the shop's own Anthropic key.
5. **Founding prices.** Recommended: drop them (nothing was sold); test-month shops get 12 months of hosting free if
   they use hosting.
6. **Modules.** Recommended: every module free, switched on per shop in Settings → Features, off until chosen, so
   screens stay simple (ease-of-use principle).
7. **Partnership waiver.** Recommended: drop it. A quilt shop runs StitchShop free on its own PC, or pays hosting like
   anyone (its repair shop may pay for it).
8. **Off-site backups** (25 GB a company on the owner's R2). Recommended: included with hosting; Windows shops get
   5 GB free.
9. **Extra stores.** Recommended: free on Windows and self-hosted; on hosting each location is charged like the first.
10. **Open source details.** Decided: AGPL-3.0-only, clean history, the names kept as trademarks (TRADEMARKS.md).
    Recommended: no CLA or sign-off; contributions come in under the same license.
