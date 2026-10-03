# Terms and privacy: drafts, publishing, and what's left to decide

**Status (3 Oct 2026): drafts for review by a lawyer; not legal advice; not yet in force.** The hub shows them as
version `2026-10-03-draft` (copies in the hub repo's `legal/`) under a "DRAFT, not yet in force" banner until the owner
publishes a version (package `terms-launch`, section 1).

| File | What it is |
|---|---|
| `terms-of-service-DRAFT.md` | The Terms of Service for StitchBench, StitchShop and StitchHub (one agreement, the owner's company) |
| `privacy-policy-DRAFT.md` | The Privacy Policy for the same three |
| `README.md` | This file: how versions are published, what to fill in and decide, and the checklist |

Both drafts mark open points inline:

- `[LAWYER: ...]` is a question for the lawyer (24 in the Terms, 15 in the Privacy Policy).
- `[OWNER: ...]` is a fact or choice for the owner (20 in the Terms, 13 in the Privacy Policy). Many are places where
  the draft states what the code does today and the owner should either accept it or change the code.
- `[30]`, `[45]`, `[90]` are suggested numbers of days the owner sets.

Sources the drafts were written from: `docs/plans/hub-accounts-billing-design.md` (4.2 and 9),
`docs/plans/ai-assistant-scope.md` (2.2 to 2.4 and 4), `docs/HANDOFF.md` section 4, `docs/plans/online-and-parts-design.md`
section 3, `docs/plans/company-move-design.md`, `INSTALL.md`, `prisma/schema.prisma`, `src/lib/messaging/`,
`src/lib/hub.ts`, `src/lib/offer.ts`, the hub's `README.md`, `src/accounts.mjs`, `src/billing.mjs`, `src/partners.mjs`,
and Anthropic's and Stripe's published terms as read on 3 Oct 2026 (links in the drafts).

## 1. How versions are published

**One version string for both documents**, in the form **`YYYY-MM-DD`**: the date that version comes into force
(for example `2026-11-15`). If only one document changes, both get the new date; the hub records one version per
account, so one string keeps that simple. A same-day second version is `YYYY-MM-DD.2` (avoid it). While a version is a
draft its string ends in **`-draft`** (today `2026-10-03-draft`), and the hub's pages carry a "DRAFT, not yet in force"
banner over it.

**Where they live** (package `terms-launch`, built 3 Oct 2026; the hub's `src/terms.mjs` and README "Terms of Service
and Privacy Policy"):

- On the hub, as markdown: `legal/terms-<version>.md` and `legal/privacy-<version>.md` in the hub repo (shipped in its
  Docker image), rendered to HTML when asked (headings, paragraphs, lists, quotes, tables, links, bold, italic and
  code; everything else escaped; no script on the page). Never edit a published pair: add a new one.
- **`/terms`** and **`/privacy`** show the version in force, with the version in the page's first line; old versions
  stay readable at **`/terms/<version>`** and **`/privacy/<version>`**, saying they are earlier and linking the current
  one.
- The version in force is the hub's **`TERMS_VERSION`** variable (Railway), or when it is unset the newest pair on file
  (drafts don't count once a published version exists). `GET /v1/terms/current` names it (no key needed).
- The programs follow the hub: Settings → Account asks the hub for the version in force (kept 10 minutes) and shows it
  next to the tick; `TERMS_VERSION` in `src/lib/hub-account.ts` (`"2026-10-03-draft"`) is only the fallback when the
  hub doesn't answer. A new version needs no program release.

**How acceptance is recorded** (the hub keeps the latest on the account, `accounts.terms_version` and `terms_at`, and
every acceptance in `terms_acceptances`: version, how, and for a Checkout the shop and the Checkout Session):

| When | How it's recorded |
|---|---|
| Account started from the program (Settings → Account, the tick) | the version the page showed, sent as `termsVersion` (via `program`) |
| Account made on the hub (`/account` → Create an account, the tick) | the version in force (via `signup`) |
| Each Stripe Checkout (Subscribe) | the version in force, every time (via `checkout`), and in the subscription's Stripe metadata (`hub_terms_version`). An account behind the version in force must tick the box first |
| A newer version is out | `/account` shows "We updated our terms" with a tick at the next sign-in (via `account`); Settings → Account shows the version accepted and, when the hub has a newer one, a line pointing to the account page. The claim answer carries `terms: { version, accepted }`, so the program learns what the account accepted on the hub |

**Links to the pages** (design 4.2): Settings → Account, the hosted `/signup` and the login page footer (both only
when the install is on a hub; the Windows first-run sign-up shows nothing, since the install joins a hub later), the
hub's `/account` (sign-up tick, footer) and front page. Not yet: Settings → Assistant (the Assistant isn't built).

**Turning a draft into a published version:** fill every placeholder; settle every `[OWNER]` and `[LAWYER]` note and
delete it; delete the draft's own banner; set the version line; add the pair to the hub repo's `legal/` as
`terms-<version>.md` and `privacy-<version>.md` (the version without `-draft`); deploy the hub and set
`TERMS_VERSION=<version>` on Railway on the day it comes into force; update this folder's drafts to match. Every
account is asked to accept it at its next sign-in on the hub, and before its next Checkout.

## 2. Placeholders to fill in

| Placeholder | What goes there |
|---|---|
| `[OWNER LEGAL NAME]` | The legal name of the business that sells the programs (the owner's company, or the owner's own name as a sole proprietor, with any "doing business as" name) |
| `[ADDRESS]` | The business's postal address for notices |
| `[STATE OF GOVERNING LAW]` | The state whose law governs the Terms (usually the owner's home state) |
| `[CONTACT EMAIL]` | One address for privacy, refunds and notices, read at least weekly (for example on the owner's domain, next to the billing mailbox decided in design 9.9) |
| `[HUB ADDRESS]` | The hub's public address. Today `https://stitchhub-production.up.railway.app`; a domain of the owner's own is better before publishing, since the address is in every program's links |
| `[VERSION DATE, YYYY-MM-DD]` | The version string, the day it comes into force |
| `[OWNER: mail provider]` (Privacy 5.6, 7) | Who sends the hub's and hosted service's account and reset emails (`SMTP_URL`, `PLATFORM_SMTP_URL`) |

## 3. Decisions for the owner

Already decided and written into the drafts (don't re-ask): Solo $25 a month or $250 a year (up to two people
signed in) and Shop $45 or $450 (everyone), founding shops at $15 / $30 (decided 3 Oct 2026), all three ways of
running; free while partnered as the retail side; 30-day trial per shop; 14 days of grace; lapsed = read-only, never
data loss; refunds: 14 days full refund on a first charge, otherwise none, yearly pro rata at the owner's discretion;
no sales tax on the subscription for now; account email = owner login; account deletion by the owner on request; the
hub free to everyone; sharing chosen per item ("offer"); the Assistant through the hub with no prompt text kept on
the hub, first names off by default, the privacy page says what is sent.

Still to decide (each is an `[OWNER]` note in the drafts):

1. **Notice periods**: before charging starts, before a price change, before ending a free plan, before a change to
   the terms (drafts say `[30]` days each).
2. **Subscribing during the trial**: the hub charges on the day of subscribing, not at the trial's end (Terms 6).
   Keep and say so, or change the hub.
3. **Refund and dispute lapse**: a refund lapses the shop at once, even inside its trial; a dispute does too and isn't
   undone automatically if you win (Terms 8). Keep or change.
4. **Never-connected Windows installs**: do the Terms still require a subscription after the trial, although the
   program keeps working (Terms 7)? Recommended: yes.
5. **Hosted service**: decided 3 Oct 2026: the shared hosted service costs the same as Windows, and a dedicated copy is
   at cost (about $10 a month on top); how often database backups run and how long they're kept; Railway region; how long a closed account's data
   is kept before deletion (`[90]` days suggested); notice if the hosted service ever closes (`[90]` days).
6. **Self-hosting licence**: this repository has no LICENSE file. Decide the terms self-hosting shops get the code
   under (Terms 4).
7. **Module prices** to publish (the Assistant planned at $15 / $150 with 300 requests and 20 free plate reads).
8. **The online shop's "hosted service's Stripe account" option** (Terms 13): payout schedule, fees, who bears refunds
   and chargebacks. And see lawyer question 4: it may not be allowed at all without Stripe Connect.
9. **Uptime promise** for the hosted service (recommended: none).
10. **Marketing email to shops**: none (draft), or product news with an unsubscribe.
11. **Assistant counts kept on the hub**: how long (2 years suggested).
12. **Customer deletion**: the program can't delete or merge a customer yet (HANDOFF 4, L126, decided not built). Say
    how a deletion request is handled until it can, or build it before publishing.
13. **Figure pictures go to the hub automatically** (see section 4 below): make it an "offer", or keep it and say so (the
    draft says so).
14. **Request logs**: check Railway's log retention for the hub and hosted services (Privacy 5.2).
15. **Answer time** for privacy requests (`[45]` days suggested).

## 4. Found in the code while drafting (the owner should know)

- **Figure snapshots are shared automatically.** `src/app/api/figures/route.ts` calls `shareFigure` whenever the
  program draws a factory-setting figure from a local manual and the install is on a hub. Every other kind of sharing
  is an explicit "offer" (`src/lib/offer.ts`), as the 27 Sep decision requires. The figure is a crop of a
  manufacturer's manual page with nothing about the shop in it, but it is not chosen per item.
- ~~The hub has no `/terms` or `/privacy` route, and Checkout doesn't record the terms version.~~ Built 3 Oct 2026
  (section 1).
- ~~The hub's README says members get the join key "after a one-time contribution toward server costs".~~ Fixed
  3 Oct 2026: it says membership is free.
- **Partner messages are readable by the hub's operator** (plain JSON, a year after delivery, three years at most).
  The Privacy Policy says so plainly; HANDOFF 4 item 6 (L134/I27, end-to-end signing) would let it say less.
- **The Assistant isn't built.** Privacy 5.7 and Terms 14 describe the design (ai-assistant-scope.md); check them
  against what ships.
- **Hub IP addresses** are held only in memory for rate limits (`bucket()` in the hub's `src/server.mjs`), never saved.
- **Move files** are streamed to the download and never stored on the server (`src/lib/move/export.ts`); uploads for
  an import are swept from the temp folder after 24 hours.

## 5. Questions for the lawyer (summary; the full wording is inline)

1. **Structure**: business-only terms (no consumer rules), authority to bind, minimum age 18; California's automatic
   renewal law and similar for sole traders.
2. **Data roles**: is the Terms' section 11 enough as a CCPA "service provider" contract for the hosted service, or is
   a separate DPA needed; GDPR/UK DPA only if non-US customers are possible; should we say "US businesses only".
3. **A repair shop hosting StitchShop** for its partners: what must our Terms require of it.
4. **The online shop through the hosted service's Stripe account**: Stripe's Services Agreement (section 1.2
   restrictions, "pass-through agent", updated 28 Sep 2026) and money-transmitter rules. Highest priority.
5. **Messaging**: TCPA, CAN-SPAM and state laws (Florida FTSA, Oklahoma OTSA and others); that the consent tools
   paragraph promises no more than the tools do; keeping consent records and opt-outs after a deletion request.
6. **Hub content**: scope and duration of the content licence, its survival after account deletion, names of people in
   edit history; copyright in manual figure crops; a DMCA agent and takedown process.
7. **The Assistant**: Anthropic's DPA and subprocessor listing; whether to pass through more of Anthropic's terms;
   re-check the quoted terms at publication.
8. **Sales tax on SaaS** and economic nexus; whether "we don't charge it now" is safe.
9. **Refund wording** ("at our choice" for yearly), chargeback handling.
10. **Warranty disclaimer, limitation of liability** (cap: 12 months' fees or $100; "lost data" next to the "never data
    loss" promise), **indemnity**, repair-information disclaimer.
11. **Changes**: "keep using = agree" or a fresh tick for material changes.
12. **Disputes**: courts or arbitration, venue, class-action waiver, small claims.
13. **Privacy specifics**: which state privacy laws apply at our size; cookie banner (none planned); COPPA where shops
    enroll children in classes; breach notification duties on the hosted service; subprocessor list format; request-log
    IP addresses; billing record retention period.
14. **Self-hosting licence** text, and the interplay with the hub's AGPL code.

## 6. Checklist before publishing

- [ ] Owner fills in every placeholder (section 2) and settles every `[OWNER]` note (section 3).
- [ ] Code changes the drafts rely on, or the drafts changed to match the code: figure sharing (an offer, or disclosed);
      customer delete/merge (L126) or a stated process. (Built 3 Oct 2026: terms recorded at Checkout; "We updated our
      terms" line; `/terms` and `/privacy` routes with archived versions; the hub README's "one-time contribution" line.)
- [ ] Lawyer reviews both drafts; every `[LAWYER]` note answered and removed.
- [ ] Anthropic and Stripe terms re-read on the publication date; quotes and dates in Privacy 5.7 updated.
- [ ] The Assistant sections match what shipped (or are left out until it ships).
- [ ] Version string chosen; the drafts' own banner removed; the pair added to the hub's `legal/` as
      `terms-<version>.md` and `privacy-<version>.md` and deployed.
- [ ] `TERMS_VERSION=<version>` set on the production hub on the day it comes into force (the programs follow the hub;
      `TERMS_VERSION` in `src/lib/hub-account.ts` is only the fallback, updated at the next release).
- [ ] Links checked from Settings → Account, hosted `/signup`, the login footer and the hub's `/account` (and
      Settings → Assistant once it exists).
- [ ] Existing account holders emailed about the first published version, and asked to accept at their next sign-in.
- [ ] HANDOFF.md updated: one of the owner's four conditions for charging ("terms/privacy page") is met.
