# Reward cards: design (6 Oct 2026, first draft for the owner)

The owner's idea (3 Oct 2026, HANDOFF section 3 item 19, "later, after launch"): shops get reward cards they design;
the owner prints them on his own card printer and mails them (about $1.50 a card); batches go to the shop, or $3-4
each mailed direct to the customer to cover postage; Apple / Google Wallet passes are the free option. Document only,
nothing built. Reward points reuse the gift card and store credit ledger from `later-round-1-design.md` section 2,
so build `gift-cards` first.

## 1. The program for shops

What quilt shops do today: Keepsake Quilting pays 5 to 10 cents back per dollar plus $10 on the birthday
([Keepsake](https://www.keepsakequilting.com/pages/loyalty-program)); Missouri Star gives 2 points per $1
([Quilter's Cash](https://www.missouriquiltco.com/pages/quilters-cash)); a typical small shop punches a "Yard Card"
once per $10 spent and pays $10 credit when full, with a birthday gift
([My Favorite Quilt Shop](https://www.favoritequiltshop.com/my-favorite-quilt-shop.htm)); points and tiers at the
cutting counter are the common advice ([guide](https://rewardloyalty.co/use-cases/quilt-shop-loyalty-program)).

**Recommended shape (one engine, two looks):**
- Points per dollar: 1 point per $1 of eligible spend (after discounts, before tax). Settings: points per dollar
  (0.5 to 5), which lines count. Not counted by default: gift card sales, store credit, shipping, tax, class seats
  (a checkbox each).
- Reward: every 100 points the customer may take $5 (5 percent back) as store credit. The shop sets the step and the
  value. Redeeming turns points into a store credit entry (kind `credit`), spent through the tender already designed.
- Punch-card look: a shop that wants "10 punches, then $10" sets 1 point per $10, step 10, value $10. The printed card
  shows boxes instead of a number. Same data, so no second system.
- Birthday: optional bonus points (default 50) or a flat credit, given once a year when the customer's birthday month
  begins and they visit; needs `Customer.birthMonth` (month and day only, optional, asked with consent).
- Expiry: none by default. Option: points lapse after 18 months with no earning or redeeming, warned by the
  existing reminder mail. Store credit already issued never expires (gift-card rule, state laws).
- Link to a customer: a card is a number (Code 128 plus QR with the same number). First scan at the register asks
  "Who is this?" and links it to a customer or makes one. A card with no customer still keeps points. One customer
  may hold several cards; a card has one customer.
- At the register: scan (or type the number) before or after the items; the customer chip shows "Points 148, $5 ready".
  Earning is automatic on completing the sale; "Use $5" adds a credit tender line. The receipt prints "Earned 12,
  balance 148" and the next reward.
- Voids and returns reverse the points earned (never below zero; the shop sees the shortfall).

## 2. What StitchShop needs

**Data model sketch** (migration `reward_cards`; `MOVE_TABLES` after `Customer` and `GiftCard`):
- `RewardProgram (shopId unique, enabled, pointsPerDollar, stepPoints, stepValueCents, birthdayPoints, expireMonths?,
  excludeRules Json, cardWords)`.
- `RewardCard (id, shopId, number unique per shop, customerId? SetNull, status active | lost | closed, source printed |
  wallet | virtual, orderId?, pointsBalance, createdAt)`.
- `RewardEntry (id, shopId, cardId, at, points +/-, reason EARNED | REDEEMED | BIRTHDAY | ADJUST | EXPIRED | REVERSED,
  saleId?, giftCardEntryId?, note)`. Ledger sums to `pointsBalance`, like `GiftCardEntry`.
- `Sale.rewardCardId?` and `Sale.pointsEarned`.

**Register flow** (`src/lib/register-sale.ts`, `completeSaleAs`): the card is resolved with the same `shopId`
ownership check as the customer; points are computed from the sale's `lines` net amounts (`lineNet`, `saleTotals` in
`register-math.ts`, integer cents, round down) and written inside the same transaction as the sale, so the existing
`clientKey` retry does not double-earn. Redeeming is a `CREDIT` tender (from the gift-card package) created from the
card's points in the same transaction. `voidSaleAs` writes REVERSED entries. Tax, tenders and cash rounding are not
touched.

**Customer page**: card list, balance, history, "Lost card: close and move points to a new card", adjust (owner,
reason required). **Settings**: program, words on the receipt, exclusions. **Reports**: points outstanding and their
value as a liability, earned and redeemed by month (it feeds the same Gift cards report tab).

**Online shop**: a logged-in or emailed order that matches a customer by email earns points on payment; the order
page shows the balance and, once Wallet passes exist, "Add to Wallet". No online redeeming at first (a card PIN against
guessing comes first, same as gift cards).

**The hub's role**: the shop designs, orders and pays through the hub (installs reach it already); the hub holds the
print queue, the Stripe payment, order status and the Wallet pass issuing (one Apple and one Google account for all
shops). Points and customers stay in the shop's own StitchShop; the hub never sees them. Only card numbers (ranges)
cross over, so a printed card can be matched when scanned.

**Number ranges**: the owner's hub issues each order a block of unique numbers with a check digit
(prefix + shop code + serial), so a card never collides between shops and a scan can be tied to the right company.
A card from another shop answers "Not this shop's card".

## 3. The printed-card service (the owner's business)

**Flow**: shop opens Reward cards in StitchShop, then picks a template (6 to 8 made with the shop's colors and logo,
step list shown, punch or points look) or uploads art (PNG or PDF at 1012 x 638 px or 300 dpi CR80, 3.375 x 2.125 in,
with a template showing the safe area and where the barcode goes). The hub checks size, shows a proof, and the owner
approves it before the first print. Reorders reuse the approved design with new numbers.

**Ordering and paying**: the hub makes a Stripe Checkout payment (Stripe's card fee is 2.9% + $0.30, standard US
pricing; verify at order time). Choices: batch of 50, 100, 250 mailed to the shop, or "mail to customers" (the shop
pastes names and addresses, or marks customers in StitchShop; one card each, $3-4). The shop chooses each customer;
nothing is mailed to anyone without the shop choosing them.

**The owner's print queue** (hub admin page): paid orders in a list with design, quantity, address, number range;
"Download print file" (one PNG per card with the barcode drawn at the right place, or one PDF); "Mark printed", "Mark
mailed" with a tracking number, which emails the shop. Packing slip and address labels printable.

**Costs per card** (public sources, Oct 2026):
- Printer ink and film: Magicard 300 about $0.35 a color card (YMCKO ribbon $92 to $110 for 300 prints; one side;
  [Magicard prices](https://www.alphacard.com/magicard-300-ymcko-300-print-ribbon),
  [ribbon vendors](https://www.idcardgroup.com/ribbons/magicardcolor)); Zebra ZC300 about $0.36
  ([comparison](https://electronics.alibaba.com/product/id-card-printer-machine-price)).
- Blank 30 mil CR80 PVC: about $0.08 each (500 for $40.50; kit with ribbon and 500 cards $55.95,
  [kit](https://www.idwholesaler.com/KIT-MA300YMCKO-PLA.html)).
- So about **$0.45 a card**, plus a $0.10 sleeve or envelope and the owner's time (about 1 minute a card).
- Postage: a 1 oz letter is $0.82 stamp, $0.78 metered, since 12 Jul 2026
  ([Stamps.com](https://www.stamps.com/article/2026-usps-rate-and-service-changes/),
  [rates](https://postalguidance.com/usps-first-class-mail-rates/)). A PVC card is rigid; USPS may add a
  non-machinable surcharge on a letter that is stiff, so budget up to $1.30 and test the envelope at a post office.
  A large envelope (flat) is $1.69, so avoid it.

**Margin**:
- Batch at $1.50: 100 cards cost $45 materials plus $5 sleeves, Stripe on $150 about $4.65, small box postage about
  $8 (estimate, depends on weight and zone): margin about $0.90 a card ($90 per 100), before the owner's time.
- Direct mail at $3.50: materials $0.55, Stripe on one card $0.40, stamp $0.82 up to $1.30: margin about $1.25 to $1.75.
  At $3 it falls to $0.75 to $1.25. Orders mailed direct should be per-order Stripe charges batched in one payment
  (the shop pays for all its customers' cards once) to avoid the fixed 30 cents each.
- Suggested minimum order 50 cards; a one-time $25 design setup if artwork is uploaded and needs fixing.

**Printer recommendation**: Magicard 300 at about $1,350 ([EasyBadges](https://easybadges.com/product/magicard-300-id-card-printer/)),
the cheapest of three and 300 dpi, 23 seconds a card; the Zebra ZC300 is $1,519 and 26 seconds
([EasyBadges](https://easybadges.com/product/zebra-zc300-series-id-badge-printer-system/)); the Evolis Primacy 2 is
$2,042 to $2,135 ([EasyBadges](https://easybadges.com/product/evolis-primacy-2-id-card-printer/)) and is the office
workhorse. For 100 to 300 cards a week the Magicard 300 pays for itself in about 1,500 cards at the batch margin.
If the RV printer is already a different model, use it; the print file is the same (CR80, 300 dpi). One-sided print
is cheapest; dual-sided halves the ribbon yield.

## 4. The free Wallet option

- **Apple Wallet**: a signed `.pkpass` (store card type) from a Pass Type ID certificate, which needs an Apple
  Developer account at $99/yr ([Apple store card docs](https://developer.apple.com/documentation/walletpasses/creating-a-store-card-pass),
  [why the account](https://help.passkit.com/en/articles/2010098-why-do-i-need-an-apple-developer-account)). One
  owner account serves every shop; each pass names its shop and shows the barcode. Balance updating needs a small web
  service on the hub (register device, push via Apple's notification service); first version issues a static pass
  with the number and the shop's words, updated later.
- **Google Wallet**: a loyalty class per shop and a loyalty object per card, issued by a link signed (JWT) with a
  Google Cloud service account key from a Google Wallet business console issuer account, which is free
  ([overview](https://developers.google.com/wallet/retail/loyalty-cards/overview/add-to-google-wallet-flow),
  [classes and objects](https://developers.google.com/wallet/retail/loyalty-cards/overview/how-classes-objects-work)).
  Needs the owner to request production access once. Balance updates are plain API calls.
- **Cost to the owner**: $99/yr Apple, $0 Google, plus the hub's few hours of hosting. The shop pays nothing; the
  customer gets a link by email, text or a QR on the receipt that opens "Add to Wallet". A Wallet pass has no
  postage, so it is the cheap default and the printed card is the keepsake.
- The pass barcode is the same number, so the register scan path is identical for paper, plastic and phone.

## 5. Effort (days, one developer)

| Package | Days |
|---|---|
| `rewards-core`: models, ledger, earn, redeem as credit, voids, number format, `MOVE_TABLES`, check script | 4 |
| `rewards-register`: scan, customer chip, receipt line, customer page, Settings, report tab, spec | 3 |
| `rewards-online`: earn on web orders by email, order page balance | 1 |
| `card-orders` (hub): templates, upload checker, proof, Stripe checkout, address list, numbers | 5 |
| `card-queue` (hub): print queue, print file render, mark printed and mailed, mail to shop, labels | 3 |
| `wallet-google`: class and object, issuing link, balance update | 2 |
| `wallet-apple`: signing, pass, web service and push updates | 3 |
| Birthday and expiry jobs | 1 |
| Docs, tests of the whole path, owner print trial | 2 |
| **Total** | **24** (without Apple: 21; first sellable slice, core + register + Google: 9) |

## 6. Risks

- Postage on a rigid card may exceed a plain stamp; mailing cost decides the $3-4 price. Test before quoting.
- Owner time per card makes direct mail unprofitable above a few hundred a week; cap or raise the price.
- Points are a liability and a customer-facing promise: shop owners can change the rules; changes apply to new
  earning only, and the receipt words must not promise more than the program does.
- Privacy: customer names and addresses go to the hub for mailing; keep them only until mailed (delete after 30 days),
  say so on the order screen, and never read the customer's data otherwise (sharing rule: chosen per item).
- Texting passes needs the existing SMS consent (TCPA) rules; mail and the receipt QR do not.
- Counterfeit or copied cards: a number alone is guessable; keep it long with a check digit and require the shop's
  scan, with the card closed on report. No redeeming without the register.
- Printer downtime, ribbon supply, lost mail; refund or reprint rules in the terms (billing terms package).
- Apple Developer account lapse breaks pass updates; calendar the renewal. Google or Apple policy changes.
- Several companies per install and moves: cards belong to a shop; a move must carry them (`MOVE_TABLES`).

## 7. Questions for the owner (recommended answers first)

1. Program shape? **Points, 1 per dollar, $5 per 100 points as store credit; punch-card look is the same engine.**
2. Birthday reward? **Yes, optional, 50 points, off until the shop turns it on.**
3. Expiry? **None by default; optional 18 months inactive for points only, never for credit already issued.**
4. Printer? **Magicard 300 (about $1,350) if you have no card printer yet; use the one in the RV if it is CR80 at 300 dpi.**
5. Prices? **$1.50 a card in batches of 50 or more; $3.50 mailed direct (more if a stiff-card surcharge applies).**
6. Who builds the artwork? **Templates plus upload with a proof you approve; $25 setup only when you have to fix art.**
7. Wallet first or printed first? **Build core and register, then Google Wallet (free), then printed orders, then Apple ($99/yr) once a shop asks.**
8. Hub holds addresses? **Yes, only until mailed, deleted after 30 days.**
9. Can a shop use rewards without buying cards? **Yes: rewards on a phone number or email lookup, no card required.**
10. Do reward cards double as gift cards? **No, separate numbers; gift cards stay money, rewards stay points.**
