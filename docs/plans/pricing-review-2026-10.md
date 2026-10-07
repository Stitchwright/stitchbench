# Pricing review, October 2026 (for the owner)

Read-only review of the prices decided on 3 Oct 2026 (`pricing-recommendation.md`, HANDOFF section 4), checked
against competitors' prices read on **7 Oct 2026**, what the product now does, our own costs and the $5,000 and
$8,000 a month goals. Nothing in code or Stripe was changed. **Estimates are marked "(est.)".**

**Short answer.** The 3 Oct prices are right: about a quarter of Rain / Like Sew and under every repair-shop product
for the same work, while covering costs. Keep Solo $25 and Shop $45. Change five small things: a cheaper second store,
the ready-for-pickup text and estimate link in the base, Maker Shop inside the $30 bundle, an end date on the founding
offer, and a written "your data leaves with you" promise. Don't cut the base price because AI makes software cheaper
(section 4b).

## 1. Today's prices and what's in each

| Item | Monthly | Yearly | What's in it |
|---|---|---|---|
| **Solo** (up to 2 active logins) | $25 | $250 | The whole program: tickets, machines, factory specs and tension data, parts and parts-on-order, register, stock, gift cards, reports, the online shop, partner shops, the hub, the manual library, off-site backup, updates. The same for StitchBench and StitchShop, Windows or hosted |
| **Shop** (every login) | $45 | $450 | The same, with every login |
| Founding shops (first 25) | Solo $15, Shop $30 | $150 / $300 | Locked while the subscription runs with no gap over 60 days; two feedback calls in return. Test-month shops get 12 months free first |
| Partnered retail shop | $0 | $0 | Shop tier free while partnered with a repair shop in good standing (base only) |
| Scheduling | $15 | $150 | Classes, appointments, partner pickup runs, staff shifts |
| Marketing | $10 | $100 | Reminders, ready-for-pickup notices, estimate links, service reminders, review requests, campaigns (the shop pays its own email and Twilio texts) |
| Vac Shop | $10 | $100 | Vacuum repairs, bag/belt/filter finder, vacuum sales with warranty and trade-ins, bags-due, central vac installs |
| Small Appliance Repair | $5 | $50 | Mixers, 3D printers and other small appliance tickets |
| All four add-ons | $30 | $300 | The four above |
| Maker Shop (proposed in round-2 design, not built) | $10 | $100 | Supplies-due reminders, maker-space time, print/cut jobs; "in the everything bundle" |
| The Assistant (designed, hub billing built) | $15, 300 calls | $150 | Top-up of 300 calls for $10 (this month only) |
| Setup and import help | $99 once | | Optional; free for founding shops |
| Dedicated hosted copy | At cost, about $10 | | On top of the plan |
| Each extra store | Full plan price | | "Per location" (round-2 design 7: multi-store is designed, not built) |
| Hub, manual repository, online-order fee | Free / free / none | | The repository is free by design (legal: `manual-repository-design.md` L3) |
| Trial | 30 days, no card | | |

Where the prices live: Stripe prices named in the hub's `STRIPE_PRICE_*` variables (stitchhub `README.md`, "Prices"
and "Selling the Assistant"); the site's `stitchsite/src/lib/site.ts` (`PLANS`, `MODULE_PRICES`, `BUNDLE_PRICE`,
`ASSISTANT_*`, `FOUNDING_*`); modules are sold as license keys by email until the hub sells them.

Coming: sales tax rules, machines for sale, layaway (built on a branch, `tax-machine-sales-layaway-design.md`);
special orders, customer price groups, loaners, multi-store, Maker Shop, events (`shop-features-round-2-design.md`).
None of it changes the price list except Maker Shop and multi-store.

## 2. What they'd pay instead (read 7 Oct 2026, US$ a month)

"Vendor" = the vendor's own page. "3rd party" = a review site, used when the vendor hides the price; treat as rough.

| Product | Price | Unit | Notes | Source |
|---|---|---|---|---|
| **Rain POS / Like Sew** | Startup **$99** (billed yearly); Core and Plus not shown | Per account (stations) | Classes, consignment, loaners, trade-ins and multi-store need **Core**; work orders, serial numbers, texts, email marketing need **Plus**. So a sewing/vac shop with repair is on Plus. 3rd-party guesses for Core/Plus disagree ($79 to $349) | [rainpos.com/pricing](https://www.rainpos.com/pricing) (vendor); [koronapos.com](https://koronapos.com/blog/rain-pos-pricing/) (3rd party, unverified) |
| Lightspeed Retail | Basic $89, Core $149, Plus $289 (up to 18% off yearly) | Per location, 1 register | Extra registers and locations by quote | [lightspeedhq.com](https://www.lightspeedhq.com/pos/retail/pricing/) (vendor) |
| Square for Retail | Free $0, Plus $49, Premium $149 | Per location | 2.6% / 2.5% / 2.4% + 15c in person | [NerdWallet](https://www.nerdwallet.com/business/software/learn/square-fees), [upmenu.com](https://www.upmenu.com/blog/square-pricing) (3rd party, 2026) |
| Shopify POS Pro | $89 per location (yearly) on top of Shopify Basic $39 | Per location | 2.6% + 10c in person | [shopify.com/pos/pricing](https://www.shopify.com/pos/pricing) (vendor) |
| Clover retail | Starter $14.95, Standard $49.95, Advanced $69.95 software; bundles with hardware up to ~$240 | Per location, +$14.95 per device | 2.5-2.6% + 10c; hardware $1,600+ or financed | [costbench.com](https://costbench.com/software/retail-pos/clover-retail/), [koronapos.com](https://koronapos.com/blog/clover-pos-pricing/) (3rd party) |
| MicroBiz Cloud | Single store $60-65 ($600/yr); multi-store $90-95 ($900/yr) | Per store | | [itqlick.com](https://www.itqlick.com/microbiz-cloud/pricing), [Capterra](https://www.capterra.com/p/129283/MicroBiz/pricing/) (3rd party) |
| RepairShopr (Syncro) | Starter $69.99 ($59.99 yearly), Repair Shop $139.99 ($129.99), Big Chain $149.99 | Starter: 1 user, 75 tickets/mo | Texts bought extra | [repairshopr.com/pricing](https://www.repairshopr.com/pricing) (vendor) |
| RepairDesk | Essential $99 ($79 yearly), Growth $149 ($119) | Per store, 5 or 8 users | Email campaigns, appointments, loyalty, gift cards are paid add-ons on Essential | [repairdesk.co/pricing](https://www.repairdesk.co/pricing/) (vendor) |
| Orderry (ex-mHelpDesk-style) | Hobby $39, Startup $69, Business $99, Enterprise $199 | 2-3 users; extra location $49-$179 | 10% off yearly | [orderry.com/pricing](https://orderry.com/pricing/) (vendor) |
| CellSmart POS | Starter $79, Growth $99, Premium $119 | Per store | Setup $500-$2,000 | [itqlick.com](https://www.itqlick.com/cellsmartpos/pricing) (3rd party) |
| Acuity Scheduling | $16 / $27 / $49 yearly ($20 / $34 / $61 monthly) | 1, 6 or 36 calendars | Texts from Standard | [acuityscheduling.com/pricing](https://acuityscheduling.com/pricing) (vendor) |
| Square Appointments | Free (1 staff), Plus $29, Premium $69 | Per location | | [koalendar.com](https://koalendar.com/blog/square-appointments-pricing) (3rd party, 2026) |
| Mailchimp | Free to 250 contacts; Essentials from $13, Standard from $20 (500) | By contacts | | [automationatlas.io](https://automationatlas.io/answers/mailchimp-pricing-explained-2026/) (3rd party) |
| Constant Contact | Lite $12, Standard $35 (500 contacts) | By contacts | No free plan | [sendx.io](https://www.sendx.io/blog/constant-contact-pricing) (3rd party) |
| SimpleTexting | $39 for 500 texts, $59 for 1,000 | By credits | 20% off yearly | [textbolt.com](https://textbolt.com/blog/simpletexting-pricing/) (3rd party) |
| CommentSold (live sales) | $149 / $499 / $999 (older plans $49 + 5% of sales) | Per account | Moved off commission in 2024 | [pricingsaas.com](https://pricingsaas.com/companies/commentsold) (3rd party) |

**The replacement stacks** (monthly, before card fees):

| Shop type | What they'd buy instead | Their cost | StitchBench / StitchShop (recommended) |
|---|---|---|---|
| Repair-only tech, 1-2 people | RepairShopr Starter (75 tickets) or Orderry Hobby, + texts | $39-$70 | **$25** (Solo; pickup texts in base) |
| Small quilt shop, 2-5 staff, classes | Square Plus $49 + Acuity Standard $27-34 + Mailchimp $13-20 | **$89-$103** (or $0 on Square Free + Eventbrite, paid by students) | $45 + Scheduling $15 + Marketing $10 = **$70**; **$25** if partnered |
| Sewing dealer with repair | Rain/Like Sew **Plus** (price hidden; Startup alone $99) or Lightspeed Core $149 + a repair tool | **$150-$250** (est.) | Shop $45 + Scheduling + Marketing = **$70**, or **$75** with the bundle |
| Vacuum + sewing dealer | Same as above + a vac system (AIM, Stride: hidden) | **$150-$250** (est.) | Shop $45 + bundle $30 = **$75** |
| Two-store shop | Lightspeed 2 x $89-149, Square 2 x $49, Rain Core | **$98-$300** | $45 + extra store $25 + bundle $30 = **$100** (today's rule: $120) |

**Card processing, honestly.** Square, Clover, Lightspeed, Shopify and Rain earn on every card swipe; Square Free is
"free" because Square keeps about 2.6% + 15c (about $535 a month on $20,000 of card sales). We take **no cut**: the
online shop uses the shop's own Stripe account (2.9% + 30c online, Stripe's list rate) and the counter keeps whatever
reader the shop has until Stripe Terminal ships (2.7% + 5c list, check before quoting). So the fair comparison is
**software fee to software fee**; processing costs about the same anywhere (2.5-2.9%), and we should say "no markup on
your card fees", never "cheaper processing". A 0.1-point rate difference on $20,000 is $20 a month, so a shop that
negotiated a low rate may still prefer its current processor; we let it keep it.

## 3. Value per shop type (what they get, what it replaces)

| Shop type | Gets | Would otherwise pay | Time saved (est., defensible) |
|---|---|---|---|
| Repair-only tech | Tickets, factory specs and tension data, test-mode notes, parts on order, partner network, manuals, pickup texts | $39-$70 a month, or paper | 2-3 hours a month: no phone calls for "is it ready", no hunting for the tension spec, estimates approved by link |
| Small quilt shop | Register with decimal yards and fat quarters (Square can't), classes with seats and waitlist, online shop with no order fee, email/texts | $89-$103, or a free but clumsy Square setup | 3-5 hours a month: class rosters and reminders, fewer manual stock counts |
| Sewing dealer with repair | All of the above plus machines for sale with serials and warranty, layaway, service plans | $150-$250 (Rain Plus or Lightspeed + repair tool) | 4-6 hours a month: one system instead of two, warranty registration reminders |
| Vacuum + sewing dealer | Plus bag/belt finder, vac warranty, bags-due reminders, central vac installs | $150-$250+ | Bags-due reminders bring repeat sales; worth more than time |
| Two-store shop | Shared customers, gift cards and stock across stores (when multi-store ships) | $100-$300 | Avoids two separate systems |

At a tech's median $75 an hour (owner's 23 Sep research), 2 hours saved is $150 a month: six times the Solo price.

## 4. Recommendation

| Item | Monthly | Yearly | Change from today |
|---|---|---|---|
| **Solo** (up to 2 logins) | **$25** | **$250** | Same |
| **Shop** (every login) | **$45** | **$450** | Same |
| **Each extra store** in the same company | **$25** | **$250** | **New**: was the full plan price again |
| Founding shops | $15 / $30 | $150 / $300 | Same price; **offer closes at 25 shops or 6 months after paid launch**, whichever first |
| Partnered retail shop | $0 base | | Same; "real partnership" = at least one repair job between the two shops in the last 6 months (est. check by hand at first) |
| Trial | 30 days, no card | | Same |
| Ready-for-pickup text and estimate-approval link | In the base | | **Moved** out of Marketing (a repair tool without them looks incomplete; costs us nothing) |
| Marketing | $10 | $100 | Keeps campaigns, service-due, review requests, abandoned-machine notices, reminders |
| Scheduling | $15 | $150 | Same |
| Vac Shop | $10 | $100 | Same |
| Small Appliance Repair | $5 | $50 | Same |
| Maker Shop (when built) | $10 | $100 | New module, as designed |
| **All add-ons** (now five) | **$30** | **$300** | Same price, Maker Shop added |
| The Assistant | $15, 300 calls | $150 | Same; top-up 300 calls $10. Not in the bundle |
| Setup and import help | $99 once | | Same |
| Dedicated hosted copy | At cost (about $10) | | Same |
| Hub, manual repository, online-order fee | Free / free / none | | Same (repository can never be paid: legal) |
| Promises (on the pricing page) | | | **New wording**: export everything any time, also when lapsed; existing shops keep their price 12 months after a rise with 60 days' notice; founding price for life of the subscription |

**Why not higher.** At $45 a staffed shop pays just under Square Plus ($49), the price a quilt shop already knows,
and a one-bench tech's alternative is paper. Rain's own reviewers call it "expensive"; being clearly a quarter of Rain is
the pitch. **Why not lower.** Support time, not servers, is our main cost (below); at $15-20 a shop we couldn't pay
for an hour of help a quarter.

**Why the extra store at $25.** The second store adds almost no server cost or new learning, and $45 + $25 = $70 is
well under two Lightspeed or Square locations while still paying for support. There are few multi-store shops, so the
revenue at stake is small.

### 4a. Unit economics (per shop per month, est.)

Our costs: **Railway** shared hosted instance about $14 of resources for all shops, under $1 per added shop; the hub
a few dollars; **R2** backups under $0.10 a shop, manual repository under $10 at 50,000 files (fixed); **email and
texts**: the shop's own SMTP and Twilio, so $0 to us; **Stripe** 2.9% + 30c a card charge + 0.7% Billing; **the
Assistant** at the repo's rates (Claude Haiku 4.5 $1/$5 per million tokens, Sonnet 5.5 $2/$10): 0.25c to 1.9c a
call, about **1.2c average, $3.60 at the full 300** (`ai-assistant-scope.md`). Fixed costs about **$383 a month**
(HANDOFF 4). Support: assumed 15-20 minutes a shop a month after setup, valued at $50 an hour (est.).

| Plan | Price | Stripe | Servers, hub, R2 | API | Cash margin | After support time |
|---|---|---|---|---|---|---|
| Solo monthly | $25.00 | $1.20 | $1.00 | | **$22.80 (91%)** | $10.30 (15 min) |
| Solo yearly | $20.83 | $0.78 | $1.00 | | $19.05 (91%) | $6.55 |
| Shop monthly | $45.00 | $1.92 | $1.50 | | **$41.58 (92%)** | $24.91 (20 min) |
| Shop yearly | $37.50 | $1.38 | $1.50 | | $34.62 (92%) | $17.95 |
| Extra store | $25.00 | $0.90 | $1.00 | | $23.10 (92%) | $18.93 (5 min) |
| Founding Solo | $15.00 | $0.84 | $1.00 | | $13.16 (88%) | $0.66 |
| Add-on module ($10) | $10.00 | $0.36 | | | $9.64 | |
| Assistant, full use | $15.00 | $0.54 | | $3.60 | **$10.86 (72%)** | |
| Assistant top-up | $10.00 | $0.66 | | $3.60 | $5.74 | |
| Partnered free shop | $0 | | $1.50 | | **-$1.50** | -$14 (15 min); breaks even with Scheduling |

Two lines: **cash cost is about $2-3.50 a shop a month, so cash margin is about 90%; the real cost is support time,
which takes about half the Solo margin and all of a free partnered shop's.** Guides, community answers on the hub and
the paid $99 setup are what keep the model working.

### 4b. Pricing when AI makes software cheap

1. **What stays scarce.** A generic register, ticket list or booking page will soon be cheap to build, and some
   competitor will sell one at $10. What an AI-built clone can't copy quickly: the **hub's network** (partner repairs
   between shops, the parts marketplace, shop hops, the shared manual repository); the **reference data** (factory
   tension specs, service modes, the community's gotchas); **trust and support from a real sewing machine tech**;
   the shop's own history and the integrations around it; sewing-specific depth (decimal yards, fat quarters,
   serial-number warranty, bags-due); and a program that **just works for older, non-technical staff**.
2. **How the price should reflect it.** Keep the program itself cheap (it already is: a quarter of Rain), and charge
   for what grows with use: the **Assistant** (paid per allowance), **extra stores**, and the trade **modules**. Two
   things can't be charged for: the **manual repository** must stay free (a paid one weakens the takedown safe
   harbor, `manual-repository-design.md` L3), and the **hub stays free** (owner decision, "community first"). So the
   network is not sold directly; it is **why the $25 base is worth paying instead of a free clone**. Add a
   **portability promise** (export everything any time, also when lapsed): it costs nothing and removes the main fear
   of switching.
3. **Risks.** Too high now: a cheap clone, or Square adding sewing features, undercuts us before the network is big
   enough to hold shops. Too low: we can't fund support, the thing a clone can't copy, and $10-15 reads as a hobby to
   a dealer used to $99 invoices.
4. **Would a lower base with paid network features beat today's structure?** **No, not now.** The network features
   that compound can't be paid (repository) or were promised free (hub), so a lower base would only lose revenue:
   cutting Solo to $15 takes about $10 a shop with no clear gain, because what stops shops is switching effort and
   trust, not $25. Already at a quarter of Rain, we are the price outlier. **Revisit in 12 months**, or sooner if a
   free or $10 sewing-shop clone appears: then the move is a free ticket-only tier for one-bench techs (feeding the
   hub network), with everything else paid as now.

## 5. Path to $5,000 and $8,000 a month (after fixed costs, before the owners' own support time)

Assumptions (est.): 60% Solo / 40% Shop; 30% pay yearly; $10 of add-ons per paying shop on average; 25 founding
shops; partnered free shops roughly cover themselves through add-ons. Net per regular paying shop after Stripe,
servers and API: **about $37**; per founding shop about $26. Fixed costs $383.

| Goal | Net needed | Paying shops (incl. 25 founding) | If add-ons average only $5 |
|---|---|---|---|
| **$5,000** | $5,383 | **about 152** | about 173 |
| **$8,000** | $8,383 | **about 233** | about 265 |

This matches the owner's earlier calculator (148 and 225).

**Adoption, realistically (est.).** 150 paying shops is a small share of the market: about 3,200 quilt shops (2018
figure, likely fewer now), plus independent repair techs and sew-and-vac dealers (no reliable count found). But most
quilt shops will come in free through a partner, so the payers are mainly techs and dealers. With word of mouth in
the techs' Facebook groups, partners and VDTA, 4-8 new paying shops a month after the founding 25 is a realistic
range; at that pace $5,000 comes around **month 18-30** and $8,000 around **month 30-45**. Small-business software
loses roughly 1.5-3% of shops a month (est.), so at 230 shops about 4-6 a month must be replaced. Joann's 2025 closure
and tariff repricing are the hooks for new quilt-shop interest; the hub network is what keeps shops.

## 6. What changes in code and config

| Change | Where |
|---|---|
| Extra store at $25 / $250 | New Stripe prices on the one product; new hub variables (suggested `STRIPE_PRICE_STORE_MONTHLY`, `STRIPE_PRICE_STORE_YEARLY`, comma lists like the others) sold as a quantity on the subscription; the key carries the store count. Fold into the multi-store package (round-2 section 7), not before. Site: a line in `PLANS`/FAQ in `stitchsite/src/lib/site.ts` |
| Pickup text and estimate link in the base | `src/actions/notices.ts` (`requireOn(user, "marketing")`) and the estimate-link action and pages: gate the two notices on the base instead of `marketing`; keep campaigns, service-due, reviews, abandoned-machine notices on Marketing. Update the Marketing blurb in `src/lib/module-info.ts`, the site features/pricing copy, HANDOFF 4 |
| Maker Shop $10 inside the $30 bundle | When built: a `maker` module id in `src/lib/module-info.ts`; the bundle key covers five modules; `MODULE_PRICES` and the `BUNDLE_PRICE` comment ("All four") in `site.ts` |
| Founding offer end date | No code: the owner stops marking founding accounts at 25 or the date. Site: say the date next to `FOUNDING_SPOTS_LEFT` |
| Partnership activity test | Hand check at first; later a hub check (a partner job in 6 months) |
| Portability and price-lock promises | Site pricing/FAQ and terms page; confirm export works while read-only (lapsed) |
| Unchanged | Solo, Shop, founding and Assistant Stripe prices and their hub variables; module prices |

## Owner questions (recommended answer first)

1. **Keep Solo $25 / Shop $45?** Yes. Don't lower for the AI era now; revisit in 12 months or if a cheap clone appears.
2. **Second and later stores at $25 / $250 each instead of the full plan price?** Yes, when multi-store ships.
3. **Move the ready-for-pickup text and estimate-approval link into the base?** Yes; Marketing keeps the rest at $10.
4. **Maker Shop $10, inside the $30 all-add-ons bundle (now five)?** Yes.
5. **Close the founding offer at 25 shops or 6 months after paid launch, whichever first?** Yes.
6. **Define "real partnership" as at least one repair job between the shops in the last 6 months?** Yes, checked by
   hand until the hub can count it.
7. **Put the promises in writing (export any time, also when lapsed; 12-month price hold with 60 days' notice;
   founding price for life)?** Yes.
8. **Keep the Assistant as a $15 add-on (300 calls, $10 top-ups), out of the bundle and the base?** Yes: it is the one
   item whose cost grows with use.
