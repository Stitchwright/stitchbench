# Pricing recommendation for StitchBench and StitchShop (3 Oct 2026, for the owner)

This document sets out what comparable products charge, whether the decided prices fit each kind of shop, and a
recommended price list with the decisions it needs. Nothing here changes code or the site. The prices live in
`stitchsite/src/lib/site.ts` and in the hub's Stripe prices (`hub-accounts-billing-design.md` section 3.3).

Sources read for this: HANDOFF sections 3 (items 13 and 19) and 4; the billing, later-round-1 and Assistant designs;
and the site's `site.ts`, /pricing and /features pages. The owner's business notes in `C:\Manuals\_business-notes`
are about the repair business's own prices, not about software:
- `PRICING_RESEARCH_2026-09-23.md` is used for what a tech earns (median tune-up $123 across 34 shops, median labor
  $75 an hour) and for the traveling-tech model, where one tech serves several quilt shops.
- `MARKET_READ_BoardRepair`, `TWO_TRACK_MODEL` and `FB_GROUP_INTEL` cover board repair and are not used.

## 1. What comparable products charge

Prices were read on 3 Oct 2026, in US dollars a month.
- "Vendor" means the vendor's own pricing page.
- "Third party" means a review site, used because the vendor page showed no prices. Its date is given where it had one.
- "Not published" means exactly that. No number was guessed.
- Card processing is extra on every product.

### 1.1 Repair-shop software

| Product | Monthly price | Unit and limits | Notes | Source |
|---|---|---|---|---|
| RepairShopr | Starter $69.99 ($59.99 yearly); Repair Shop $139.99 ($129.99); Big Chain $149.99 ($139.99) | Per account. Starter: 1 user, 1 location, 75 tickets a month. Repair Shop: 10 users, unlimited tickets. Big Chain: 2+ locations | POS, estimates, invoices, customer portal and QuickBooks on every tier; texts bought as credits | repairshopr.com/pricing (vendor) |
| RepairDesk | Essential $99 ($79 yearly); Growth $149 ($119); Advanced by quote | Per store; 5 users on Essential, 8 on Growth | Unlimited tickets; texts, appointments and email campaigns are paid add-ons | repairdesk.co/pricing (vendor) |
| Orderry | Hobby $39; Startup $69; Business $99; Enterprise $199 | Hobby: 2 staff, 100 orders a month. Others: 3 users, then $6 to $19 per extra user and $49 to $179 per extra location | 10% off yearly; 7-day trial | orderry.com/pricing (vendor) |
| mHelpDesk | Not published | Third-party guesses of $99 to $169 per user, unverified | Field service (HVAC, plumbing), not bench repair | Capterra lists "contact vendor" |
| RepairStorePOS | $39 | Per store; unlimited users and tickets | Month to month, no setup fee, 14-day trial | repairstorepos.com (vendor) |
| Jobber (field service) | Core $29 to $49, depending on commitment; Connect $99 to $139 | 1 user included, $29 a month for each extra | An example of per-user pricing | getjobber.com/pricing (vendor) |
| ServiceM8 (field service) | $0 to $349, by jobs a month (Starter $29 for 50 jobs) | Unlimited users | Texts included; no POS or stock | servicem8.com/us/pricing (vendor) |

### 1.2 Sewing, vacuum and quilt-shop systems

| Product | Monthly price | Unit | Notes | Source |
|---|---|---|---|---|
| Like Sew (sew and vac, quilt) | Startup $99 (billed yearly); Core and Plus not published | Priced by stations (1 to 5+); unlimited users | Startup has POS, website and stock. Classes come with Core. Work orders, serial numbers and texts come with Plus, so a repair shop pays more than $99 | likesew.com/pricing and likesew.com/sew-and-vac (vendor) |
| PayGo (quilt shop) | $1,200 the first year, then $120 a month | Each extra workstation $70 a month | Fabric fractions, class rosters and emails, loyalty, Mailchimp, a Shopify link | paygopos.com/quilt-shop-pos (vendor) |
| Rain POS (quilt, sewing, craft) | Not published ("custom quote") | Third-party estimates disagree, from $49 to $349; setup $500 to $1,000+ (third party) | Classes, a website with live stock, fabric cuts, loyalty | rainpos.com (vendor post, Jul 2025); the estimates are unverified |
| RetailEdge | $495 once, with 90 days of support (third party) | Per licence | Support is paid after the 90 days | Rain's blog, Jul 2025 |
| Stride Retail (sew and vac) | Not published | | POS, stock, service orders; demo on request | strideretail.com (vendor) |
| AIM by Tri-Tech (vacuum) | Not published | The base package is 1 workstation and 1 location; more licences cost extra | Repairs, warranty, rentals, classes; the vendor is a VDTA member | vacuumpointofsalesoftware.com (vendor) |
| RepairTRAX (sew and vac repair) | Not published (advertised as "half your daily coffee") | | Tickets, text and email notices, QuickBooks | repairtrax.com (vendor) |

### 1.3 General point of sale

| Product | Monthly price | Unit | Notes | Source |
|---|---|---|---|---|
| Square for Retail | Free $0; Plus $49; Premium $149 | Per location | In person: 2.6%, 2.5% or 2.4% + 15c by plan. Online: 3.3% + 30c on Free, 2.9% + 30c above. Older pages give Plus as $60 or $89 | NerdWallet review, 17 Feb 2026 (third party; Square's page loads its prices by script) |
| Lightspeed Retail | Basic $89; Core $149; Plus $289, billed yearly. About $109, $179 and $339 month to month (third party) | Per location, with one register each; extra registers cost extra (price not published) | Stock, payments and a web store on Basic | lightspeedhq.com/pos/retail/pricing (vendor) |
| Shopify | Basic $29 billed yearly or $39 monthly; POS Pro $89 per location | Per store; POS Lite included | Online store included; classes need an app; 2.6% + 10c in person on Basic | shopify.com/pricing (vendor) |
| Clover | Starter $79; Standard $149; Advanced $189 (third party) | Per location | Station Duo hardware costs $1,599 to $1,899, or about $180 a month over 36 months; terms vary by reseller | koronapos.com and paymentcloudinc.com (third party, 2026) |

### 1.4 Class and appointment booking

| Product | Monthly price | Unit | Notes | Source |
|---|---|---|---|---|
| Square Appointments | Free (1 staff); Plus $29 to $49; Premium $69 to $149 | Per location | Sources disagree, and Square's page did not show prices | schedulingkit.com (Apr 2026) and others (third party) |
| Acuity Scheduling | Starter $16 ($20 monthly); Standard $27 ($34); Premium $49 ($61) | By calendars (1, 6 or 36) | 20% off yearly; 7-day trial; waitlists and texts from Standard up | acuityscheduling.com/pricing (vendor) |
| Bookeo Classes | $14.95 to $119.95 | By teachers and bookings a month | No commission; texts cost 9c each | bookeo.com/classes/pricing (vendor) |
| Punchpass | Grow $59; Flow $99; Pro $149 | Per account | 12% off yearly; no transaction fee of its own | punchpass.com/pricing (vendor) |
| Mindbody | Not published | Per location | Mindbody's own blog titles mention "$79" and "from $99" | mindbodyonline.com blog; third-party guides |
| Eventbrite (common for quilt classes) | No monthly fee | Per ticket | 3.7% + $1.79 a ticket plus 2.9% processing: about $3.44 on a $25 class | eventcloud.io and simpletix.com (third party, 2026) |

### 1.5 Email and text marketing

| Product | Monthly price | Unit | Notes | Source |
|---|---|---|---|---|
| Mailchimp | Free up to 250 contacts; Essentials from $13; Standard from $20 (at 500 contacts) | By contacts | The price rises with the list; 14-day trial | mailchimp.com/pricing/marketing (vendor) |
| Klaviyo | Free up to 250 profiles. Email only: $20 at 500, $45 at 1,500. With texts: $35 and $60 | By profiles | The paid figures come from third-party summaries | klaviyo.com/pricing (vendor, free plan); emailtooltester.com (third party) |
| Square Marketing | Email $15 (500 contacts) to $55 (4,000); texts $10 plus a charge per text | By contacts | Square's page instead ties marketing to Square Plus, with 500 texts a month; the two versions disagree | Square's marketing pricing page (vendor) and search results |
| Constant Contact | Lite $12; Standard $35 (at 500 contacts) | By contacts | No free plan | sendx.io (third party, 2026) |
| Twilio texts (what a shop pays to use our Marketing) | About 1.2c to 1.3c a text ($0.0083 plus the carrier fee); a number is $1.15 a month | Per text | US 10DLC registration costs about $19.50 once and $1.50 a month (third party) | twilio.com/en-us/sms/pricing/us (vendor) |

### 1.6 What a shop costs us

| Item | Price | Source |
|---|---|---|
| Railway | Hobby $5 a month with $5 of usage included; Pro $20 a month with $20 included. Beyond that: about $10 per GB of memory a month, $20 per vCPU a month, $0.15 per GB stored a month, $0.05 per GB sent out | railway.com/pricing (vendor) |
| Stripe card charge | 2.9% + 30c | stripe.com/billing/pricing (vendor) |
| Stripe Billing | 0.7% of billing volume | same |
| Stripe Connect | No platform fee when Stripe prices the connected accounts. When the platform prices them: $2 per active account a month, plus 0.25% + 25c a payout | stripe.com/connect/pricing (vendor) |

**What the tables say.**
- A one-tech repair shop pays $39 to $99 a month elsewhere, and the cheap tiers cap tickets or users (RepairShopr
  Starter allows one user and 75 tickets).
- A shop with 3 to 5 people pays $80 to $150 per location.
- The sew-and-vac and quilt-shop systems that include classes and a website start near $99, and most hide their
  prices behind a demo.
- Booking runs $15 to $60 a month. Marketing runs $13 to $45 for a small list.

Against all of that, StitchBench at $25 is the cheapest complete option found, by a wide margin. That price covers
tickets, machines, factory specs, parts, the register, stock, the online shop, partner shops and every login.

A quilt shop's real alternative, though, costs close to $0: Square Free, a free Mailchimp list, and Eventbrite fees
paid by the student.

## 2. Today's prices (decided 26 Sep and 3 Oct 2026)

- **Base:** $25 a month or $250 a year per shop. The same for StitchBench, StitchShop and hosted.
- **Partnered retail shops:** a retail shop partnered with a repair shop in good standing pays nothing for the base.
- **Trial:** 30 days, no card needed.
- **Add-ons:** Scheduling $15, Marketing $10, Vac Shop $10, Small Appliance Repair $5, or all four for $30. Yearly is
  ten times monthly.
- **The Assistant:** $15 with 300 calls, when it ships.
- **Free:** the hub and the manual library.
- **Online shop:** no fee from us on orders.

## 3. Is $25 too low?

- **A one-bench tech.** No. $25 a month is a fifth of one median tune-up ($123), and it is below every comparable
  entry tier. These are the most cost-sensitive buyers and the core of the community. Their alternative is the paper
  Machine Log, which costs nothing. Keep $25 for them.
- **A multi-tech repair shop.** Yes, too low. With 3 to 5 people it pays $80 to $150 per location elsewhere
  (RepairDesk $79 to $149, RepairShopr $130 to $140). It also gets more from StitchBench than a solo tech does,
  because every tech uses the factory specs, test modes and partner network. To an owner used to those invoices,
  $25 looks like a hobby.
- **A quilt or sewing shop with a register and classes.** Mostly moot, because most come in free through their repair
  shop and pay only for add-ons. Scheduling is exactly what a class shop needs. A shop that licenses directly pays
  $25 + $15 = $40 for the register, stock, online shop and classes. Like Sew, PayGo and Rain start at $99 or more.
  $40 is low for a staffed shop and right for a one-person shop.
- **A vacuum dealer.** Somewhat low. Sew-and-vac systems hide their prices or start at $99, with work orders on a
  higher tier. A dealer with a counter and one or two techs pays $25 + $10 = $35 today.

In every trade, the price fits a one-person shop and is low for a shop with staff. So the line to draw is the shop's
size, not its trade. That keeps the owner's "one rule for all three products".

## 4. One price or tiers

**Recommended: two tiers, set by the number of logins.** The same rule applies to all three products and every kind
of install.

| Tier | Who | Monthly | Yearly |
|---|---|---|---|
| Solo | Up to 2 active logins (the tech, plus a helper at the counter) | $25 | $250 |
| Shop | Every login | $45 | $450 |

- **Everything else is the same on both tiers.** Both get the whole program, the hub, the manual library, off-site
  backup, gift cards, reports, the online shop, partner shops and new versions. No feature is held back to push an
  upgrade; only the login count differs.
- **Add-ons cost the same on either tier.** The Assistant stays separate, because its cost is per call.
- **Free while partnered is unchanged.** A partnered retail shop gets the Shop tier free, however many staff it has.
  The repair side pays its own tier. A shop that both repairs and sells pays as a repair shop, by its logins.
- **Why logins rather than features.** The program already marks logins active or not (`User.active`), and a shop
  owner understands a login count. More people means more tickets, so the count follows the value. Competitors use
  the same step (RepairShopr: 1 user against 10). Gating features instead, such as the register only on Shop, would
  split one codebase into flavors the owner then has to explain and support.
- **Why $45.** It is under Square Plus ($49), well under RepairShopr Starter ($60 to $70) and RepairDesk Essential
  ($79 to $99), and under half of Like Sew. It is a round step up from $25 that an owner with staff will not question.
- **Why not three tiers.** There are too few multi-location shops in this trade to price for, and each location is
  its own shop (section 7). Revisit if a dealer with three or more stores asks.
- **Why not stay at one $25 price.** One price is simpler, and the code is built for it. But it undersells the
  program to staffed shops and gives up a fifth to a quarter of the revenue at the same number of shops. For example,
  if 30 of 100 paying shops have staff, two tiers bring $3,100 a month against $2,500.
- **If the owner still prefers one price, keep it at $25.** A single higher price, such as $35, would charge the core
  solo techs for value that only staffed shops get.
- **What it takes to build:**
  - two more Stripe prices on the hub;
  - a login limit carried in the base key;
  - a clear message when a Solo shop adds a third login ("Solo includes 2 logins; Shop includes every login");
  - a new answer to "Is it per person?" on the site.

## 5. Founding shops

After the test month, the first **25 paying shops** get a founding price. They can be repair shops or retail shops
that license directly. Waived shops don't take a slot. The price holds **as long as the subscription runs without a
gap of more than 60 days**.

- **Price:** Solo $15 a month or $150 a year; Shop $30 a month or $300 a year. That is about 40% and a third off. It
  covers the base only; add-ons stay at the normal price, as with the waiver.
- **The one or two test-month shops:** free for the first 12 months, then the founding price.
- **What founding shops give back:**
  - two short calls, at one and three months, about what is missing or confusing;
  - bug reports through the program;
  - optionally, permission to be named on the site as a founding shop, with a quote if they are happy (never a
    condition of the price);
  - a word to the quilt shops they work with.
- **Why 25.** That is roughly how many shops one person can support closely in the first months. It is also enough
  for real feedback from repair shops, quilt shops and a vacuum dealer.
- **What it costs.** Little: 25 shops at $10 to $15 off is $250 to $375 a month.
- **Say plainly** that it is a price locked for the life of the subscription. It is not a promise of free add-ons or
  features.

## 6. Hosted versus Windows

**Recommended: the same price on the shared hosted instance, and a dedicated instance at cost.**

What hosting costs, estimated from Railway's rates (an estimate, not a measured bill):
- **The whole shared instance:** about $14 of resources a month, inside the Pro plan's included $20. The estimate
  assumes one Next.js service of about 0.5 GB, Postgres of about 0.5 GB, a tenth of a vCPU on average, 10 GB stored
  and 10 GB sent out.
- **Each added shop:** a few hundred MB to a few GB of stored records and photos (photos are kept in Postgres), plus
  a sliver of memory and CPU. That is **well under $1 a shop a month**.
- **Off-site backup:** under $0.10 a shop a month (later-round-1 design 1.1).

Charging hosted shops more would therefore not be "at cost"; it would be a markup on convenience. A Windows shop also
costs about as much in support (installs, PCs, printers) as a hosted shop costs to run.

"Hosted copies at cost" fits the **dedicated** case: a shop that wants its own Railway project.
- That project's bill is about $8 to $12 a month by the same arithmetic. The site's FAQ says $5 to $10.
- Best: the shop's own Railway account pays Railway directly, so nothing passes through the owner's books.
- If the owner runs it, bill the Railway amount with no markup, at least $10, on top of the normal subscription.

## 7. Per shop, per user or per location

**Per shop, where a shop is one location.**
- **No per-seat fees.** Small shops resent them, and they push staff to share one login, which defeats the audit log
  and "who worked this ticket". The site already promises every login.
- Logins only decide whether a shop is Solo or Shop.
- A business with two stores pays for two shops under one StitchHub account, as the site already says.
- No multi-store discount until someone asks; if one does, the owner can comp part of it by hand.

## 8. Yearly discount

**Keep yearly at ten times the monthly price (two months free, 17% off).**
- It sits within the market's range: Orderry 10%, Punchpass 12%, RepairShopr about 14%, Lightspeed up to 18%, Acuity
  and RepairDesk 20%.
- It also saves the owner card fees. Stripe takes about $1.20 of each $25 monthly charge (2.9% + 30c, plus 0.7% for
  Billing), or $14.40 over a year. One $250 yearly charge costs about $9.30.
- Show the yearly price first on the pricing page.

## 9. The online shop fee

**Recommended: no fee from us, now and after Stripe Connect lands.** Use the Connect mode in which Stripe bills the
connected shop for processing, which costs the platform nothing, and set no application fee.
- A 1% fee would raise the shop's online card cost to 3.9% + 30c, above Square Online's 2.9% + 30c on Plus.
- It would turn "no fee from us" from a selling point into a fine-print item.
- It would earn real money only from the few shops that sell a lot online.
- Online class bookings compare even better without a fee: Eventbrite takes about $3.44 of a $25 class, and StitchShop
  takes nothing.

Revisit only if Connect starts costing the owner a fee per account.

## 10. Raising prices later

- **New shops first.** A new price applies to new shops at once.
- **Existing shops keep their price for 12 months** after the change is announced, with **60 days' notice** by email
  and on Settings → Account. Yearly subscribers renew once at the old price inside that window.
- **Founding shops never move** while their subscription runs.
- **At most one increase a year,** with the reason given (new features, costs). In the owner's research, South
  Portland Sewing tells its customers to "plan for 15% annual increases", so shops are used to that kind of notice.
- **In Stripe, each price stays a separate Price object.** The hub must map several price ids (founding,
  grandfathered, current) to one plan, so `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` become lists.

## 11. The risks, plainly

**The risk of charging too little.**
- **Perceived value.** A shop used to $99 invoices may read $25 as a hobby that won't last. Staffed shops especially.
- **Support time.** At $25 a month, one hour of support at a modest $50 an hour costs two months of a shop's fee.
- **The waiver adds to it.** One paying tech can bring five partner quilt shops. Each has a register, classes and an
  online shop, which take the most support. As an illustration: 100 paying shops and 150 waived shops, at half an
  hour a month each, is 125 hours of support for about $3,100 a month plus add-ons. Guides, the hub's community
  answers and paid help for the heavy cases are what keep that manageable.
- **Raising later is harder than starting right.** Grandfathering delays any correction by a year.

**The risk of charging too much.**
- These are small, cost-sensitive shops whose alternatives are paper and Square Free. Above about $50 a month, a
  one-bench tech stays on paper.
- The tech community talks in Facebook groups. A price seen as greedy travels fast and hurts the free hub too.
- The free-while-partnered growth path depends on $25 being an easy yes for the repair side.

Two tiers handle both risks. $25 stays for the people the community is built around, and shops with staff pay a price
that is still the lowest found.

**Two smaller levers** reduce the support load without raising the monthly price:
- **Optional setup and import help, $99 once.** That covers an hour on a shared screen and an import from a
  spreadsheet or another system. Competitors charge $500 to $2,999 for setup (Rain and Amilia, third party). Free for
  founding shops.
- **An Assistant top-up of 300 more calls for $10.** 300 calls cost us about $3.60 at most (Assistant scope 2.1).

## 12. Recommended price list

| | Monthly | Yearly | Notes |
|---|---|---|---|
| StitchBench or StitchShop, Solo (up to 2 logins) | $25 | $250 | Windows, shared hosted or the shop's own server |
| StitchBench or StitchShop, Shop (every login) | $45 | $450 | The same |
| Founding shops (the first 25, for the life of the subscription) | Solo $15, Shop $30 | $150 / $300 | Test-month shops get 12 months free first |
| Partnered retail shop | $0 | $0 | Shop tier, while the partnership and the repair shop's standing hold |
| Scheduling | $15 | $150 | Unchanged |
| Marketing | $10 | $100 | Unchanged; the shop pays its own texts and mail (Twilio about 1.3c a text) |
| Vac Shop | $10 | $100 | Unchanged |
| Small Appliance Repair | $5 | $50 | Unchanged |
| All four add-ons | $30 | $300 | Unchanged |
| The Assistant (when it ships) | $15, with 300 calls | $150 | Top-up: 300 more calls for $10 |
| Dedicated hosted instance | At cost (about $10) | | On top of the subscription; best paid by the shop to Railway directly |
| Setup and import help | $99 once | | Optional; free for founding shops |
| Online shop orders | No fee from us | | Stripe's own fees only |
| StitchHub and the manual library | Free | | Unchanged |
| Trial | 30 days, no card | | Unchanged |

## 13. Decisions for the owner

1. **Keep $25 as the entry price?** Recommended: yes, as Solo, with up to 2 active logins.
2. **Add a second tier?** Recommended: Shop at $45 a month or $450 a year, with every login. The same rule for
   StitchBench, StitchShop, Windows and hosted. Alternative: stay at one $25 price (not a higher single price).
3. **A third tier?** Recommended: no. Each location is a shop. Revisit when a dealer with three or more stores asks.
4. **Which tier for partnered retail shops?** Recommended: Shop, free, as already decided. At six months, look at
   support hours and add-on take-up among waived shops before changing anything.
5. **Founding shops?** Recommended: 25 shops at Solo $15 or Shop $30 a month ($150 or $300 a year), for as long as
   the subscription runs without a gap of more than 60 days. Test-month shops get 12 months free first. Founding shops
   give two feedback calls and bug reports, and optionally a mention on the site.
6. **Hosted price?** Recommended: the same as Windows on the shared instance. A dedicated instance at cost (the
   shop's own Railway bill, about $10), on top of the subscription.
7. **Per shop, per user or per location?** Recommended: per shop, which means per location. Logins only choose the
   tier. No per-seat fees, and no multi-store discount yet.
8. **Yearly discount?** Recommended: keep it at ten times monthly, and show yearly first.
9. **Online shop fee?** Recommended: none, including under Stripe Connect (Stripe bills the shop; no application fee).
10. **Add-on prices?** Recommended: keep the 3 Oct prices, the same on both tiers. Add an Assistant top-up of 300 calls
    for $10.
11. **Paid setup help?** Recommended: an optional $99 for setup and import, free for founding shops.
12. **Price increases?** Recommended: new shops first. Existing shops keep their price for 12 months, with 60 days'
    notice. Founding shops stay locked. At most one increase a year. The hub maps several Stripe prices to one plan.
